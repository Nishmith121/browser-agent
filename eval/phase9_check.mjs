// Phase 9 checks, in a real Chromium with the built extension. A scripted agent server (below) stands in for the model, so every
// scenario is deterministic and the settings path (Settings > Server URL) is exercised for real.
//
//   node phase9_check.mjs            needs testsites/serve.py on 8080 and `npm run build` in ../extension
//
// Scenarios: settings validation, server down, origin guard (+ adding an origin), blocked navigation, ask_user round trip with a
// PII answer, stuck-loop detection, step limit from settings, resume after the service worker is killed (alarm watchdog),
// resume with an action that was in flight.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ext = resolve("../extension/dist");
const MOCK_PORT = 8123;
const PHONE = "9876543210"; // synthetic number the "user" types as an answer

// ---- scripted agent server ----------------------------------------------------------------------------------
let script = () => ({ type: "done", summary: "ok" });
let delayMs = 0;
let seen = [];
const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    if (req.method !== "POST" || !req.url.endsWith("/v1/step")) { res.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const { screenshot: _s, ...rest } = body;
    seen.push(rest);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const action = script(body, seen.length);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: action.type === "done" ? "done" : "continue", action, model: "scripted", latency_ms: 1, message: "" }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

// ---- harness --------------------------------------------------------------------------------------------------
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const END = /^(done|ask_user|error|stopped|step_limit):/;

async function launch() {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps9-")), {
    headless: false,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1280, height: 800 },
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  return { ctx, sw, id };
}

async function openPanel(env, tabId) {
  const p = env.ctx.waitForEvent("page");
  await env.sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 700, height: 1000 }), `chrome-extension://${env.id}/src/sidepanel/index.html?tab=${tabId}`);
  const panel = await p;
  await panel.waitForLoadState();
  return panel;
}

const tabIdOf = (env, pattern) => env.sw.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0].id, pattern);
const setSettings = (env, s) => env.sw.evaluate((v) => chrome.storage.local.set({ settings: v }), s);
const status = (panel) => panel.textContent("#status");
async function runToEnd(panel, task, timeout = 60_000) {
  await panel.fill("#task", task);
  await panel.click("#start");
  await panel.waitForFunction((re) => new RegExp(re).test(document.getElementById("status").textContent), END.source, { timeout });
  return status(panel);
}
const base = { serverUrl: `http://127.0.0.1:${MOCK_PORT}`, maxSteps: 15, stepTimeoutMs: 20_000, extraOrigins: [] };

async function scenario(name, fn) {
  seen = []; delayMs = 0;
  script = () => ({ type: "done", summary: "ok" });
  const env = await launch();
  try {
    await fn(env);
  } catch (e) {
    check(`${name}: scenario crashed`, false, String(e).slice(0, 200));
  } finally {
    await env.ctx.close();
  }
}

// ---- 1. settings validation (through the panel) ----------------------------------------------------------------
await scenario("settings", async (env) => {
  const page = await env.ctx.newPage();
  await page.goto("http://localhost:8080/demobank/login");
  const panel = await openPanel(env, await tabIdOf(env, "http://localhost:8080/*"));
  await panel.click("summary");
  await panel.fill("#set-origins", "*\nhttps://*.evil.com\nhttps://ok.example.com/path");
  await panel.click("#save-settings");
  const msg = await panel.textContent("#settings-msg");
  check("settings: wildcard origins are rejected with a message", /wildcards/.test(msg) && (msg.match(/Not a valid origin/g) ?? []).length === 2, msg.slice(0, 120));
  const stored = await env.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
  check("settings: nothing is stored when validation fails", stored === undefined);
  await panel.fill("#set-origins", "https://ok.example.com/path");
  await panel.fill("#set-steps", "7");
  await panel.click("#save-settings");
  const ok = await env.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
  check("settings: valid values are stored and normalised", ok?.maxSteps === 7 && ok.extraOrigins.join() === "https://ok.example.com", JSON.stringify(ok));
});

// ---- 2. server down --------------------------------------------------------------------------------------------
await scenario("server down", async (env) => {
  await setSettings(env, { ...base, serverUrl: "http://127.0.0.1:9" });
  const page = await env.ctx.newPage();
  await page.goto("http://localhost:8080/demobank/login");
  const panel = await openPanel(env, await tabIdOf(env, "http://localhost:8080/*"));
  const s = await runToEnd(panel, "anything");
  check("server down: a plain message, not a stack trace", s.startsWith("error:") && /Cannot reach the agent server at http:\/\/127\.0\.0\.1:9\. Is it running\?/.test(s), s);
});

// ---- 3. origin guard, then adding the origin ---------------------------------------------------------------------
await scenario("origin guard", async (env) => {
  await setSettings(env, base);
  const page = await env.ctx.newPage();
  await page.goto("http://127.0.0.1:8080/demobank/login");
  const panel = await openPanel(env, await tabIdOf(env, "http://127.0.0.1:8080/*"));
  let s = await runToEnd(panel, "scroll around");
  check("origin guard: a page outside the allowlist is refused", s.startsWith("error:") && /Origin not allowed: http:\/\/127\.0\.0\.1:8080/.test(s) && seen.length === 0, `${s.slice(0, 110)} / requests to the model: ${seen.length}`);

  script = (_b, n) => (n === 1 ? { type: "scroll", direction: "down" } : { type: "done", summary: "ok" });
  await setSettings(env, { ...base, extraOrigins: ["http://127.0.0.1:8080"] });
  s = await runToEnd(panel, "scroll around");
  const hist = seen[1]?.history ?? [];
  check("origin guard: after adding the origin in Settings the agent works there (content script injected)", s.startsWith("done:") && hist[0]?.result === "ok", `${s.slice(0, 60)} / first action result: ${hist[0]?.result}`);
  const reg = await env.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((c) => c.matches.join()));
  check("origin guard: the content script is registered for the added origin only", reg.length === 1 && reg[0] === "http://127.0.0.1:8080/*", reg.join(" | "));
  await setSettings(env, base);
  await new Promise((r) => setTimeout(r, 800));
  const reg2 = await env.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
  check("origin guard: removing the origin unregisters the script", reg2 === 0, `registered: ${reg2}`);
});

// ---- 4. navigation to another origin is blocked --------------------------------------------------------------------
await scenario("navigation", async (env) => {
  await setSettings(env, base);
  const page = await env.ctx.newPage();
  await page.goto("http://localhost:8080/demobank/login");
  const panel = await openPanel(env, await tabIdOf(env, "http://localhost:8080/*"));
  script = (_b, n) => (n === 1 ? { type: "navigate", url: "http://127.0.0.1:8080/demobank/login" } : { type: "done", summary: "ok" });
  await runToEnd(panel, "go somewhere");
  const r = seen[1]?.history?.[0]?.result ?? "";
  check("navigation: leaving the origin is blocked and reported to the model", /navigation blocked/.test(r) && page.url().startsWith("http://localhost:8080/"), `${r} / url ${page.url()}`);
});

// ---- 5. ask_user round trip with a PII answer -----------------------------------------------------------------------
await scenario("ask_user", async (env) => {
  await setSettings(env, base);
  const page = await env.ctx.newPage();
  await page.goto("http://localhost:8080/demobank/profile?p=0");
  const panel = await openPanel(env, await tabIdOf(env, "http://localhost:8080/*"));
  script = (b, n) => (n === 1 ? { type: "ask_user", question: "What is the new mobile number?" } : { type: "done", summary: "ok" });
  let s = await runToEnd(panel, "update my number");
  const visible = await panel.isVisible("#reply-box");
  check("ask_user: the task pauses with the question and a reply box", s.startsWith("ask_user:") && visible, s);
  await panel.fill("#reply", `My new number is ${PHONE}`);
  await panel.click("#send-reply");
  await panel.waitForFunction(() => /^done:/.test(document.getElementById("status").textContent), null, { timeout: 60_000 });
  const second = seen[1];
  const replied = second?.history?.find((h) => h.action.type === "ask_user")?.result ?? "";
  check("ask_user: the answer reaches the model as a placeholder, in the history", /user replied: .*\[PHONE_\d+\]/.test(replied), replied);
  check("ask_user: the typed number never leaves the device", !JSON.stringify(seen).includes(PHONE), `requests: ${seen.length}`);
  check("ask_user: the same session continues (step 2, history kept)", second?.step === 2 && second.session_id === seen[0].session_id, `step ${second?.step}`);
});

// ---- 6. stuck loop -------------------------------------------------------------------------------------------------
await scenario("stuck", async (env) => {
  await setSettings(env, base);
  const page = await env.ctx.newPage();
  await page.goto("http://localhost:8080/demobank/login");
  const panel = await openPanel(env, await tabIdOf(env, "http://localhost:8080/*"));
  script = (b) => ({ type: "click", element_id: b.elements[0].id });
  const s = await runToEnd(panel, "click forever");
  check("stuck: the same action three times asks the user instead of burning the step limit", s.startsWith("ask_user:") && /repeated the same action 3 times/.test(s) && seen.length === 3, `${s.slice(0, 90)} / steps ${seen.length}`);
});

// ---- 7. step limit comes from settings ------------------------------------------------------------------------------
await scenario("step limit", async (env) => {
  await setSettings(env, { ...base, maxSteps: 3 });
  const page = await env.ctx.newPage();
  await page.goto("http://localhost:8080/demobank/login");
  const panel = await openPanel(env, await tabIdOf(env, "http://localhost:8080/*"));
  let n = 0;
  script = () => ({ type: "scroll", direction: "down", amount: 100 + 10 * n++ });
  const s = await runToEnd(panel, "scroll");
  check("step limit: the configured limit (3) ends the task", s.startsWith("step_limit:") && /3 steps/.test(s) && seen.length === 3, `${s} / steps ${seen.length}`);
});

// ---- 8. the worker is killed in the middle of a task ----------------------------------------------------------------
async function killWorker(env, panel) {
  const cdp = await env.ctx.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  const versions = await new Promise((resolve) => {
    const found = new Map();
    cdp.on("ServiceWorker.workerVersionUpdated", (e) => {
      for (const v of e.versions) found.set(v.versionId, v);
    });
    setTimeout(() => resolve([...found.values()]), 1500);
  });
  const v = versions.find((x) => x.scriptURL.includes(env.id) && x.runningStatus === "running");
  if (!v) return { killed: false, why: `no running worker among ${versions.map((x) => x.scriptURL + ":" + x.runningStatus).join(",")}` };
  await cdp.send("ServiceWorker.stopWorker", { versionId: v.versionId });
  return { killed: true };
}

await scenario("resume", async (env) => {
  await setSettings(env, base);
  const page = await env.ctx.newPage();
  await page.goto("http://localhost:8080/demobank/login");
  const panel = await openPanel(env, await tabIdOf(env, "http://localhost:8080/*"));
  script = (b, n) => (b.step === 1 ? { type: "scroll", direction: "down", amount: 50 } : b.step === 2 ? { type: "scroll", direction: "down", amount: 60 } : { type: "done", summary: "finished after resume" });
  // The model is slow on step 2; the worker is killed while the request is in flight.
  let held = false;
  const origDelay = () => { if (!held && seen.length >= 1) { held = true; delayMs = 12_000; } };
  await panel.fill("#task", "scroll twice");
  await panel.click("#start");
  while (seen.length < 1) await new Promise((r) => setTimeout(r, 200));
  origDelay();
  while (seen.length < 2) await new Promise((r) => setTimeout(r, 200)); // step 2 request is now being held by the mock
  const k = await killWorker(env, panel);
  check("resume: the service worker was killed mid-task", k.killed, k.why ?? "");
  delayMs = 0;
  const t0 = Date.now();
  // Nothing wakes the worker except the alarm watchdog (every 30 s).
  await panel.waitForFunction(() => /resumed at step|^done:/.test(document.getElementById("status").textContent), null, { timeout: 75_000 }).catch(() => {});
  const st1 = await status(panel);
  await panel.waitForFunction(() => /^done:/.test(document.getElementById("status").textContent), null, { timeout: 60_000 }).catch(() => {});
  const st2 = await status(panel);
  const steps = seen.map((r) => r.step);
  check("resume: the alarm woke the worker and the task finished", /^done: finished after resume/.test(st2), `${st2} (woke after ${Math.round((Date.now() - t0) / 1000)} s, first status "${st1.slice(0, 50)}")`);
  check("resume: the interrupted step was asked again, not skipped, and the session id was kept", steps.filter((s) => s === 2).length >= 2 && new Set(seen.map((r) => r.session_id)).size === 1, `request steps ${steps.join(",")}`);
  check("resume: step 1 was not repeated", steps.filter((s) => s === 1).length === 1, `request steps ${steps.join(",")}`);
});

// ---- 9. resume with an action that was in flight --------------------------------------------------------------------
await scenario("in-flight", async (env) => {
  await setSettings(env, base);
  const page = await env.ctx.newPage();
  await page.goto("http://localhost:8080/demobank/login");
  const tabId = await tabIdOf(env, "http://localhost:8080/*");
  const panel = await openPanel(env, tabId);
  script = (b) => (b.history.some((h) => /^interrupted/.test(h.result)) ? { type: "done", summary: "checked the screen" } : { type: "scroll", direction: "down" });
  // Make it look like the worker died after sending a click to the page but before recording its result.
  await env.sw.evaluate(async (tab) => {
    await chrome.storage.session.set({
      agentLoop: {
        sessionId: "sresume", task: "log in", tabId: tab, step: 2, status: "running", updatedAt: Date.now(),
        history: [{ step: 1, action: { type: "scroll", direction: "down" }, result: "ok" }],
        pending: { step: 2, action: { type: "click", element_id: 3 } },
      },
    });
  }, tabId);
  const k = await killWorker(env, panel);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "agent:status" })); // wake the worker
  await panel.waitForFunction(() => /^done:/.test(document.getElementById("status").textContent), null, { timeout: 60_000 }).catch(() => {});
  const first = seen[0];
  const last = first?.history?.[first.history.length - 1];
  check("in-flight: the unknown action is marked interrupted and the next step number follows it", k.killed && /^interrupted/.test(last?.result ?? "") && first.step === 3, `killed ${k.killed}; step ${first?.step}; last "${(last?.result ?? "").slice(0, 40)}"`);
  check("in-flight: the original session continues", first?.session_id === "sresume", first?.session_id);
  check("in-flight: the task finishes after checking the screen", /^done: checked the screen/.test(await status(panel)), await status(panel));
});

mock.close();
const pass = results.filter(Boolean).length;
console.log(`\nphase 9: ${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
