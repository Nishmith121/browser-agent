// Phase 4 acceptance: redaction recall of structured PII across all sites, measured against ground truth.
//
// For every (site page x persona x layout variant): capture through the real extension, then check each
// ground-truth PII location is (a) >= 90% covered by painted regions, (b) black in the redacted image,
// and (c) absent from the outgoing JSON (exact and normalised).  Needs testsites/serve.py running.
//
//   node phase4_recall.mjs [personas=6] [variants=,dark,serif,large,shift]
import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const N = Number(process.argv[2] ?? 6);
const VARIANTS = (process.argv[3] ?? ",dark,serif,large,shift").split(",");
const BASE = "http://localhost:8080";
const STRUCTURED = new Set(["AADHAAR", "PAN", "PHONE", "EMAIL", "CARD", "IFSC", "ACCOUNT", "DOB"]);
const PAGES = [
  ["demobank", "dashboard", ""], ["demobank", "profile", ""], ["demobank", "transfer", ""],
  ["hr", "profile", ""], ["hr", "leave", ""],
  ["hospital", "appointments", ""], ["hospital", "records", ""],
  ["shopmart", "search", "&q=cable"], ["shopmart", "cart", ""], ["shopmart", "checkout", ""],
  ["mailbox", "inbox", ""], ["mailbox", "read", "&m=1"], ["mailbox", "compose", "&reply=sender@example.com"],
  ["videomeet", "meeting", ""],
];

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
await page.goto(`${BASE}/demobank/login`);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8080/*" }))[0].id);
const panelP = ctx.waitForEvent("page");
await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 600, height: 700 }), `chrome-extension://${id}/src/sidepanel/index.html`);
const panel = await panelP;
await panel.waitForLoadState();

const digits = (s) => s.replace(/\D/g, "");
const norm = (s) => s.replace(/[\s-]+/g, "");

function coverage(box, regions) {
  const [x, y, w, h] = box.map(Math.round);
  if (w <= 0 || h <= 0) return 0;
  let covered = 0;
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      if (regions.some((r) => i >= r[0] && i < r[0] + r[2] && j >= r[1] && j < r[1] + r[3])) covered++;
    }
  }
  return covered / (w * h);
}

const stats = {}; // category -> {total, covered, black, leaked}
const bump = (cat, k) => ((stats[cat] ??= { total: 0, covered: 0, black: 0, leaked: 0, blocked: 0 })[k]++);
const misses = [];
let captures = 0;
let blockedCaptures = 0;

for (const [site, name, extra] of PAGES) {
  for (const v of VARIANTS) {
    for (let p = 0; p < N; p++) {
      const qs = `?p=${p}${v ? `&v=${v}` : ""}${extra}`;
      await page.goto(`${BASE}/${site}/${name}${qs}`);
      const truth = await (await fetch(`${BASE}/groundtruth/${site}/${name}${qs}`)).json();
      const res = await panel.evaluate((tabId) => chrome.runtime.sendMessage({ type: "capture", tabId }), tabId);
      if (!res.ok) throw new Error(`${site}/${name}${qs}: ${res.error}`);
      captures++;
      const { image, payload, regions, guard } = res.result;
      if (guard.blocked) blockedCaptures++;
      const json = payload ? JSON.stringify(payload) : "";
      const jsonFlat = norm(json);
      const boxes = regions.map((r) => r.bbox);

      // Geometry of each ground-truth element, then sample the redacted image at its right end.
      const items = [];
      for (const t of truth) {
        const rect = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          // Where the PII is drawn: the field box for inputs, the glyph extent for text (a flex/block
          // element can be far wider than its text, e.g. in the "shift" layout).
          let r = el.getBoundingClientRect();
          if (!["INPUT", "TEXTAREA", "SELECT", "IMG"].includes(el.tagName)) {
            const range = document.createRange();
            range.selectNodeContents(el);
            r = range.getBoundingClientRect();
          }
          const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
          return inView ? [r.x, r.y, r.width, r.height] : null;
        }, t.selector);
        if (rect) items.push({ ...t, rect });
      }
      const pix = await panel.evaluate(async ({ image, pts }) => {
        const img = new Image();
        img.src = image;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const s = img.naturalWidth / 1280;
        return pts.map(([x, y]) => Array.from(g.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data.slice(0, 3)));
      }, { image, pts: items.map((t) => [t.rect[0] + t.rect[2] - 3, t.rect[1] + t.rect[3] / 2]) });

      items.forEach((t, k) => {
        const cat = t.category;
        bump(cat, "total");
        const cov = coverage(t.rect, boxes);
        const isCovered = cov >= 0.9;
        const isBlack = pix[k].every((c) => c < 40);
        let leaked = false;
        if (t.value && payload) {
          leaked = json.includes(t.value) || jsonFlat.includes(norm(t.value)) || (digits(t.value).length >= 9 && json.includes(digits(t.value)));
        }
        if (isCovered) bump(cat, "covered");
        if (isBlack) bump(cat, "black");
        if (leaked) bump(cat, "leaked");
        if (guard.blocked) bump(cat, "blocked");
        if (STRUCTURED.has(cat) && (!isCovered || !isBlack || leaked)) {
          misses.push({ page: `${site}/${name}${qs}`, category: cat, value: t.value, coverage: +cov.toFixed(2), black: isBlack, leaked, guardBlocked: guard.blocked });
        }
      });
    }
  }
}
await ctx.close();

mkdirSync("reports", { recursive: true });
let sTotal = 0, sCovered = 0, sBlack = 0, sLeak = 0;
console.log(`captures: ${captures}  (pages ${PAGES.length} x variants ${VARIANTS.length} x personas ${N}); leak-guard blocked: ${blockedCaptures}`);
console.log("category   total  covered(>=90%)  black-pixel  leaked-in-JSON");
for (const [cat, s] of Object.entries(stats).sort()) {
  const mark = STRUCTURED.has(cat) ? "" : "  (not in scope until Phase 5)";
  console.log(`${cat.padEnd(10)} ${String(s.total).padStart(5)}  ${((100 * s.covered) / s.total).toFixed(1).padStart(8)}%      ${((100 * s.black) / s.total).toFixed(1).padStart(6)}%     ${s.leaked}${mark}`);
  if (STRUCTURED.has(cat)) { sTotal += s.total; sCovered += s.covered; sBlack += s.black; sLeak += s.leaked; }
}
const recall = sCovered / sTotal;
console.log(`\nSTRUCTURED PII recall: ${(100 * recall).toFixed(2)}% (${sCovered}/${sTotal}) | black pixels: ${((100 * sBlack) / sTotal).toFixed(2)}% | leaked values in outgoing JSON: ${sLeak}`);
if (misses.length) {
  console.log(`\nmisses (${misses.length}), first 15:`);
  for (const m of misses.slice(0, 15)) console.log("  ", JSON.stringify(m));
}
writeFileSync("reports/phase4_recall.json", JSON.stringify({ captures, blockedCaptures, stats, misses }, null, 2));
const ok = recall >= 0.98 && sLeak === 0;
console.log(ok ? "\nPHASE4 OK (recall >= 98%, no leaks)" : "\nPHASE4 FAIL");
process.exit(ok ? 0 : 1);
