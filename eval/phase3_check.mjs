// Phase 3 acceptance: the agent logs into DemoBank using {PASSWORD}; server logs must not contain the password.
// Needs: testsites/serve.py (8080) and the agent server (8000) running with a VLM behind it
// (fake_vlm.py for plumbing, Ollama for the real model).  Usage: node phase3_check.mjs [runs]
import { chromium } from "playwright";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PASSWORD = "Pw!421141x"; // persona user00 (synthetic)
const RUNS = Number(process.argv[2] ?? 1);
const ext = resolve("../extension/dist");
const logDir = resolve("../server/logs");
// Only sessions created by this run are scanned: older sessions (the unsafe clean-screens baseline, oracle data) hold real values on purpose.
const oldSessions = new Set(existsSync(logDir) ? readdirSync(logDir) : []);

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

async function oneRun(n) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-")), {
    headless: false,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1280, height: 800 },
  });
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host;
    if (process.env.AGENT_URL) await sw.evaluate((u) => chrome.storage.local.set({ settings: { serverUrl: u } }), process.env.AGENT_URL); // suite-owned agent server
    const page = await ctx.newPage();
    await page.goto("http://localhost:8080/demobank/login");
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8080/*" }))[0].id);

    const panelP = ctx.waitForEvent("page");
    await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 700, height: 1000 }), `chrome-extension://${id}/src/sidepanel/index.html?tab=${tabId}`);
    const panel = await panelP;
    await panel.waitForLoadState();
    await panel.fill("#secret-password", PASSWORD);
    await panel.click("#save-secrets");
    await panel.waitForFunction(() => document.getElementById("vault-info").textContent.includes("PASSWORD"));
    await panel.fill("#task", "Log in to DemoBank as user00 using the stored password");
    const t0 = Date.now();
    await panel.click("#start");
    await panel.waitForFunction(() => /^(done|ask_user|error|stopped|step_limit):/.test(document.getElementById("status").textContent), null, { timeout: 15 * 60_000 });
    const status = await panel.textContent("#status");
    const steps = await panel.$$eval("#log .step", (d) => d.map((x) => x.firstChild.textContent));
    const url = page.url();
    const ok = status.startsWith("done:") && url.includes("/demobank/dashboard");
    console.log(`run ${n}: ${ok ? "PASS" : "FAIL"} ${Math.round((Date.now() - t0) / 1000)}s  status="${status}" url=${url}`);
    for (const s of steps) console.log("   ", s);
    await panel.screenshot({ path: `phase3_run${n}.png`, fullPage: true });
    return ok;
  } finally {
    await ctx.close();
  }
}

let pass = 0;
for (let i = 1; i <= RUNS; i++) if (await oneRun(i)) pass++;
console.log(`login success: ${pass}/${RUNS}`);

// Leakage: no server log may contain the password (or the typed secret in any form).
let leaked = [];
if (existsSync(logDir)) {
  for (const f of readdirSync(logDir).filter((d) => !oldSessions.has(d)).flatMap((d) => walk(join(logDir, d))).filter((p) => p.endsWith(".jsonl"))) {
    if (readFileSync(f, "utf8").includes(PASSWORD)) leaked.push(f);
  }
}
console.log(`scanned ${readdirSync(logDir).filter((d) => !oldSessions.has(d)).length} new session(s)`);
console.log(leaked.length ? `LEAK in server logs: ${leaked}` : "server logs: no password found");
process.exit(leaked.length || pass === 0 ? 1 : 0);
