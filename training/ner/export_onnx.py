"""Export the fine-tuned NER checkpoint to the layout Transformers.js expects, int8 for WASM.

  python export_onnx.py runs/ner-in ../../extension/public/models/PrivaSight/bert-ner-in

Writes <out>/{config.json,tokenizer*.json,special_tokens_map.json,onnx/model_quantized.onnx}. Then checks that the int8 model
agrees with the PyTorch one on the held-out sets (word recall of person names), because quantisation can cost accuracy.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import numpy as np
import torch
from onnxruntime import InferenceSession
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForTokenClassification, AutoTokenizer

from train_ner import load, score


def main(src: str, out: str) -> None:
    out_dir, onnx_dir = Path(out), Path(out) / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(src)
    model = AutoModelForTokenClassification.from_pretrained(src).eval()
    model.config.save_pretrained(out_dir)
    tok.save_pretrained(out_dir)
    sample = tok(["Welcome back, Anjali Menon"], return_tensors="pt")
    full = onnx_dir / "model.onnx"
    torch.onnx.export(model, (sample["input_ids"], sample["attention_mask"], sample["token_type_ids"]), str(full), input_names=["input_ids", "attention_mask", "token_type_ids"],
                      output_names=["logits"], dynamic_axes={k: {0: "batch", 1: "seq"} for k in ("input_ids", "attention_mask", "token_type_ids", "logits")},
                      opset_version=17, dynamo=False)
    quantize_dynamic(str(full), str(onnx_dir / "model_quantized.onnx"), weight_type=QuantType.QInt8)
    full.unlink()
    print("size MB:", round((onnx_dir / "model_quantized.onnx").stat().st_size / 1e6, 1))

    sess = InferenceSession(str(onnx_dir / "model_quantized.onnx"), providers=["CPUExecutionProvider"])
    id2label = model.config.id2label
    for name in ("test_heldout", "test_hard", "test_negatives"):
        rows = load(name)[:600]
        preds = []
        for r in rows:
            enc = tok(r["words"], is_split_into_words=True, truncation=True, max_length=64, return_tensors="np")
            logits = sess.run(None, {k: enc[k].astype(np.int64) for k in ("input_ids", "attention_mask", "token_type_ids")})[0][0]
            tags, seen = ["O"] * len(r["words"]), set()
            for k, w in enumerate(enc.word_ids(0)):
                if w is not None and w not in seen:
                    seen.add(w)
                    tags[w] = id2label[int(logits[k].argmax())]
            preds.append(tags)
        print(name, "int8:", score(rows, preds))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
