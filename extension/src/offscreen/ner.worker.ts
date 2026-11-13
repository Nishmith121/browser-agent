/// <reference lib="webworker" />
import { env, pipeline } from "@huggingface/transformers";
import { align } from "./align";

/** Person / location / organisation recogniser (BERT NER: fp16 on WebGPU, int8 on WASM) running on-device in a worker. */

type In =
  | { type: "init"; base: string; device: "webgpu" | "wasm" }
  | { type: "run"; id: number; texts: string[] };

// Phase 8: bert-base-NER fine-tuned on Indian names (training/ner, int8 only). "Xenova/bert-base-NER" is the Phase 5 model.
// The fine-tuned model is not downloadable (it is produced by training/ner/export_onnx.py), so a fresh clone that only ran
// `npm run assets` has just the Phase 5 model: fall back to it instead of failing every step.
const NER_MODELS = ["PrivaSight/bert-ner-in", "Xenova/bert-base-NER"];
let clf: any = null;
let device: "webgpu" | "wasm" = "wasm";
let model = "";

async function load(base: string, want: "webgpu" | "wasm"): Promise<void> {
  env.allowRemoteModels = false; // everything is local: nothing is fetched at runtime
  env.allowLocalModels = true;
  env.localModelPath = `${base}models/`;
  env.useBrowserCache = false;
  const wasm = env.backends.onnx.wasm!;
  wasm.wasmPaths = `${base}ort/`;
  wasm.numThreads = self.crossOriginIsolated ? 4 : 1;
  const errors: string[] = [];
  for (const name of NER_MODELS) {
    // WebGPU wants fp16 weights; WASM uses int8. A model without the wanted variant falls back to WASM.
    for (const dev of want === "webgpu" ? (["webgpu", "wasm"] as const) : (["wasm"] as const)) {
      try {
        clf = await pipeline("token-classification", name, { device: dev, dtype: dev === "webgpu" ? "fp16" : "q8" } as any);
        device = dev;
        model = name;
        if (errors.length) console.warn("[ner] using", name, "on", dev, "after:", errors.join(" | "));
        return;
      } catch (e) {
        errors.push(`${name}/${dev}: ${String(e).slice(0, 160)}`);
      }
    }
  }
  throw new Error(`no NER model could be loaded (${errors.join(" | ")}). Run \`npm run assets\` in extension/.`);
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      await load(m.base, m.device);
      (self as any).postMessage({ type: "ready", device, model });
    } else {
      const t0 = performance.now();
      const res: any[][] = await clf(m.texts, { ignore_labels: ["O"] });
      const entities = m.texts.map((t, i) => align(t, res[i] ?? []));
      (self as any).postMessage({ type: "result", id: m.id, entities, ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    (self as any).postMessage({ type: "error", id: (m as any).id, error: String(err) });
  }
};
