import { leakGuard } from "../redaction/leakGuard";
import { sanitiseText } from "../redaction/regions";
import { INTERRUPTED, isFresh, isStuck } from "../shared/guards";
import type { Action, AgentEvent, ExecuteResult, HistoryItem, StepRequest, StepResponse } from "../shared/protocol";
import { DEFAULTS, getSettings } from "../shared/settings";
import type { Settings } from "../shared/settings";
import { loadSecrets, substitute } from "../vault";
import { ensureContent } from "./capture";
import { observe } from "./observe";
import { getMap, resetMap, saveMap } from "./session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// True only in the evaluation build (npm run build:clean): the unsafe baseline sends the task and screen unprotected.
// The constant is false in the shipped build, so the guarded branches below are the only ones that exist there.
const EVAL_CLEAN = import.meta.env.VITE_EVAL_CLEAN === "1";

/**
 * Everything needed to continue a task after the MV3 service worker was killed. Kept in chrome.storage.session
 * (memory only, cleared when the browser closes). Actions are stored with placeholders, never with real values.
 */
interface LoopState {
  sessionId: string;
  task: string;
  tabId: number;
  step: number; // the next step to run
  history: HistoryItem[];
  pending: { step: number; action: Action } | null; // an action that was sent to the page but whose result is not recorded
  status: "running" | "waiting_user";
  question?: string;
  updatedAt: number;
}
const LOOP_KEY = "agentLoop";
// While a task runs, a Chrome alarm wakes a killed worker so resumeInterrupted() can continue the task (alarms survive the worker).
export const WATCHDOG = "privasight-watchdog";
const WAITING_MAX_AGE_MS = 30 * 60_000;

let current: { stop: boolean } | null = null;

const emit = (e: AgentEvent) => chrome.runtime.sendMessage(e).catch(() => {});

export function stopTask(): void {
  if (current) current.stop = true;
  else void clearState(); // also abandons a task that is waiting for the user's answer
}

export const isRunning = () => current !== null;

async function loadState(): Promise<LoopState | null> {
  return ((await chrome.storage.session.get(LOOP_KEY))[LOOP_KEY] as LoopState | undefined) ?? null;
}
async function saveState(s: LoopState): Promise<void> {
  s.updatedAt = Date.now();
  await chrome.storage.session.set({ [LOOP_KEY]: s });
}
async function clearState(): Promise<void> {
  await chrome.storage.session.remove(LOOP_KEY);
  await resetMap();
}

export async function agentStatus(): Promise<{ running: boolean; waiting?: string }> {
  const s = await loadState();
  return { running: current !== null, waiting: current === null && s?.status === "waiting_user" ? s.question : undefined };
}

/** Plain-language reasons instead of "TypeError: Failed to fetch". */
function describe(e: unknown, settings: Settings): string {
  const msg = String(e instanceof Error ? e.message : e);
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") return `The model did not answer within ${Math.round(settings.stepTimeoutMs / 1000)} s. Try again, or raise the step timeout in Settings.`;
  if (name === "TypeError" && /fetch/i.test(msg)) return `Cannot reach the agent server at ${settings.serverUrl}. Is it running?`;
  if (/No tab with id|tab was closed/i.test(msg)) return "The tab was closed, so the task stopped.";
  return msg;
}

async function callServer(req: StepRequest, settings: Settings): Promise<StepResponse> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) { // 1 try + 2 retries
    try {
      const r = await fetch(`${settings.serverUrl}/v1/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(settings.stepTimeoutMs),
      });
      if (!r.ok) {
        const body = (await r.text().catch(() => "")).slice(0, 200);
        throw new Error(`The agent server answered ${r.status}${body ? `: ${body}` : ""}`);
      }
      return (await r.json()) as StepResponse;
    } catch (e) {
      last = e;
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) break; // a slow model will not get faster by retrying
      await sleep(500);
    }
  }
  throw last;
}

async function sendExecute(tabId: number, action: Action): Promise<ExecuteResult> {
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      return (await chrome.tabs.sendMessage(tabId, { type: "execute", action })) as ExecuteResult;
    } catch (e) {
      last = e;
      if (i === 2) await ensureContent(tabId).catch(() => {});
      await sleep(300);
    }
  }
  return { ok: false, result: String(last) };
}

/** Wait for any navigation caused by the action to finish. */
async function settle(tabId: number): Promise<void> {
  await sleep(400);
  for (let i = 0; i < 20; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") break;
    await sleep(250);
  }
  await sleep(300);
}

type EndReason = Extract<AgentEvent, { type: "agent:end" }>["reason"];

/** The loop. `st.step` is the next step to run; the state is saved after every step so a killed worker can resume. */
async function loop(st: LoopState): Promise<void> {
  const ctl = (current = { stop: false });
  void chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000); // keeps the MV3 worker awake
  let paused = false; // ask_user keeps the state (and the placeholder map) so the user can answer
  const end = (reason: EndReason, message: string) => emit({ type: "agent:end", reason, message });
  const pause = async (question: string) => {
    paused = true;
    st.status = "waiting_user";
    st.question = question;
    await saveState(st);
    return end("ask_user", question);
  };
  let settings: Settings | undefined;
  try {
    settings = await getSettings();
    const tabId = st.tabId;
    await ensureContent(tabId).catch(() => {});
    while (st.step <= settings.maxSteps) {
      const step = st.step;
      if (ctl.stop) return end("stopped", "Stopped by user");
      const obs = await observe(tabId);
      if (!obs.payload) return end("error", `Leak guard blocked the send (secrets found: ${obs.guard.hits.join(", ")})`);
      const secrets = await loadSecrets();
      const map = await getMap();
      const req: StepRequest = {
        ...obs.payload,
        session_id: st.sessionId,
        step,
        // The task text may itself contain a secret or PII. (Evaluation-only clean build: sent as typed.)
        task: EVAL_CLEAN ? st.task : map.sanitise(sanitiseText(st.task, secrets)),
        screenshot: obs.image,
        history: st.history,
      };
      await saveMap();
      const { screenshot: _img, ...withoutImage } = req;
      const outgoingJson = JSON.stringify(withoutImage);
      const hits = EVAL_CLEAN ? [] : leakGuard(outgoingJson, secrets, map.originals()); // the unsafe baseline has no guard
      if (hits.length) return end("error", `Leak guard blocked the send (secrets found: ${hits.join(", ")})`);

      const t0 = performance.now();
      const res = await callServer(req, settings);
      const timings = { ...obs.timingMs, server: Math.round(performance.now() - t0), model: res.latency_ms };
      void emit({ type: "agent:step", step, image: obs.image, action: res.action, status: res.status, timings, payloadJson: outgoingJson, note: res.message || undefined });

      const action = res.action;
      if (action.type === "done") return end("done", action.summary);
      if (action.type === "ask_user") {
        st.history.push({ step, action, result: "waiting for the user" });
        st.step = step + 1;
        return pause(action.question);
      }
      if (res.status === "error") return end("error", res.message);

      let result: ExecuteResult;
      if (action.type === "wait") {
        await sleep(Math.min(action.ms ?? 1000, 3000));
        result = { ok: true, result: "ok" };
      } else {
        let toRun: Action = action;
        if (action.type === "type") {
          // Placeholders are substituted here, at execution time only; the server never sees real values.
          const sub = substitute(action.text, secrets);
          if (sub.missing.length) return end("ask_user", `I need a value for ${sub.missing.join(", ")} but it is not in the vault.`);
          // [PHONE_1]-style placeholders are restored from the session map, also only here.
          const back = map.restore(sub.text);
          if (back.missing.length) return end("ask_user", `I do not know the value of ${back.missing.join(", ")}.`);
          toRun = { ...action, text: back.text };
        }
        // Recorded before the page is touched: if the worker dies now, the resumed loop knows this action may or may not have happened.
        st.pending = { step, action };
        await saveState(st);
        result = await sendExecute(tabId, toRun);
        await settle(tabId);
      }
      st.history.push({ step, action, result: result.ok ? "ok" : `failed: ${result.result}` }); // history keeps placeholders, not values
      st.pending = null;
      st.step = step + 1; // advanced before saving: a resume must not repeat a step that already ran
      await saveState(st);
      if (isStuck(st.history)) return pause(`I repeated the same action 3 times without progress (${JSON.stringify(action)}). What should I do instead?`);
    }
    return end("step_limit", `Stopped after ${settings.maxSteps} steps`);
  } catch (e) {
    return end("error", describe(e, settings ?? DEFAULTS));
  } finally {
    clearInterval(keepAlive);
    void chrome.alarms.clear(WATCHDOG);
    current = null;
    if (!paused) await clearState(); // the saved state and the placeholder map are cleared when the task ends
  }
}

export async function runTask(task: string, tabId?: number): Promise<void> {
  if (current) throw new Error("a task is already running");
  current = { stop: false }; // claimed now so a second start cannot slip in while the tab is resolved
  try {
    if (tabId === undefined) tabId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  } catch {
    tabId = undefined;
  }
  if (tabId === undefined) {
    current = null;
    return void emit({ type: "agent:end", reason: "error", message: "No active tab" });
  }
  await clearState();
  const st: LoopState = { sessionId: `s${Date.now().toString(36)}`, task, tabId, step: 1, history: [], pending: null, status: "running", updatedAt: Date.now() };
  await saveState(st);
  return loop(st);
}

/** The user's answer to an ask_user question. It is sanitised like the task text before it can reach the model. */
export async function replyToAgent(answer: string): Promise<{ ok: boolean; error?: string }> {
  if (current) return { ok: false, error: "a task is already running" };
  const st = await loadState();
  if (!st || st.status !== "waiting_user" || !isFresh(st.updatedAt, Date.now(), WAITING_MAX_AGE_MS)) {
    await clearState();
    return { ok: false, error: "no question is waiting for an answer" };
  }
  const secrets = await loadSecrets();
  const clean = EVAL_CLEAN ? answer : (await getMap()).sanitise(sanitiseText(answer, secrets));
  await saveMap();
  const last = st.history[st.history.length - 1];
  if (last?.action.type === "ask_user") last.result = `user replied: ${clean}`;
  else st.history.push({ step: st.step - 1, action: { type: "ask_user", question: st.question ?? "" }, result: `user replied: ${clean}` });
  st.status = "running";
  st.question = undefined;
  await saveState(st);
  void loop(st);
  return { ok: true };
}

/**
 * Called when the worker starts. If a task was running when the previous worker died, continue it from the last saved step.
 * An action that was in flight is marked as interrupted so the model checks the screen instead of repeating it.
 */
export async function resumeInterrupted(): Promise<void> {
  if (current) return;
  const st = await loadState();
  if (!st) return;
  if (st.status === "waiting_user") {
    if (!isFresh(st.updatedAt, Date.now(), WAITING_MAX_AGE_MS)) await clearState();
    return;
  }
  if (!isFresh(st.updatedAt, Date.now())) return void (await clearState());
  if (st.pending) {
    st.history.push({ step: st.pending.step, action: st.pending.action, result: INTERRUPTED });
    st.step = st.pending.step + 1;
    st.pending = null;
  }
  void emit({ type: "agent:resumed", step: st.step });
  await loop(st);
}
