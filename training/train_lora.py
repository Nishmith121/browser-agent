"""Redaction-aware LoRA fine-tune of Qwen3-VL (Section 9.1). Run it on a GPU machine (the lab GPU).

  python train_lora.py --data data/final_redacted --model Qwen/Qwen3-VL-4B-Instruct --out runs/privasight-4b
  python train_lora.py --data data/final_redacted --dry-run        # data pipeline only: no model, no GPU

Recipe (from the plan): LoRA rank 16, alpha 32, dropout 0.05 on the language model's attention and MLP projections,
vision encoder frozen, bf16 (fp16 on T4/P100), learning rate 1e-4, 2-3 epochs, effective batch 16 (per-device 1 x gradient accumulation),
QLoRA (4-bit) automatically when the GPU has less than 24 GB. Only the assistant turn (the action JSON) is trained on.
Split by website is already done by build_dataset.py (train.jsonl / test.jsonl).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Language-model projections only (the vision tower and the merger are not matched, so they stay frozen).
LORA_TARGET_REGEX = r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)"


def _ds(rows):
    from datasets import Dataset
    return Dataset.from_dict({"sample": [json.dumps(r) for r in rows]})


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def split_messages(sample: dict) -> tuple[list[dict], str]:
    """(system+user messages for the prompt, assistant text)."""
    *prompt, assistant = sample["messages"]
    assert assistant["role"] == "assistant"
    return prompt, assistant["content"]


class Collator:
    """Builds a batch with the model's own processor; labels are -100 everywhere except the assistant answer."""

    def __init__(self, processor, data_dir: Path, max_length: int = 4096):
        self.processor, self.dir, self.max_length = processor, data_dir, max_length

    def __call__(self, batch: list[dict]):
        import torch
        from PIL import Image

        batch = [json.loads(s["sample"]) if "sample" in s else s for s in batch]
        images = [Image.open(self.dir / s["image"]).convert("RGB") for s in batch]
        prompts, fulls = [], []
        for s in batch:
            prompt, answer = split_messages(s)
            p = self.processor.apply_chat_template(prompt, add_generation_prompt=True, tokenize=False)
            prompts.append(p)
            fulls.append(p + answer + "<|im_end|>\n")
        # the same images go through both calls, so the expanded image tokens (and the prompt lengths) agree
        full = self.processor(text=fulls, images=images, padding=True, truncation=False, return_tensors="pt")
        prompt_only = self.processor(text=prompts, images=images, padding=True, truncation=False, return_tensors="pt")
        labels = full["input_ids"].clone()
        labels[full["attention_mask"] == 0] = -100
        prompt_lens = prompt_only["attention_mask"].sum(dim=1)
        for i, n in enumerate(prompt_lens.tolist()):
            labels[i, :n] = -100  # right padding: the prompt occupies the first n positions
        full["labels"] = labels
        if full["input_ids"].shape[1] > self.max_length:
            raise ValueError(f"sequence of {full['input_ids'].shape[1]} tokens exceeds max_length={self.max_length}; lower --max-pixels")
        return full


def dry_run(args, train: list[dict]) -> None:
    from transformers import AutoProcessor

    processor = AutoProcessor.from_pretrained(args.model)
    set_pixels(processor, args.max_pixels)
    col = Collator(processor, Path(args.data), args.max_length)
    batch = col(train[: min(2, len(train))])
    ids, labels = batch["input_ids"], batch["labels"]
    print("batch shapes:", {k: tuple(v.shape) for k, v in batch.items() if hasattr(v, "shape")})
    for i in range(ids.shape[0]):
        n_all, n_sup = int((batch["attention_mask"][i] == 1).sum()), int((labels[i] != -100).sum())
        sup = processor.tokenizer.decode(ids[i][labels[i] != -100])
        print(f"sample {i}: {n_all} tokens, {n_sup} supervised ({100 * n_sup / n_all:.1f}%)")
        print("  supervised text:", repr(sup))
        assert sup.strip().startswith("{") and sup.strip().endswith("<|im_end|>"), "the supervised span must be exactly the action JSON"
    lens = []
    for s in train[:20]:
        lens.append(int(Collator(processor, Path(args.data), args.max_length)([s])["input_ids"].shape[1]))
    print(f"sequence length over {len(lens)} samples: min {min(lens)}, max {max(lens)}, mean {sum(lens) / len(lens):.0f}")
    print("dry run OK")


def set_pixels(processor, max_pixels: int) -> None:
    """Cap the number of image tokens (a 1280x720 screenshot is about 900 tokens at the default)."""
    try:
        processor.image_processor.size = {"longest_edge": max_pixels, "shortest_edge": 64 * 64}
    except Exception:  # noqa: BLE001 - different processors expose this differently
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="dataset directory from build_dataset.py")
    ap.add_argument("--model", default="Qwen/Qwen3-VL-4B-Instruct")
    ap.add_argument("--out", default="runs/privasight")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--effective-batch", type=int, default=16)
    ap.add_argument("--per-device-batch", type=int, default=1)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--alpha", type=int, default=32)
    ap.add_argument("--dropout", type=float, default=0.05)
    ap.add_argument("--max-pixels", type=int, default=1280 * 720)
    ap.add_argument("--max-length", type=int, default=4096)
    ap.add_argument("--qlora", choices=["auto", "yes", "no"], default="auto")
    ap.add_argument("--precision", choices=["auto", "bf16", "fp16"], default="auto", help="auto: bf16 where supported, else fp16 (Kaggle T4/P100)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-steps", type=int, default=-1, help="smoke test: stop after N optimizer steps")
    ap.add_argument("--limit", type=int, default=0, help="smoke test: use only the first N train/test samples")
    args = ap.parse_args()

    data = Path(args.data)
    train = load_jsonl(data / "train.jsonl")[: args.limit or None]
    if args.dry_run:
        return dry_run(args, train)

    import torch
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import AutoModelForImageTextToText, AutoProcessor, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    vram_gb = torch.cuda.get_device_properties(0).total_memory / 2**30 if torch.cuda.is_available() else 0
    qlora = args.qlora == "yes" or (args.qlora == "auto" and vram_gb < 24)
    print(f"GPU memory {vram_gb:.0f} GB -> {'QLoRA (4-bit)' if qlora else 'bf16 LoRA'}")

    processor = AutoProcessor.from_pretrained(args.model)
    set_pixels(processor, args.max_pixels)
    # bf16 needs an Ampere-or-newer GPU. Kaggle's T4 / P100 and Colab's T4 only do fp16, so fall back to it there.
    use_bf16 = args.precision == "bf16" or (args.precision == "auto" and torch.cuda.is_available() and torch.cuda.get_device_capability(0)[0] >= 8)
    dtype = torch.bfloat16 if use_bf16 else torch.float16
    print(f"precision: {'bf16' if use_bf16 else 'fp16'}")
    # one GPU keeps it simple and avoids cross-GPU copies of the small LoRA model (Kaggle offers 2 x T4)
    kw = dict(dtype=dtype, device_map={"": 0} if torch.cuda.is_available() else "auto", attn_implementation="sdpa")
    if qlora:
        kw["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype, bnb_4bit_use_double_quant=True)
    model = AutoModelForImageTextToText.from_pretrained(args.model, **kw)
    if qlora:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=args.alpha, lora_dropout=args.dropout, target_modules=LORA_TARGET_REGEX, task_type="CAUSAL_LM"))
    for p in model.parameters():
        if p.requires_grad:
            p.data = p.data.float()  # fp16 AMP needs fp32 trainable weights
    model.print_trainable_parameters()

    accum = max(1, args.effective_batch // (args.per_device_batch * max(1, torch.cuda.device_count())))
    # transformers 5 removed warmup_ratio; its warmup_steps takes a fraction (< 1) instead. Older versions need warmup_ratio.
    import dataclasses
    cfg_fields = {f.name for f in dataclasses.fields(SFTConfig)}
    warmup = {"warmup_ratio": 0.03} if "warmup_ratio" in cfg_fields else {"warmup_steps": 0.03}
    cfg = SFTConfig(
        output_dir=args.out, num_train_epochs=args.epochs, learning_rate=args.lr, lr_scheduler_type="cosine", **warmup,
        per_device_train_batch_size=args.per_device_batch, gradient_accumulation_steps=accum,
        bf16=use_bf16, fp16=not use_bf16, gradient_checkpointing=True, gradient_checkpointing_kwargs={"use_reentrant": False},
        optim="paged_adamw_8bit" if qlora else "adamw_torch", logging_steps=5, save_strategy="epoch", seed=args.seed,
        remove_unused_columns=False, dataset_kwargs={"skip_prepare_dataset": True}, report_to="none", max_steps=args.max_steps,
        eval_strategy="epoch" if (data / "test.jsonl").exists() else "no",
    )
    test = load_jsonl(data / "test.jsonl")[: args.limit or None] if (data / "test.jsonl").exists() else None
    trainer = SFTTrainer(model=model, args=cfg, train_dataset=_ds(train), eval_dataset=_ds(test) if test else None, data_collator=Collator(processor, data, args.max_length), processing_class=processor)
    if not use_bf16:  # TRL casts QLoRA adapters to bf16 in SFTTrainer.__init__; fp16 AMP (T4/P100) needs fp32 trainable weights
        for p in trainer.model.parameters():
            if p.requires_grad:
                p.data = p.data.float()
    trainer.train()
    trainer.save_model(args.out)
    (Path(args.out) / "training_meta.json").write_text(json.dumps({"args": vars(args), "qlora": qlora, "train_samples": len(train), "test_samples": len(test or []),
                                                                  "dataset_stats": json.loads((data / "stats.json").read_text()) if (data / "stats.json").exists() else None}, indent=2))
    print(f"adapter saved to {args.out}")


if __name__ == "__main__":
    sys.exit(main())
