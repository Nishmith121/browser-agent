// Show raw NER output (all entities, with scores) for given texts.   node phase5_ner_explore.mjs "<text>" ...
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let texts = process.argv.slice(2).map((text, id) => ({ id, text }));
const pageUrl = process.argv[2]?.startsWith("http") ? process.argv[2] : null;
const ext = resolve("../extension/dist");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-")), { headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 1280, height: 800 } });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
await sw.evaluate(() => chrome.offscreen.closeDocument().catch(() => {}));
const page = await ctx.newPage(); await page.goto(pageUrl ?? "http://localhost:8080/demobank/login");
if (pageUrl) texts = await page.evaluate(() => { const o = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(), i = 0; n; n = w.nextNode()) { const t = n.textContent.trim(); if (t && !["SCRIPT", "STYLE"].includes(n.parentElement.tagName)) o.push({ id: i++, text: t }); } return o; });
const png = (await page.screenshot()).toString("base64");
await sw.evaluate(() => chrome.offscreen.createDocument({ url: "src/offscreen/index.html", reasons: ["WORKERS"], justification: "explore" }));
const panel = await ctx.newPage(); await panel.goto(`chrome-extension://${id}/src/sidepanel/index.html`);
// Each text on its own (isolated) and all together as separate nodes (the real page case).
for (const mode of (pageUrl ? ["together"] : ["isolated", "together"])) {
  const groups = mode === "isolated" ? texts.map((t) => [t]) : [texts];
  for (const g of groups) {
    const res = await panel.evaluate((r) => chrome.runtime.sendMessage(r), { target: "offscreen", type: "ml:run", config: { nerDevice: "wasm", faceDelegate: "CPU", nerDebugAll: true }, raw: "data:image/png;base64," + png, viewportWidth: 1280, mediaBoxes: [], texts: g });
    if (!res.ok) { console.log("ERR", res.error); process.exit(1); }
    for (const n of res.result.ner) console.log(mode.padEnd(8), JSON.stringify(texts[n.id].text).padEnd(34), n.entities.map((e) => `${e.tag}:${e.value}(${e.score.toFixed(2)})`).join(" | ") || "(nothing)");
  }
}
await ctx.close();
