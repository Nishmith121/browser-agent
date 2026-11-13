// Probe the offscreen ML document directly: backends, load time, detections and latency.
//   node phase5_probe.mjs [nerDevice=webgpu|wasm] [faceDelegate=GPU|CPU]
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const nerDevice = process.argv[2] ?? "webgpu";
const faceDelegate = process.argv[3] ?? "GPU";
const ext = resolve("../extension/dist");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-")), {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  viewport: { width: 1280, height: 800 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto("http://localhost:8080/hr/profile?p=1");
await page.waitForLoadState("networkidle");
const png = (await page.screenshot()).toString("base64");
const texts = await page.evaluate(() => {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(), i = 0; n; n = w.nextNode()) { const t = n.textContent.trim(); if (t && !["SCRIPT", "STYLE"].includes(n.parentElement.tagName)) out.push({ id: i++, text: t }); }
  return out;
});
const media = await page.evaluate(() => [...document.querySelectorAll("img")].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
console.log("page texts:", texts.length, "media:", JSON.stringify(media));

await sw.evaluate(() => chrome.offscreen.createDocument({ url: "src/offscreen/index.html", reasons: ["WORKERS"], justification: "probe" }));

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/src/sidepanel/index.html`);
const req = { target: "offscreen", type: "ml:run", config: { nerDevice, faceDelegate }, raw: "data:image/png;base64," + png, viewportWidth: 1280, media: media.map((bbox) => ({ kind: "img", bbox })), texts };
const t0 = Date.now();
let res = await panel.evaluate((r) => chrome.runtime.sendMessage(r), req);
console.log("first run (includes model load):", Date.now() - t0, "ms; ok:", res?.ok);
if (!res?.ok) { console.log("ERROR:", res?.error); await ctx.close(); process.exit(1); }
console.log("backend:", JSON.stringify(res.result.backend), "timing:", JSON.stringify(res.result.timingMs), "ner:", JSON.stringify(res.result.nerStats));
console.log("faces:", JSON.stringify(res.result.faces.map((b) => b.map(Math.round))));
for (const n of res.result.ner) {
  const t = texts.find((x) => x.id === n.id).text;
  if (n.entities.length) console.log("  ner:", JSON.stringify(t.slice(0, 60)), "->", n.entities.map((e) => `${e.category}:${e.value}(${e.score.toFixed(2)})`).join(" | "));
}
// Second run: NER cache should make it cheaper; face detection is re-run (new pixels).
const t1 = Date.now();
res = await panel.evaluate((r) => chrome.runtime.sendMessage(r), req);
console.log("second run:", Date.now() - t1, "ms; timing:", JSON.stringify(res.result.timingMs), "cache:", JSON.stringify(res.result.nerStats));
await ctx.close();
