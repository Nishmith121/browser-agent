import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import type { Box } from "../shared/types";

/** Layer C: MediaPipe BlazeFace (short range). Runs entirely on-device from local files. */

const MIN_CONFIDENCE = 0.5; // tune in eval
const EXPAND = 0.15; // widen each box by 15%
const FULL_MAX_SIDE = 640; // downscale the full screenshot for speed

let detector: FaceDetector | null = null;
export let faceDelegate: "GPU" | "CPU" = "CPU";

export async function initFaces(base: string, prefer: "GPU" | "CPU"): Promise<void> {
  const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
  const make = (delegate: "GPU" | "CPU") =>
    FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}mediapipe/blaze_face_short_range.tflite`, delegate },
      runningMode: "IMAGE",
      minDetectionConfidence: MIN_CONFIDENCE,
    });
  try {
    detector = await make(prefer);
    faceDelegate = prefer;
  } catch (e) {
    console.warn("[faces] GPU delegate unavailable, using CPU:", e);
    detector = await make("CPU");
    faceDelegate = "CPU";
  }
}

function run(source: OffscreenCanvas): Box[] {
  const res = detector!.detect(source as unknown as HTMLCanvasElement);
  return res.detections.flatMap((d) => (d.boundingBox ? [[d.boundingBox.originX, d.boundingBox.originY, d.boundingBox.width, d.boundingBox.height] as Box] : []));
}

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

function merge(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    const i = out.findIndex((o) => iou(o, b) > 0.3);
    if (i >= 0) out[i] = union(out[i], b);
    else out.push(b);
  }
  return out;
}

/**
 * Faces in screenshot pixels. Two passes: the whole screenshot (downscaled), then each image/video
 * crop upscaled, because a face in a 150 px photo is tiny in a 1280 px screenshot.
 */
export function detectFaces(shot: ImageBitmap, mediaPx: Box[]): Box[] {
  const found: Box[] = [];

  const k = Math.min(1, FULL_MAX_SIDE / Math.max(shot.width, shot.height));
  const full = new OffscreenCanvas(Math.round(shot.width * k), Math.round(shot.height * k));
  full.getContext("2d")!.drawImage(shot, 0, 0, full.width, full.height);
  for (const [x, y, w, h] of run(full)) found.push([x / k, y / k, w / k, h / k]);

  for (const [mx, my, mw, mh] of mediaPx) {
    if (mw < 40 || mh < 40) continue;
    const up = Math.min(2.5, Math.max(1, 256 / Math.min(mw, mh)));
    const c = new OffscreenCanvas(Math.round(mw * up), Math.round(mh * up));
    c.getContext("2d")!.drawImage(shot, mx, my, mw, mh, 0, 0, c.width, c.height);
    for (const [x, y, w, h] of run(c)) found.push([mx + x / up, my + y / up, w / up, h / up]);
  }

  return merge(found).map(([x, y, w, h]) => {
    const dx = w * EXPAND, dy = h * EXPAND;
    return [Math.max(0, x - dx), Math.max(0, y - dy), w + 2 * dx, h + 2 * dy] as Box;
  });
}
