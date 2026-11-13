// Phase 1 acceptance: load the built extension in Chromium, open DemoBank, capture and mark.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ext = resolve("../extension/dist");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-")), {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1280, height: 800 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto("http://localhost:8080/demobank/login");
await page.waitForTimeout(500);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8080/*" }))[0].id);

// Separate popup window so DemoBank stays the visible tab of its own window (captureVisibleTab).
const panelP = ctx.waitForEvent("page");
await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 700, height: 900 }), `chrome-extension://${id}/src/sidepanel/index.html?tab=${tabId}`);
const panel = await panelP;
await panel.waitForLoadState();
await panel.click("#capture");
await panel.waitForFunction(() => document.querySelectorAll("#els tr").length > 0, null, { timeout: 90000 });
console.log("info:", await panel.textContent("#info"));
console.log("rows:", await panel.$$eval("#els tr", (r) => r.map((x) => x.textContent)));
console.log("error:", JSON.stringify(await panel.textContent("#err")));
await panel.screenshot({ path: "phase1.png", fullPage: true });
const n = await panel.$$eval("#els tr", (r) => r.length);
await ctx.close();
if (n < 3) throw new Error("expected >=3 interactive elements");
console.log("PHASE1 OK");
