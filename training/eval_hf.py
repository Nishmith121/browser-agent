"""Offline step accuracy with the model loaded locally (no server): for Kaggle/Colab notebooks.

  python eval_hf.py --data data/final_clean    --model Qwen/Qwen3-VL-2B-Instruct --out results_base_clean.json
  python eval_hf.py --data data/final_redacted --model Qwen/Qwen3-VL-2B-Instruct --out results_base_redacted.json
  python eval_hf.py --data data/final_redacted --model Qwen/Qwen3-VL-2B-Instruct --adapter runs/privasight-2b --out results_lora_redacted.json

The three conditions of Section 9.1 on the held-out websites: base on clean screens, base on redacted screens,
LoRA on redacted screens. Same metrics as eval_offline.py (valid JSON, action type, element, exact match).
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from eval_offline import extract_json, score  # noqa: F401  (same parsing and scoring as the server-based evaluator)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--split", default="test")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-pixels", type=int, default=1280 * 720)
    ap.add_argument("--quant", choices=["4bit", "none"], default="4bit", help="4-bit keeps a 4B model inside a 16 GB GPU")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    import torch
    from PIL import Image
    from transformers import AutoModelForImageTextToText, AutoProcessor, BitsAndBytesConfig

    dtype = torch.bfloat16 if torch.cuda.get_device_capability(0)[0] >= 8 else torch.float16
    processor = AutoProcessor.from_pretrained(a.model)
    try:
        processor.image_processor.size = {"longest_edge": a.max_pixels, "shortest_edge": 64 * 64}
    except Exception:  # noqa: BLE001
        pass
    kw = dict(dtype=dtype, device_map={"": 0}, attn_implementation="sdpa")
    if a.quant == "4bit":
        kw["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype)
    model = AutoModelForImageTextToText.from_pretrained(a.model, **kw)
    if a.adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, a.adapter)
    model.eval()

    data = Path(a.data)
    samples = [json.loads(x) for x in (data / f"{a.split}.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    if a.limit:
        samples = samples[: a.limit]
    groups: dict[str, list[dict]] = defaultdict(list)
    for i, s in enumerate(samples):
        *prompt, answer = s["messages"]
        gold = json.loads(answer["content"])
        text = processor.apply_chat_template(prompt, add_generation_prompt=True, tokenize=False)
        image = Image.open(data / s["image"]).convert("RGB")
        batch = processor(text=[text], images=[image], return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(**batch, max_new_tokens=120, do_sample=False)
        reply = processor.tokenizer.decode(out[0][batch["input_ids"].shape[1]:], skip_special_tokens=True)
        r = score(reply, gold)
        for g in ("all", f"source:{s['source']}", f"site:{s['website']}"):
            groups[g].append(r)
        if (i + 1) % 20 == 0:
            print(f"{i + 1}/{len(samples)}  exact so far {sum(x['exact'] for x in groups['all']) / len(groups['all']):.3f}", flush=True)

    table = {g: {k: round(sum(r[k] for r in rs) / len(rs), 4) for k in ("valid", "type", "element", "exact")} | {"n": len(rs)} for g, rs in sorted(groups.items())}
    print(f"model={a.model} adapter={a.adapter} data={a.data} split={a.split}")
    print(f"{'group':<26}{'n':>5}  valid   type  element  exact")
    for g, m in table.items():
        print(f"{g:<26}{m['n']:>5}  {m['valid']:.3f}  {m['type']:.3f}  {m['element']:.3f}  {m['exact']:.3f}")
    if a.out:
        Path(a.out).write_text(json.dumps({"model": a.model, "adapter": a.adapter, "data": a.data, "split": a.split, "table": table}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
