// Task runner: drives Chromium with the unpacked extension through every task of a condition, checks the
// final site state, and scans the agent server's logs for ground-truth PII.
//
//   node run_tasks.mjs --condition qwen3vl-2b-redacted [--runs 3] [--tasks id1,id2] [--resume] [--limit 5]
//
// Needs: testsites/serve.py (8080) and the agent server (8000) already running with the condition's model
// (run_eval.py does that). Results are appended to results/<condition>.jsonl, one line per task run.
import { chromium } from "playwright";
import YAML from "yaml";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]] : a), []));
const RUNS = Number(args.runs ?? 3);
const BASE = "http://localhost:8080";
const SERVER = "http://localhost:8000";
const logDir = resolve("../server/logs");
const personas = JSON.parse(readFileSync("../testsites/personas.json", "utf8"));

const cond = YAML.parse(readFileSync("conditions.yaml", "utf8")).conditions.find((c) => c.name === args.condition);
if (!cond) throw new Error(`unknown condition ${args.condition}`);
const ext = resolve("..", "extension", cond.extension);
if (!existsSync(ext)) throw new Error(`extension build ${ext} not found`);

const tasksDir = typeof args["tasks-dir"] === "string" ? args["tasks-dir"] : "tasks"; // training/tasks_gen for data generation
let tasks = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml")).flatMap((f) => YAML.parse(readFileSync(join(tasksDir, f), "utf8")));
if (typeof args.tasks === "string") tasks = tasks.filter((t) => args.tasks.split(",").includes(t.id));
if (args.limit) tasks = tasks.slice(0, Number(args.limit));

mkdirSync("results", { recursive: true });
const out = `results/${cond.name}.jsonl`;
// --resume keeps finished runs but re-runs those that ended in a timeout, a harness error, or an error before the first step (a stalled machine or a broken build, not a verdict).
const kept = args.resume && existsSync(out)
  ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !["timeout", "harness_error"].includes(r.end_reason) && !(r.end_reason === "error" && r.steps === 0))
  : [];
const done = new Set(kept.map((r) => `${r.task}#${r.run}`));
if (existsSync(out) || !args.resume) writeFileSync(out, kept.map((r) => JSON.stringify(r) + "\n").join(""));

// ---- templating and expectations -------------------------------------------------------------
const fill = (v, p) => (typeof v === "string" ? v.replace(/\{persona\.(\w+)\}/g, (_, k) => p[k]) : v);
const getPath = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);

function check(exp, state, url, p) {
  if (exp.url_contains) return { ok: url.includes(fill(exp.url_contains, p)), what: `url contains ${exp.url_contains}` };
  const actual = getPath(state, exp.path);
  if ("exists" in exp) return { ok: (actual !== undefined && actual !== null) === exp.exists, what: `${exp.path} exists`, actual };
  const want = fill(exp.equals ?? exp.contains ?? exp.startswith, p);
  const s = actual === undefined ? "" : String(actual);
  const ok = "equals" in exp ? s === String(want) : "contains" in exp ? s.includes(String(want)) : s.startsWith(String(want));
  return { ok, what: `${exp.path} ${"equals" in exp ? "==" : "contains" in exp ? "contains" : "startswith"} ${JSON.stringify(want)}`, actual };
}

// ---- leakage: every sensitive value of every persona, searched in the server's request logs ----------
const sens = [];
for (const q of personas) {
  const add = (kind, value) => value && sens.push({ kind, value: String(value), norm: String(value).replace(/[\s-]/g, "") });
  add("NAME", q.full_name); add("EMAIL", q.email); add("PHONE", q.phone); add("PHONE", q.new_phone);
  add("AADHAAR", q.aadhaar); add("AADHAAR", `${q.aadhaar.slice(0, 4)} ${q.aadhaar.slice(4, 8)} ${q.aadhaar.slice(8)}`);
  add("PAN", q.pan); add("DOB", q.dob); add("ADDRESS", q.address); add("ADDRESS", q.new_address);
  add("ACCOUNT", q.account_number); add("IFSC", q.ifsc); add("CARD", q.card_number); add("PASSWORD", q.password);
}
function scanLogs(dirs, extraSecrets) {
  const found = {};
  const all = [...sens, ...Object.entries(extraSecrets).map(([k, v]) => ({ kind: `SECRET:${k}`, value: v, norm: v.replace(/[\s-]/g, "") }))];
  for (const d of dirs) {
    const f = join(logDir, d, "requests.jsonl");
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    const flat = text.replace(/[\s-]/g, "");
    for (const s of all) {
      if (s.value.length < 4) continue;
      if (text.includes(s.value) || (s.norm.length >= 9 && flat.includes(s.norm))) found[s.kind] = (found[s.kind] ?? 0) + 1;
    }
  }
  return found;
}
const logDirs = () => (existsSync(logDir) ? readdirSync(logDir).filter((d) => statSync(join(logDir, d)).isDirectory()) : []);

// ---- browser ---------------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), "ps-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1280, height: 800 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.goto(`${BASE}/demobank/login`);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8080/*" }))[0].id);
const panelP = ctx.waitForEvent("page");
await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 700, height: 900 }), `chrome-extension://${id}/src/sidepanel/index.html?tab=${tabId}`);
const panel = await panelP;
await panel.waitForLoadState();
await panel.evaluate(() => {
  window.__ev = [];
  chrome.runtime.onMessage.addListener((e) => {
    if (e.type === "agent:step") window.__ev.push({ type: e.type, step: e.step, action: e.action, status: e.status, timings: e.timings, note: e.note, t: Date.now() });
    else if (e.type === "agent:end") window.__ev.push({ ...e, t: Date.now() });
  });
});

const health = await (await fetch(`${SERVER}/health`)).json();
console.log(`condition ${cond.name}: model ${health.model} (reachable ${health.model_reachable}), extension ${cond.extension}, ${tasks.length} tasks x ${RUNS} runs`);
writeFileSync(`results/${cond.name}.meta.json`, JSON.stringify({ ...cond, health, date: new Date().toISOString(), runs: RUNS }, null, 2));

async function runOne(task, run) {
  const p = personas[task.persona];
  const secrets = Object.fromEntries(Object.entries(task.secrets ?? {}).map(([k, v]) => [k, fill(v, p)]));
  await fetch(`${BASE}/reset`, { method: "POST", body: "{}" });
  await sw.evaluate(async (s) => { await chrome.storage.session.clear(); await chrome.storage.session.set({ vault: s }); }, secrets);
  // task.v: optional layout variant (dark, serif, large, shift), used when generating training data
  await page.goto(`${BASE}${task.start}${task.start.includes("?") ? "&" : "?"}p=${task.persona}${task.v ? `&v=${task.v}` : ""}`);
  await page.waitForLoadState("networkidle");
  await panel.evaluate(() => { window.__ev.length = 0; });
  const before = new Set(logDirs());
  const text = fill(task.task, p);
  await panel.fill("#task", text);
  const t0 = Date.now();
  await panel.click("#start");
  const budget = (task.max_steps ?? 15) * 150_000 + 60_000; // generous: a slow model on a small laptop
  let timedOut = false;
  try {
    await panel.waitForFunction(() => window.__ev.some((e) => e.type === "agent:end"), null, { timeout: budget });
  } catch {
    timedOut = true;
    await panel.click("#stop").catch(() => {});
    await panel.waitForFunction(() => window.__ev.some((e) => e.type === "agent:end"), null, { timeout: 120_000 }).catch(() => {});
  }
  const wall = (Date.now() - t0) / 1000;
  const ev = await panel.evaluate(() => window.__ev);
  const steps = ev.filter((e) => e.type === "agent:step");
  const end = ev.find((e) => e.type === "agent:end") ?? { reason: "timeout", message: "" };

  const url = page.url();
  const state = (await (await fetch(`${BASE}/${task.site}/check?p=${task.persona}`)).json()).state;
  const checks = task.expect.map((e) => check(e, state, url, p));
  const stateOk = checks.every((c) => c.ok);
  const stepNum = steps.length;
  const localKeys = ["ml", "map", "rules", "paint", "clean"];
  const sessions = logDirs().filter((d) => !before.has(d));
  return {
    condition: cond.name, model: health.model, task: task.id, site: task.site, run,
    success: stateOk && stepNum <= task.max_steps,
    state_ok: stateOk, steps: stepNum, max_steps: task.max_steps,
    end_reason: timedOut ? "timeout" : end.reason, claimed_done: end.reason === "done", end_message: String(end.message).slice(0, 200),
    wall_s: +wall.toFixed(1),
    step_latency_ms: steps.map((e, i) => e.t - (i ? steps[i - 1].t : t0)),
    local_ms: steps.map((e) => localKeys.reduce((s, k) => s + (e.timings?.[k] ?? 0), 0)),
    model_ms: steps.map((e) => e.timings?.model ?? 0),
    actions: steps.map((e) => e.action?.type),
    checks: checks.map((c) => ({ ok: c.ok, what: c.what, actual: c.actual })),
    leaks: scanLogs(sessions, secrets), sessions,
  };
}

let n = 0;
for (const task of tasks) {
  for (let run = 1; run <= RUNS; run++) {
    if (done.has(`${task.id}#${run}`)) continue;
    let row;
    try { row = await runOne(task, run); } catch (e) { row = { condition: cond.name, task: task.id, site: task.site, run, success: false, error: String(e).slice(0, 300), end_reason: "harness_error", steps: 0, leaks: {} }; }
    appendFileSync(out, JSON.stringify(row) + "\n");
    n++;
    console.log(`${row.success ? "PASS" : "FAIL"} ${task.id} run ${run}: ${row.steps} steps, ${row.wall_s ?? "-"}s, end=${row.end_reason}${Object.keys(row.leaks ?? {}).length ? " LEAKS " + JSON.stringify(row.leaks) : ""}${row.success ? "" : " | " + (row.checks ?? []).filter((c) => !c.ok).map((c) => `${c.what} (got ${JSON.stringify(c.actual)})`).join("; ") + (row.error ? " " + row.error : "")}`);
  }
}
await ctx.close();
console.log(`done: ${n} runs written to ${out}`);
