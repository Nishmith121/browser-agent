// Copies WASM runtimes from node_modules and downloads the ML models into public/ so the extension
// loads everything locally (no network at runtime; nothing leaves the device).   npm run assets
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const pub = (p) => join("public", p);
const mb = (f) => (statSync(f).size / 1e6).toFixed(1) + " MB";

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log("copied  ", to, mb(to));
}

async function download(url, to) {
  if (existsSync(to) && statSync(to).size > 0) return console.log("have    ", to, mb(to));
  mkdirSync(dirname(to), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  writeFileSync(to, Buffer.from(await r.arrayBuffer()));
  console.log("fetched ", to, mb(to));
}

// ONNX Runtime Web (used by Transformers.js): WebGPU (jsep) and plain WASM builds.
const ort = "node_modules/onnxruntime-web/dist";
for (const f of [
  "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", // plain WASM (CPU)
  "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm", // WebGPU
  "ort-wasm-simd-threaded.jspi.mjs", "ort-wasm-simd-threaded.jspi.wasm", // WebGPU with JSPI
  "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm",
]) {
  copy(join(ort, f), pub(`ort/${f}`));
}

// MediaPipe Tasks Vision runtime + BlazeFace short-range face detector (Apache-2.0).
for (const f of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) {
  copy(join("node_modules/@mediapipe/tasks-vision/wasm", f), pub(`mediapipe/wasm/${f}`));
}
await download(
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
  pub("mediapipe/blaze_face_short_range.tflite"),
);

// NER: Xenova/bert-base-NER (MIT): int8 for WASM, fp16 for WebGPU (int8 ops fall back to CPU on WebGPU).
const hf = "https://huggingface.co/Xenova/bert-base-NER/resolve/main";
for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx", "onnx/model_fp16.onnx"]) {
  await download(`${hf}/${f}`, pub(`models/Xenova/bert-base-NER/${f}`));
}

// OCR fallback: Tesseract.js worker + core + English "fast" traineddata (Apache-2.0).
copy("node_modules/tesseract.js/dist/worker.min.js", pub("tesseract/worker.min.js"));
for (const f of [
  "tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm",
  "tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm",
]) {
  copy(join("node_modules/tesseract.js-core", f), pub(`tesseract/${f}`));
}
await download("https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz", pub("tesseract/eng.traineddata.gz"));

// Phase 8 NER (bert-base-NER fine-tuned on Indian names). It is produced by training/ner/export_onnx.py, which writes it
// straight into public/models/PrivaSight/bert-ner-in. If you published that folder (for example as a Hugging Face model repo),
// set PRIVASIGHT_NER_URL to its file base URL to download it instead of retraining:
//   PRIVASIGHT_NER_URL=https://huggingface.co/<user>/privasight-bert-ner-in/resolve/main npm run assets
// Without it the extension falls back to Xenova/bert-base-NER (the Phase 5 model) at runtime.
const nerDir = pub("models/PrivaSight/bert-ner-in");
if (process.env.PRIVASIGHT_NER_URL) {
  for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]) {
    await download(`${process.env.PRIVASIGHT_NER_URL.replace(/\/$/, "")}/${f}`, join(nerDir, f));
  }
} else if (existsSync(join(nerDir, "onnx/model_quantized.onnx"))) {
  console.log("have    ", nerDir, "(fine-tuned NER, Phase 8)");
} else {
  console.log("note     fine-tuned NER not found: the extension will use Xenova/bert-base-NER. To get it, run training/ner",
    "(gen_ner_data.py, train_ner.py, export_onnx.py) or set PRIVASIGHT_NER_URL.");
}
console.log("assets ready");
