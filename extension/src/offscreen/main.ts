import { detectPII } from "../redaction/regex";
import type { Box, Category, Detected, MediaBox } from "../shared/types";
import { detectFaces, faceDelegate, initFaces } from "./faces";
import { initNer, nerDevice, nerModel, recognise, tuning, type NerEntity } from "./ner";
import { initOcr, ocrBoxes } from "./ocr";

/**
 * Offscreen document: the only place ML runs (service workers have no WebGPU/canvas worth using).
 * Everything here stays on the device; the raw screenshot arrives from the background worker and
 * only boxes and entity offsets are returned.
 */

export interface MlRequest {
  target: "offscreen";
  type: "ml:run";
  raw: string; // raw screenshot data URL (local only)
  viewportWidth: number;
  media: MediaBox[]; // <img>/<video>/<canvas> boxes, CSS px
  /** `skip`: the regex layer already covers this text, so the model need not score it. */
  texts: { id: number; text: string; skip?: boolean }[];
  config?: MlConfig;
}

export interface MlResult {
  faces: Box[]; // CSS px
  ner: { id: number; entities: NerEntity[] }[];
  /** PII read out of images/canvases by OCR, as boxes (CSS px). */
  ocr: { category: Category; bbox: Box }[];
  backend: { ner: string; face: string; nerModel?: string };
  timingMs: Record<string, number>;
  nerStats: { nodes: number; cacheHits: number; chunks: number };
}

export interface MlConfig {
  nerDevice?: "webgpu" | "wasm";
  faceDelegate?: "GPU" | "CPU";
  nerMinScore?: Partial<Record<string, number>>;
  nerDebugAll?: boolean;
  /** Disable OCR (it only runs for images/canvases without a face). */
  ocr?: boolean;
}

const base = chrome.runtime.getURL("");
const OCR_ID = 2_000_000; // text id offset for OCR lines sent to the NER model
const OCR_MAX_REGIONS = 3; // OCR is the slowest detector: at most this many images per step

// Offscreen documents only get chrome.runtime, so the config arrives in the first message.
// NER defaults to WASM/int8: measured faster at p95 and no shader warm-up than WebGPU/fp16 (docs/PROGRESS.md).
let readyP: Promise<void> | null = null;
function ensureReady(cfg: MlConfig = {}): Promise<void> {
  readyP ??= (async () => {
    const t0 = performance.now();
    await Promise.all([initFaces(base, cfg.faceDelegate ?? "GPU"), initNer(base, cfg.nerDevice ?? "wasm")]);
    console.log(`[ml] ready in ${Math.round(performance.now() - t0)} ms (ner=${nerModel} on ${nerDevice}, face=${faceDelegate})`);
    void initOcr(base).catch((e) => console.warn("[ocr] init failed", e)); // loaded in the background, awaited only if needed
  })();
  return readyP;
}

const inside = (face: Box, box: Box) => {
  const cx = face[0] + face[2] / 2, cy = face[1] + face[3] / 2;
  return cx >= box[0] && cx <= box[0] + box[2] && cy >= box[1] && cy <= box[1] + box[3];
};

/** Detections in OCR lines -> word boxes (screenshot px). Regex first, then the NER model on the line text. */
async function ocrRegions(shot: ImageBitmap, targets: Box[]): Promise<{ category: Category; bbox: Box }[]> {
  const lines = await ocrBoxes(shot, targets);
  const { byId } = await recognise(lines.map((l, i) => ({ id: OCR_ID + i, text: l.text })));
  const out: { category: Category; bbox: Box }[] = [];
  lines.forEach((ln, i) => {
    const spans: Detected[] = [...detectPII(ln.text)];
    for (const e of byId.get(OCR_ID + i) ?? []) {
      if (!spans.some((s) => e.start < s.end && s.start < e.end)) spans.push({ start: e.start, end: e.end, category: e.category, value: e.value });
    }
    for (const s of spans) {
      // One box per detection (the union of its words), so spaces inside e.g. an Aadhaar number are covered too.
      const hit = ln.words.filter((w) => w.start < s.end && s.start < w.end);
      if (!hit.length) continue;
      const x1 = Math.min(...hit.map((w) => w.bbox[0])), y1 = Math.min(...hit.map((w) => w.bbox[1]));
      const x2 = Math.max(...hit.map((w) => w.bbox[0] + w.bbox[2])), y2 = Math.max(...hit.map((w) => w.bbox[1] + w.bbox[3]));
      out.push({ category: s.category, bbox: [x1, y1, x2 - x1, y2 - y1] });
    }
  });
  return out;
}

async function run(m: MlRequest): Promise<MlResult> {
  await ensureReady(m.config);
  tuning.minScore = m.config?.nerMinScore;
  tuning.debugAll = m.config?.nerDebugAll;
  const t: Record<string, number> = {};
  const lap = (k: string, from: number) => (t[k] = Math.round(performance.now() - from));

  let t0 = performance.now();
  const shot = await createImageBitmap(await (await fetch(m.raw)).blob());
  const scale = shot.width / m.viewportWidth; // screenshot px per CSS px
  const toPx = ([x, y, w, h]: Box) => [x * scale, y * scale, w * scale, h * scale] as Box;
  const toCss = ([x, y, w, h]: Box) => [x / scale, y / scale, w / scale, h / scale] as Box;
  lap("decode", t0);

  t0 = performance.now();
  const facesPx = detectFaces(shot, m.media.map((b) => toPx(b.bbox)));
  lap("face", t0);

  t0 = performance.now();
  const { byId, stats } = await recognise(m.texts);
  lap("ner", t0);

  // OCR: canvases and images that hold no face (a photo has no text to read).
  let ocr: MlResult["ocr"] = [];
  const targets = m.config?.ocr === false
    ? []
    : m.media
        .filter((b) => (b.kind === "canvas" || b.kind === "img") && b.bbox[2] >= 60 && b.bbox[3] >= 24)
        .map((b) => toPx(b.bbox))
        .filter((px) => !facesPx.some((f) => inside(f, px)))
        .sort((a, b) => b[2] * b[3] - a[2] * a[3])
        .slice(0, OCR_MAX_REGIONS);
  if (targets.length) {
    t0 = performance.now();
    // OCR word boxes are tight around the glyphs: pad them so ascenders/descenders and small misalignments stay covered.
    ocr = (await ocrRegions(shot, targets)).map((r) => {
      const [x, y, w, h] = toCss(r.bbox);
      return { category: r.category, bbox: [x - 5, y - 6, w + 10, h + 12] as Box };
    });
    lap("ocr", t0);
  }
  shot.close();

  return {
    faces: facesPx.map(toCss),
    ner: [...byId].map(([id, entities]) => ({ id, entities })),
    ocr,
    backend: { ner: nerDevice, face: faceDelegate, nerModel },
    timingMs: t,
    nerStats: { nodes: stats.nodes, cacheHits: stats.cacheHits, chunks: stats.chunks },
  };
}

chrome.runtime.onMessage.addListener((msg: MlRequest | { target: "offscreen"; type: "ml:init"; config?: MlConfig }, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  if (msg.type === "ml:init") {
    ensureReady(msg.config).then(
      () => sendResponse({ ok: true, backend: { ner: nerDevice, face: faceDelegate, nerModel } }),
      (e) => sendResponse({ ok: false, error: String(e) }),
    );
    return true;
  }
  run(msg).then(
    (r) => sendResponse({ ok: true, result: r }),
    (e) => sendResponse({ ok: false, error: String(e) }),
  );
  return true;
});
