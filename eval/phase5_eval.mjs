// Phase 5 evaluation: recall per category (structured PII, names, addresses, faces), redaction precision,
// leakage, and local latency (WebGPU vs WASM), all measured through the real extension.
//
//   node phase5_eval.mjs [personas=3] [variants=,dark,serif,large,shift] [backend=webgpu|wasm]
//   (OUT=reports/other.json writes the report elsewhere; the default is reports/phase5_<backend>.json)
//
// Needs testsites/serve.py. Recall rule (Section 10): a ground-truth item counts as covered when >= 90% of
// its box (text extent / field box; the central 50% of a photo for faces) is under painted regions.
//
// Layer ablation (Section 10, experiment 1): every painted region carries its source, so recall and precision are also
// computed with only the regions of the cumulative layer sets DOM -> +regex -> +NER -> full (faces, video, OCR).
// The layers are independent detectors whose regions are unioned, so dropping a layer's regions is the same as not running it.
import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const N = Number(process.argv[2] ?? 3);
const VARIANTS = (process.argv[3] ?? ",dark,serif,large,shift").split(",");
const BACKEND = process.argv[4] ?? "webgpu";
const ONLY = process.argv[5] ?? ""; // optional: only pages whose "site/page" contains this
const BASE = "http://localhost:8080";
const STRUCTURED = new Set(["AADHAAR", "PAN", "PHONE", "EMAIL", "CARD", "IFSC", "ACCOUNT", "DOB", "CVV"]);
const TEXT_PII = new Set([...STRUCTURED, "NAME", "ADDRESS"]);
const PAGES = [
  ["demobank", "dashboard", ""], ["demobank", "profile", ""], ["demobank", "transfer", ""],
  ["hr", "profile", ""], ["hr", "leave", ""], ["hr", "idcard", ""],
  ["hospital", "appointments", ""], ["hospital", "records", ""],
  ["shopmart", "search", "&q=cable"], ["shopmart", "cart", ""], ["shopmart", "checkout", ""],
  ["mailbox", "inbox", ""], ["mailbox", "read", "&m=1"], ["mailbox", "compose", "&reply=sender@example.com"],
  ["videomeet", "meeting", ""],
];

const ext = resolve("../extension/dist");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ps-")), {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--enable-unsafe-webgpu"],
  viewport: { width: 1280, height: 800 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
// Choose the backend, then restart the offscreen document so it picks the config up.
await sw.evaluate(async (cfg) => {
  await chrome.storage.session.set({ mlConfig: cfg });
  await chrome.offscreen.closeDocument().catch(() => {});
}, BACKEND === "wasm" ? { nerDevice: "wasm", faceDelegate: "CPU" } : { nerDevice: "webgpu", faceDelegate: "GPU" });

const page = await ctx.newPage();
await page.goto(`${BASE}/demobank/login`);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8080/*" }))[0].id);
const panelP = ctx.waitForEvent("page");
await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 600, height: 700 }), `chrome-extension://${id}/src/sidepanel/index.html`);
const panel = await panelP;
await panel.waitForLoadState();

const digits = (s) => s.replace(/\D/g, "");
const norm = (s) => s.replace(/[\s-]+/g, "");
const GRID = 4; // px sampling for area computations

const inAny = (boxes, x, y) => boxes.some((r) => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]);
function coverage(box, regions) {
  const [x, y, w, h] = box;
  if (w <= 0 || h <= 0) return 0;
  let covered = 0, total = 0;
  for (let j = y; j < y + h; j += 1) for (let i = x; i < x + w; i += 1) { total++; if (inAny(regions, i, j)) covered++; }
  return covered / total;
}

const stats = {};
const bump = (cat, k, n = 1) => ((stats[cat] ??= { total: 0, covered: 0, black: 0, blurred: 0, leaked: 0 })[k] += n);
const misses = [];
const offGt = {}; // painted regions that are not on ground truth (precision loss), by category/source
const lat = { total: [], ml: [], ner: [], face: [], paint: [] };
let captures = 0, blockedCaptures = 0, paintedCells = 0, paintedOnGt = 0, firstRun = null;

// Cumulative layer sets for the ablation. "dom" = Layer A rules + vault values; "full" adds faces, <video> and OCR.
const LAYERS = [
  ["dom", new Set(["dom", "vault"])],
  ["dom+regex", new Set(["dom", "vault", "regex"])],
  ["dom+regex+ner", new Set(["dom", "vault", "regex", "ner"])],
  ["full", null],
];
const layerOf = (r) => (r.category === "VIDEO" ? "face" : r.source); // <video> blur belongs to the face layer
const abl = Object.fromEntries(LAYERS.map(([n]) => [n, { stats: {}, painted: 0, onGt: 0 }]));

for (const [site, name, extra] of PAGES) {
  if (ONLY && !`${site}/${name}`.includes(ONLY)) continue;
  for (const v of VARIANTS) {
    for (let p = 0; p < N; p++) {
      const qs = `?p=${p}${v ? `&v=${v}` : ""}${extra}`;
      await page.goto(`${BASE}/${site}/${name}${qs}`);
      const truth = await (await fetch(`${BASE}/groundtruth/${site}/${name}${qs}`)).json();
      const rawShot = (await page.screenshot()).toString("base64");
      const t0 = Date.now();
      const res = await panel.evaluate((tabId) => chrome.runtime.sendMessage({ type: "capture", tabId }), tabId);
      if (!res.ok) throw new Error(`${site}/${name}${qs}: ${res.error}`);
      if (firstRun === null) firstRun = Date.now() - t0;
      captures++;
      const { image, payload, regions, guard, timingMs: tm } = res.result;
      if (guard.blocked) blockedCaptures++;
      if (captures > 1) { // the first capture pays one-time model/shader loading: reported separately
        lat.total.push(tm.ml + tm.map + tm.rules + tm.paint);
        lat.ml.push(tm.ml); lat.ner.push(tm.ml_ner); lat.face.push(tm.ml_face); lat.paint.push(tm.paint);
      }
      const json = payload ? JSON.stringify(payload) : "";
      const jsonFlat = norm(json);
      const boxes = regions.map((r) => r.bbox);
      const layerBoxes = LAYERS.map(([n, set]) => [n, (set ? regions.filter((r) => set.has(layerOf(r))) : regions).map((r) => r.bbox)]);

      const items = [];
      for (const t of truth) {
        const rect = await page.evaluate(({ sel, off }) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          let r = el.getBoundingClientRect();
          if (off) r = new DOMRect(r.x + 1 + off[0], r.y + 1 + off[1], off[2], off[3]); // text drawn on a canvas (1px border)
          if (!off && !["INPUT", "TEXTAREA", "SELECT", "IMG"].includes(el.tagName)) {
            const range = document.createRange();
            range.selectNodeContents(el);
            r = range.getBoundingClientRect();
          }
          const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
          return inView ? [r.x, r.y, r.width, r.height] : null;
        }, { sel: t.selector, off: t.offset });
        if (rect) items.push({ ...t, rect });
      }

      // Pixels: black at the right end of text/fields; for faces, compare edge energy raw vs redacted.
      const pix = await panel.evaluate(async ({ image, rawShot, items }) => {
        const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); const c = document.createElement("canvas"); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(i, 0, 0); return { g, s: i.naturalWidth / 1280 }; };
        const red = await load(image), raw = await load("data:image/png;base64," + rawShot);
        const energy = (c, [x, y, w, h]) => {
          const d = c.g.getImageData(Math.floor(x * c.s), Math.floor(y * c.s), Math.max(2, Math.floor(w * c.s)), Math.max(2, Math.floor(h * c.s)));
          let e = 0; const W = d.width;
          for (let j = 0; j < d.height - 1; j++) for (let i = 0; i < W - 1; i++) { const k = (j * W + i) * 4; e += Math.abs(d.data[k] - d.data[k + 4]) + Math.abs(d.data[k] - d.data[k + W * 4]); }
          return e / (d.width * d.height);
        };
        return items.map((t) => {
          const [x, y, w, h] = t.rect;
          if (t.category === "FACE") {
            const core = [x + w * 0.25, y + h * 0.25, w * 0.5, h * 0.5];
            return { blurRatio: energy(red, core) / Math.max(1e-6, energy(raw, core)) };
          }
          const d = red.g.getImageData(Math.floor((x + w - 3) * red.s), Math.floor((y + h / 2) * red.s), 1, 1).data;
          return { rgb: [d[0], d[1], d[2]] };
        });
      }, { image, rawShot, items });

      items.forEach((t, k) => {
        const cat = t.category;
        bump(cat, "total");
        let rect = t.rect;
        if (cat === "FACE") rect = [t.rect[0] + t.rect[2] * 0.25, t.rect[1] + t.rect[3] * 0.25, t.rect[2] * 0.5, t.rect[3] * 0.5];
        const cov = coverage(rect, boxes);
        for (const [n, lb] of layerBoxes) {
          const st = (abl[n].stats[cat] ??= { total: 0, covered: 0 });
          st.total++;
          if (coverage(rect, lb) >= 0.9) st.covered++;
        }
        const isCovered = cov >= 0.9;
        const isDark = cat === "FACE" ? pix[k].blurRatio < 0.35 : pix[k].rgb.every((c) => c < 40);
        if (isCovered) bump(cat, "covered");
        if (isDark) bump(cat, cat === "FACE" ? "blurred" : "black");
        let leaked = false;
        if (t.value && payload) leaked = json.includes(t.value) || jsonFlat.includes(norm(t.value)) || (digits(t.value).length >= 9 && json.includes(digits(t.value)));
        if (leaked) bump(cat, "leaked");
        if ((TEXT_PII.has(cat) || cat === "FACE") && (!isCovered || !isDark || leaked)) {
          misses.push({ page: `${site}/${name}${qs}`, category: cat, value: t.value, coverage: +cov.toFixed(2), ok_pixels: isDark, leaked });
        }
      });

      // Precision (area): how much of the painted area lies on ground-truth items.
      const gtBoxes = items.map((t) => t.rect);
      for (const r of regions) { // which painted regions sit (mostly) off ground truth, and what are they?
        let cells = 0, off = 0;
        for (let y = r.bbox[1]; y < r.bbox[1] + r.bbox[3]; y += GRID) for (let x = r.bbox[0]; x < r.bbox[0] + r.bbox[2]; x += GRID) { cells++; if (!inAny(gtBoxes, x, y)) off++; }
        if (cells && off / cells > 0.5) { const k = `${r.category}/${r.source}`; (offGt[k] ??= { n: 0, cells: 0, examples: [] }); offGt[k].n++; offGt[k].cells += off; if (offGt[k].examples.length < 4) { const txt = await page.evaluate(([x, y]) => (document.elementFromPoint(x, y)?.textContent ?? '').trim().slice(0, 30), [r.bbox[0] + r.bbox[2] / 2, r.bbox[1] + r.bbox[3] / 2]); offGt[k].examples.push(`${site}/${name}:${JSON.stringify(txt)}`); } }
      }
      for (let y = 0; y < 800; y += GRID) for (let x = 0; x < 1280; x += GRID) {
        if (inAny(boxes, x, y)) { paintedCells++; if (inAny(gtBoxes, x, y)) paintedOnGt++; }
        for (const [n, lb] of layerBoxes) if (inAny(lb, x, y)) { abl[n].painted++; if (inAny(gtBoxes, x, y)) abl[n].onGt++; }
      }
    }
  }
}
await ctx.close();

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : "-");
const q = (a, f) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(f * a.length))] : NaN);
mkdirSync("reports", { recursive: true });
console.log(`backend=${BACKEND} captures=${captures} (pages ${PAGES.length} x variants ${VARIANTS.length} x personas ${N}); guard-blocked=${blockedCaptures}; first capture (includes model load) ${firstRun} ms`);
console.log("category   total  covered   dark/blurred  leaked-in-JSON");
const agg = { total: 0, covered: 0, dark: 0, leaked: 0 };
for (const [cat, s] of Object.entries(stats).sort()) {
  const ok = cat === "FACE" ? s.blurred : s.black;
  console.log(`${cat.padEnd(10)} ${String(s.total).padStart(5)}  ${pct(s.covered, s.total).padStart(6)}%  ${pct(ok, s.total).padStart(8)}%      ${s.leaked}`);
  if (TEXT_PII.has(cat)) { agg.total += s.total; agg.covered += s.covered; agg.dark += ok; agg.leaked += s.leaked; }
}
const precision = paintedOnGt / paintedCells;
console.log(`\nTEXT PII (structured + names + addresses): recall ${pct(agg.covered, agg.total)}% (${agg.covered}/${agg.total}), leaked in JSON: ${agg.leaked}`);
console.log(`redaction precision (painted area on ground truth): ${(100 * precision).toFixed(1)}%`);
console.log("painted off ground truth (precision loss):", Object.entries(offGt).sort((a, b) => b[1].cells - a[1].cells).map(([k, v]) => `${k} x${v.n} (${v.cells} cells, e.g. ${v.examples.join(", ")})`).join(" | ") || "none");
console.log(`local latency ms (ml+map+rules+paint, excl. first capture, n=${lat.total.length}): median ${q(lat.total, 0.5)}  p95 ${q(lat.total, 0.95)} | ner median ${q(lat.ner, 0.5)} p95 ${q(lat.ner, 0.95)} | face median ${q(lat.face, 0.5)} p95 ${q(lat.face, 0.95)} | paint median ${q(lat.paint, 0.5)}`);
if (misses.length) {
  console.log(`\nmisses (${misses.length}), first 14:`);
  for (const m of misses.slice(0, 14)) console.log("  ", JSON.stringify(m));
}

// Layer ablation table: recall per category group for each cumulative layer set.
const groups = { structured: STRUCTURED, names: new Set(["NAME"]), addresses: new Set(["ADDRESS"]), "text PII (all)": TEXT_PII, faces: new Set(["FACE"]) };
const ablation = {};
console.log("\nlayer ablation (recall = ground-truth items >= 90% covered; precision = painted area on ground truth):");
console.log("layers           " + Object.keys(groups).filter((g) => groups[g]).map((g) => g.padStart(16)).join("") + "   precision");
for (const [n] of LAYERS) {
  const a = abl[n];
  const row = { precision: a.painted ? a.onGt / a.painted : null, recall: {}, perCategory: a.stats };
  for (const [g, set] of Object.entries(groups)) {
    if (!set) continue;
    let t = 0, c = 0;
    for (const [cat, st] of Object.entries(a.stats)) if (set.has(cat)) { t += st.total; c += st.covered; }
    row.recall[g] = { covered: c, total: t };
  }
  ablation[n] = row;
  console.log(n.padEnd(16) + " " + Object.values(row.recall).map((r) => `${pct(r.covered, r.total)}%`.padStart(16)).join("") + `   ${row.precision === null ? "-" : (100 * row.precision).toFixed(1) + "%"}`);
}
writeFileSync(process.env.OUT ?? `reports/phase5_${BACKEND}.json`, JSON.stringify({ backend: BACKEND, captures, firstRun, stats, precision, latency: { total: lat.total, ner: lat.ner, face: lat.face, paint: lat.paint }, misses, ablation }, null, 2));
