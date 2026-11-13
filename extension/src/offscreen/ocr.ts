import { createWorker, type Worker } from "tesseract.js";
import type { Box } from "../shared/types";

/** OCR fallback (Tesseract.js, local files): only for <img>/<canvas> regions, since normal text is read from the DOM. */

export interface OcrWord {
  text: string;
  bbox: Box; // screenshot px
}

export interface OcrLine {
  text: string; // words joined by single spaces
  words: (OcrWord & { start: number; end: number })[]; // offsets into `text`
}

let worker: Worker | null = null;
let starting: Promise<void> | null = null;
const cache = new Map<string, OcrLine[]>(); // pixel hash -> lines (unchanged images are not re-read)

export function initOcr(base: string): Promise<void> {
  starting ??= (async () => {
    worker = await createWorker("eng", 1, {
      workerPath: `${base}tesseract/worker.min.js`,
      corePath: `${base}tesseract`,
      langPath: `${base}tesseract`,
      workerBlobURL: false, // blob: workers are blocked by the extension CSP
      cacheMethod: "none",
      gzip: true,
    });
  })();
  return starting;
}

/** 16x16 grayscale fingerprint of the crop (plus size) for the cache. */
function fingerprint(c: OffscreenCanvas): string {
  const s = new OffscreenCanvas(16, 16);
  const g = s.getContext("2d")!;
  g.drawImage(c, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  let h = "";
  for (let i = 0; i < d.length; i += 4) h += ((d[i] + d[i + 1] + d[i + 2]) / 3 >> 4).toString(16);
  return `${c.width}x${c.height}:${h}`;
}

function collectLines(blocks: any[] | null | undefined): any[] {
  const lines: any[] = [];
  for (const b of blocks ?? []) for (const p of b.paragraphs ?? []) lines.push(...(p.lines ?? []));
  return lines;
}

/** Lines of text found inside each box (screenshot px). */
export async function ocrBoxes(shot: ImageBitmap, boxes: Box[]): Promise<OcrLine[]> {
  await initOcr(chrome.runtime.getURL(""));
  const out: OcrLine[] = [];
  for (const [bx, by, bw, bh] of boxes) {
    const up = bh < 80 ? 2 : 1; // small text reads better enlarged
    const c = new OffscreenCanvas(Math.max(1, Math.round(bw * up)), Math.max(1, Math.round(bh * up)));
    c.getContext("2d")!.drawImage(shot, bx, by, bw, bh, 0, 0, c.width, c.height);
    const key = fingerprint(c);
    let lines = cache.get(key);
    if (!lines) {
      const blob = await c.convertToBlob({ type: "image/png" });
      const res = await worker!.recognize(blob, {}, { blocks: true });
      lines = collectLines((res.data as any).blocks).flatMap((ln: any): OcrLine[] => {
        const words = (ln.words ?? []).filter((w: any) => w.text?.trim() && w.confidence > 30);
        if (!words.length) return [];
        let text = "";
        const placed = words.map((w: any) => {
          const start = text.length + (text ? 1 : 0);
          text += (text ? " " : "") + w.text.trim();
          return { text: w.text.trim(), start, end: text.length, bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0] as Box };
        });
        return [{ text, words: placed }];
      });
      cache.set(key, lines);
      if (cache.size > 100) cache.delete(cache.keys().next().value!);
    }
    for (const ln of lines) {
      out.push({
        text: ln.text,
        words: ln.words.map((w) => ({ ...w, bbox: [bx + w.bbox[0] / up, by + w.bbox[1] / up, w.bbox[2] / up, w.bbox[3] / up] as Box })),
      });
    }
  }
  return out;
}
