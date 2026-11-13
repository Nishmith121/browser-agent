// Phase 10: records the demo video. Left half: the real page as the user sees it (synthetic persona data).
// Right half: PrivaSight's side panel with the Privacy view, i.e. exactly what left the device at that moment.
//
//   node record_demo.mjs [--out reports/demo] [--scenes capture,login,meeting]
//
// Needs testsites/serve.py (8080) and the agent server (AGENT_URL, default http://localhost:8000) with a model behind it.
// For a reproducible recording use the scripted expert (training/oracle_vlm.py); with a real VLM the agent may fail tasks,
// which is fine to show but makes the video longer. The model name is printed in the captions either way.
// Output: <out>/privasight_demo.mp4 (needs ffmpeg on PATH), plus the raw page/panel videos and the captions (.srt).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const OUT = resolve(args.out ?? "reports/demo");
const SCENES = (args.scenes ?? "capture,login,meeting").split(",");
const BASE = "http://localhost:8080";
const AGENT = process.env.AGENT_URL ?? "http://localhost:8000";
const ext = resolve("../extension/dist");
const logDir = resolve("../server/logs");
const personas = JSON.parse(readFileSync("../testsites/personas.json", "utf8"));
const W = 1280, H = 800, PANEL_W = 640;

// ---- preflight ---------------------------------------------------------------------------------
async function getJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
}
if (!(await fetch(`${BASE}/demobank/login`).then((r) => r.ok, () => false))) throw new Error("test sites are not running: python testsites/serve.py");
const health = await getJson(`${AGENT}/health`);
if (!health?.model_reachable) throw new Error(`agent server or its model is not reachable at ${AGENT}/health (${JSON.stringify(health)})`);
const MODEL = health.model === "oracle" ? "scripted expert (oracle_vlm.py)" : health.model;
if (!existsSync(join(ext, "manifest.json"))) throw new Error("extension/dist not built: npm run build in extension/");
console.log(`recording with model: ${MODEL}`);

const oldSessions = new Set(existsSync(logDir) ? readdirSync(logDir) : []);
mkdirSync(OUT, { recursive: true });
const rawDir = join(OUT, "raw");
rmSync(rawDir, { recursive: true, force: true });

// ---- browser with video recording ----------------------------------------------------------------
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-demo-")), {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: W, height: H },
  recordVideo: { dir: rawDir, size: { width: W, height: H } },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
if (process.env.AGENT_URL) await sw.evaluate((u) => chrome.storage.local.set({ settings: { serverUrl: u } }), AGENT);

const page = await ctx.newPage();
const t0 = Date.now();
const caps = [];
const caption = (text) => {
  caps.push({ t: (Date.now() - t0) / 1000, text });
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}`);
};
const hold = (ms) => page.waitForTimeout(ms);

await page.goto(`${BASE}/hr/profile?p=3`);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8080/*" }))[0].id);
const panelP = ctx.waitForEvent("page");
await sw.evaluate(([u, w, h]) => chrome.windows.create({ url: u, type: "popup", width: w, height: h }), [`chrome-extension://${extId}/src/sidepanel/index.html?tab=${tabId}`, PANEL_W, H]);
const panel = await panelP;
const panelStart = (Date.now() - t0) / 1000;
await panel.setViewportSize({ width: PANEL_W, height: H });
await panel.waitForLoadState();
// Larger type in the panel so it reads in a video; the panel's behaviour is untouched.
await panel.addStyleTag({ content: "body{font-size:14px} pre{max-height:none;font-size:12px;white-space:pre-wrap;word-break:break-word} #log .step img{display:none}" });

const scrollPanel = (sel) => panel.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "start", behavior: "smooth" }), sel);
// Scrolls the panel so that the first occurrence of `needle` inside the element `sel` (e.g. the outgoing JSON) is in view.
const scrollPanelToText = (sel, needle) =>
  panel.evaluate(([s, n]) => {
    const el = document.querySelector(s);
    const node = el?.firstChild;
    const i = node?.textContent?.indexOf(n) ?? -1;
    if (i < 0) return false;
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + n.length);
    window.scrollBy({ top: r.getBoundingClientRect().top - 120, behavior: "smooth" });
    return true;
  }, [sel, needle]);

caption(`PrivaSight demo. Left: the real page (synthetic person). Right: the Privacy view, exactly what leaves the device. Model: ${MODEL}`);
await hold(4000);

// ---- scene 1: one perception step on a page full of personal data ----------------------------------------
if (SCENES.includes("capture")) {
  caption("HR Portal profile: name, Aadhaar, PAN, phone, email, DOB, address and a photo. Press Capture & mark.");
  await hold(2500);
  await panel.click("#capture");
  await panel.waitForFunction(() => document.querySelectorAll("#els tr").length > 0, null, { timeout: 120_000 });
  await scrollPanel("#shot");
  caption("On-device redaction: black boxes for PII text, the face blurred, numbered boxes for the agent. Nothing has been sent yet.");
  await hold(6000);
  await scrollPanel("#privacy-box h4");
  caption("Every painted region with its detector: DOM rules, regex with validators (Verhoeff, Luhn), NER model, face detector.");
  await hold(5000);
  await scrollPanel("#json");
  caption("The outgoing JSON: personal values are typed placeholders such as [PHONE_1] and [NAME_1]; the real values stay on the device.");
  await hold(6000);
}

// ---- scene 2: a multi-step task with a vault secret and a placeholder round trip ---------------------------
async function runTask(task, { secret, timeoutMs = 240_000 } = {}) {
  // The regions table is filled by "Capture & mark" only; during a task it would show the old page, so hide it.
  await panel.addStyleTag({ content: "#privacy-box h4:first-of-type, #regions {display:none}" });
  if (secret) {
    await scrollPanel("legend");
    await panel.fill("#secret-password", secret);
    await panel.click("#save-secrets");
    await panel.waitForFunction(() => document.getElementById("vault-info").textContent.includes("PASSWORD"));
  }
  await panel.fill("#task", task);
  await panel.click("#start");
  const end = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < end) {
    const status = await panel.textContent("#status"); // read before the steps, so the last step is captioned too
    const steps = await panel.$$eval("#log .step", (d) => d.map((x) => x.firstChild.textContent));
    for (; seen < steps.length; seen++) {
      const m = steps[seen].match(/^step (\d+): (\{.*?\}) \[/);
      const action = m ? JSON.parse(m[2]) : null;
      let what = steps[seen].slice(0, 120);
      if (action?.type === "type") {
        const secretish = /\{(PASSWORD|OTP|SECRET:[^}]+)\}|\[[A-Z]+_\d+\]/.test(action.text);
        what = `type ${JSON.stringify(action.text)} into element ${action.element_id}${secretish ? ": a placeholder; the extension types the real value locally" : ""}`;
      } else if (action?.type === "click") what = `click element ${action.element_id}`;
      else if (action) what = `${action.type}${action.summary ? `: ${action.summary}` : action.question ? `: ${action.question}` : ""}`;
      caption(`Step ${m?.[1] ?? seen + 1}, the model's action: ${what}`);
      // Show the request that was sent: the task line (with its placeholder) when the model types a [TYPE_n] value.
      if (action?.type === "type" && /\[[A-Z]+_\d+\]/.test(action.text)) await scrollPanelToText("#json", '"task"');
      else await scrollPanel("#shot");
    }
    if (/^(done|ask_user|error|stopped|step_limit):/.test(status)) return status;
    await page.waitForTimeout(250);
  }
  return "timeout";
}

if (SCENES.includes("login")) {
  const p = personas[4];
  await page.goto(`${BASE}/demobank/login?p=4`);
  await hold(800);
  caption("DemoBank. The password goes into the on-device vault; the model only ever sees the name {PASSWORD}.");
  await hold(3500);
  const task = `Log in as ${p.username} with the stored password, then open Profile and change the mobile number to ${p.new_phone} and save`;
  caption("Task text contains a new phone number: it is sanitised to [PHONE_1] before it leaves the device.");
  const status = await runTask(task, { secret: p.password });
  await hold(1500);
  caption(`Agent finished (${status.split(":")[0]}).`);
  const state = await getJson(`${BASE}/demobank/check?p=4`);
  const phoneOk = state?.state?.profile?.phone === p.new_phone;
  await hold(1500);
  caption(phoneOk ? "Site state: the mobile number was really changed. The server only ever saw [PHONE_1]." : "Site state: the phone was NOT changed in this run (see the step log).");
  await hold(4500);
}

// ---- scene 3: faces in a video call --------------------------------------------------------------------
if (SCENES.includes("meeting")) {
  await page.goto(`${BASE}/videomeet/meeting?p=9`);
  await hold(800);
  caption("VideoMeet: participant faces and names. Faces are blurred on the device; video elements are blurred by default.");
  await hold(3000);
  const status = await runTask("Leave the meeting", { timeoutMs: 120_000 });
  await hold(1500);
  caption(`Agent finished (${status.split(":")[0]}).`);
  await scrollPanel("#shot");
  await hold(3000);
}

// ---- audit: did any real value reach the server? --------------------------------------------------------------
const sens = [];
for (const q of personas) {
  for (const v of [q.full_name, q.email, q.phone, q.new_phone, q.aadhaar, q.pan, q.dob, q.address, q.account_number, q.card_number, q.password]) {
    if (v) sens.push(String(v), String(v).replace(/[\s-]/g, ""));
  }
}
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const newSessions = existsSync(logDir) ? readdirSync(logDir).filter((d) => !oldSessions.has(d)) : [];
let requests = 0, leaks = 0;
for (const f of newSessions.flatMap((d) => walk(join(logDir, d))).filter((f) => f.endsWith(".jsonl"))) {
  const txt = readFileSync(f, "utf8");
  requests += txt.split("\n").filter(Boolean).length;
  for (const v of sens) if (v.length >= 4 && txt.includes(v)) leaks++;
}
caption(`Audit of the agent server's request log for this demo: ${requests} requests, ${leaks} real personal values found.`);
await hold(5000);

// ---- finish: collect the videos, write captions, compose ----------------------------------------------------------
const pagePath = await page.video().path();
const panelPath = await panel.video().path();
const total = (Date.now() - t0) / 1000;
await ctx.close();
copyFileSync(pagePath, join(OUT, "page.webm"));
copyFileSync(panelPath, join(OUT, "panel.webm"));
rmSync(rawDir, { recursive: true, force: true });

const ts = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p2 = (n, w = 2) => String(n).padStart(w, "0");
  return `${p2(Math.floor(ms / 3600000))}:${p2(Math.floor(ms / 60000) % 60)}:${p2(Math.floor(ms / 1000) % 60)},${p2(ms % 1000, 3)}`;
};
// Braces start override tags in libass, so they are escaped for the burned-in captions (the .srt keeps them readable elsewhere).
const srtOf = (esc) => caps.map((c, i) => `${i + 1}\n${ts(c.t)} --> ${ts(caps[i + 1]?.t ?? total)}\n${esc(c.text)}\n`).join("\n");
const srt = srtOf((t) => t);
writeFileSync(join(OUT, "privasight_demo.srt"), srt);
writeFileSync(join(OUT, "burn.srt"), srtOf((t) => t.replace(/[{}]/g, (b) => `\\${b}`)));
writeFileSync(join(OUT, "demo_meta.json"), JSON.stringify({ model: MODEL, scenes: SCENES, seconds: Math.round(total), sessions: newSessions, requests, leaks, panelOffsetS: panelStart }, null, 2));

try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.log(`ffmpeg not found: raw videos and captions are in ${OUT} (page.webm, panel.webm, privasight_demo.srt)`);
  process.exit(leaks ? 1 : 0);
}
// Panel video: 640 px of content in a 1280 px frame -> crop, delay to its real start time, place right of the page.
// A caption bar under both, with the subtitles burned in (run from OUT so the subtitle path needs no escaping).
const filter = [
  `[1:v]crop=${PANEL_W}:${H}:0:0,tpad=start_duration=${panelStart.toFixed(2)}:color=white[p]`,
  `[0:v][p]hstack=inputs=2,pad=iw:ih+110:0:0:black,subtitles=burn.srt:force_style='FontName=DejaVu Sans,FontSize=13,Alignment=2,MarginV=12,MarginL=30,MarginR=30,WrapStyle=0'[v]`,
].join(";");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", "page.webm", "-i", "panel.webm", "-filter_complex", filter, "-map", "[v]", "-r", "25", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "privasight_demo.mp4"], { cwd: OUT, stdio: "inherit" });
rmSync(join(OUT, "burn.srt"), { force: true });
console.log(`demo video: ${join(OUT, "privasight_demo.mp4")} (${Math.round(total)} s); leaks ${leaks}`);
process.exit(leaks ? 1 : 0);
