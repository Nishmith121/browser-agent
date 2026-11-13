// Phase 4: placeholder round trip. The task contains a new phone number; the model must only ever see
// [PHONE_n]; the extension restores the real number locally when it types, and the site state must change.
// Needs: testsites/serve.py (8080), agent server (8000) and eval/fake_vlm.py (11435) or a real VLM.
import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NEW_PHONE = "9123456780";
const ext = resolve("../extension/dist");
const logDir = resolve("../server/logs");
// Only sessions created by this run are scanned: older sessions (the unsafe clean-screens baseline, oracle data) hold real values on purpose.
const oldSessions = new Set(existsSync(logDir) ? readdirSync(logDir) : []);
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

await fetch("http://localhost:8080/reset", { method: "POST", body: "{}" });
const before = (await (await fetch("http://localhost:8080/demobank/check?p=0")).json()).persona;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-")), {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1280, height: 800 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
if (process.env.AGENT_URL) await sw.evaluate((u) => chrome.storage.local.set({ settings: { serverUrl: u } }), process.env.AGENT_URL); // suite-owned agent server
const page = await ctx.newPage();
await page.goto("http://localhost:8080/demobank/profile?p=0");
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8080/*" }))[0].id);
const panelP = ctx.waitForEvent("page");
await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 700, height: 1000 }), `chrome-extension://${id}/src/sidepanel/index.html?tab=${tabId}`);
const panel = await panelP;
await panel.waitForLoadState();
await panel.fill("#task", `Change the mobile number to ${NEW_PHONE} and save it`);
await panel.click("#start");
await panel.waitForFunction(() => /^(done|ask_user|error|stopped|step_limit):/.test(document.getElementById("status").textContent), null, { timeout: 10 * 60_000 });
const status = await panel.textContent("#status");
const steps = await panel.$$eval("#log .step", (d) => d.map((x) => x.firstChild.textContent));
const typedValue = await page.inputValue("#phone");
const after = (await (await fetch("http://localhost:8080/demobank/check?p=0")).json()).state;
await panel.screenshot({ path: "phase4_roundtrip.png", fullPage: true });
await ctx.close();

console.log("status:", status);
steps.forEach((s) => console.log("  ", s.slice(0, 170)));
const failures = [];
if (!status.startsWith("done:")) failures.push(`task did not finish: ${status}`);
if (after.profile?.phone !== NEW_PHONE) failures.push(`site state phone is ${after.profile?.phone}, expected ${NEW_PHONE}`);
if (typedValue !== NEW_PHONE) failures.push(`input holds ${typedValue}`);

// Nothing the server saw may contain either number.
let logs = "";
const newSessions = existsSync(logDir) ? readdirSync(logDir).filter((d) => !oldSessions.has(d)) : [];
for (const d of newSessions) for (const f of walk(join(logDir, d))) if (f.endsWith(".jsonl")) logs += readFileSync(f, "utf8");
if (!newSessions.length) failures.push("no new server session was logged, so there was nothing to scan");
for (const [label, v] of [["new phone", NEW_PHONE], ["old phone", before.phone]]) {
  if (logs.includes(v)) failures.push(`server logs contain the ${label}`);
}
if (!/\[PHONE_\d+\]/.test(logs)) failures.push("server logs do not show placeholders");
console.log(failures.length ? "FAIL: " + failures.join("; ") : `PASS: typed locally, site phone changed ${before.phone} -> ${after.profile.phone}, server saw only placeholders`);
process.exit(failures.length ? 1 : 0);
