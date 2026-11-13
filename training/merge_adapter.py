"""Merge a trained LoRA adapter into the base model (optional: vLLM can also serve the adapter with --enable-lora).

  python merge_adapter.py --base Qwen/Qwen3-VL-4B-Instruct --adapter runs/privasight-4b --out merged/privasight-4b
"""
import argparse


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    import torch
    from peft import PeftModel
    from transformers import AutoModelForImageTextToText, AutoProcessor

    model = AutoModelForImageTextToText.from_pretrained(a.base, torch_dtype=torch.bfloat16)  # merge in bf16, not 4-bit
    merged = PeftModel.from_pretrained(model, a.adapter).merge_and_unload()
    merged.save_pretrained(a.out)
    AutoProcessor.from_pretrained(a.base).save_pretrained(a.out)
    print(f"merged model saved to {a.out}")


if __name__ == "__main__":
    main()
