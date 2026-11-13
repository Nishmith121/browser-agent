import type { InteractiveElement, Region } from "../shared/types";

const MAX_WIDTH = 1280;

/**
 * Paints redactions on a canvas copy of the screenshot, then draws Set-of-Marks boxes on top
 * (marks go on the redacted image, never the raw one). Runs in the service worker via
 * OffscreenCanvas; moves to the offscreen document in Phase 5.
 */
export async function paintRedacted(
  rawDataUrl: string,
  regions: Region[],
  elements: InteractiveElement[],
  viewportWidth: number,
): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(rawDataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const s = bitmap.width / viewportWidth; // screenshot px per CSS px

  // Faces and video: Gaussian blur (radius >= 12 px) of the region, sampled with padding so the edge blends.
  for (const r of regions.filter((g) => g.category === "FACE" || g.category === "VIDEO")) {
    const [x, y, w, h] = r.bbox.map((v) => v * s);
    const radius = Math.max(12, Math.round(Math.min(w, h) * 0.12));
    const pad = radius * 3;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = `blur(${radius}px)`;
    const sx = Math.max(0, x - pad), sy = Math.max(0, y - pad);
    const sw = Math.min(bitmap.width - sx, w + 2 * pad), sh = Math.min(bitmap.height - sy, h + 2 * pad);
    ctx.drawImage(bitmap, sx, sy, sw, sh, sx, sy, sw, sh);
    ctx.restore();
  }

  ctx.font = "bold 12px sans-serif";
  for (const r of regions.filter((g) => g.category !== "FACE" && g.category !== "VIDEO")) {
    const [x, y, w, h] = r.bbox.map((v) => v * s);
    ctx.fillStyle = "#000";
    ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(w), Math.ceil(h));
    if (h >= 14 && w >= 40) {
      ctx.fillStyle = "#fff";
      ctx.fillText(r.category, x + 4, y + h / 2 + 4, w - 8);
    }
  }

  ctx.font = "bold 14px sans-serif";
  for (const e of elements) {
    const [x, y, w, h] = e.bbox.map((v) => v * s);
    ctx.strokeStyle = "#e11d48";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    const tag = String(e.id);
    const tw = ctx.measureText(tag).width + 6;
    ctx.fillStyle = "#e11d48";
    ctx.fillRect(x, Math.max(0, y - 16), tw, 16);
    ctx.fillStyle = "#fff";
    ctx.fillText(tag, x + 3, Math.max(12, y - 3));
  }

  let out = canvas;
  if (canvas.width > MAX_WIDTH) { // screenshots go to the server at max 1280 px wide; actions use element ids, not pixels
    out = new OffscreenCanvas(MAX_WIDTH, Math.round((canvas.height * MAX_WIDTH) / canvas.width));
    out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
  }
  const blob = await out.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}
