"""Fine-tune bert-base-NER on the Indian-name data, and evaluate any NER checkpoint on the held-out sets.

  python train_ner.py --out runs/ner-in --epochs 3
  python train_ner.py --eval-only dslim/bert-base-NER            # the model the extension ships today
  python train_ner.py --eval-only runs/ner-in

Reported per test set (person names only):
  word recall   fraction of name words tagged as a person (what redaction needs: an untagged word stays visible)
  exact P/R/F1  entity spans that match exactly
  false rows    fraction of rows with no name in which a person was predicted (over-redaction)
Prediction uses the first word-piece of each word, which is how the base model was trained.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parent.parent / "data" / "ner"
LABELS = ["O", "B-MISC", "I-MISC", "B-PER", "I-PER", "B-ORG", "I-ORG", "B-LOC", "I-LOC"]  # dslim/bert-base-NER order
L2I = {l: i for i, l in enumerate(LABELS)}


def load(name: str) -> list[dict]:
    return [json.loads(x) for x in (DATA / f"{name}.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]


def encode(tok, rows, max_len=64):
    enc = tok([r["words"] for r in rows], is_split_into_words=True, truncation=True, max_length=max_len)
    feats = []
    for i, r in enumerate(rows):
        labels, prev = [], None
        for w in enc.word_ids(i):
            if w is None:
                labels.append(-100)
            else:
                tag = r["tags"][w]
                if w == prev and tag.startswith("B-"):  # continuation word-pieces of an entity word are I-
                    tag = "I-" + tag[2:]
                labels.append(L2I[tag])
            prev = w
        feats.append({"input_ids": enc["input_ids"][i], "attention_mask": enc["attention_mask"][i], "labels": labels})
    return feats


def spans(tags: list[str], kind: str = "PER") -> set[tuple[int, int]]:
    out, start = set(), None
    for i, t in enumerate(tags + ["O"]):
        if start is not None and t != f"I-{kind}":
            out.add((start, i))
            start = None
        if t == f"B-{kind}" or (t == f"I-{kind}" and start is None):
            start = i
    return out


def predict_words(model, tok, rows, device, bs=64):
    import torch

    preds = []
    for i in range(0, len(rows), bs):
        chunk = rows[i:i + bs]
        enc = tok([r["words"] for r in chunk], is_split_into_words=True, truncation=True, max_length=64, padding=True, return_tensors="pt").to(device)
        with torch.no_grad():
            ids = model(**enc).logits.argmax(-1).cpu().numpy()
        for j, r in enumerate(chunk):
            out, seen = ["O"] * len(r["words"]), set()
            for k, w in enumerate(enc.word_ids(j)):
                if w is not None and w not in seen:
                    seen.add(w)
                    out[w] = model.config.id2label[int(ids[j][k])]
            preds.append(out)
    return preds


def score(rows, preds):
    gold_words = hit_words = tp = n_pred = n_gold = fr = neg = 0
    for r, p in zip(rows, preds):
        g = r["tags"]
        is_per = lambda t: t.endswith("-PER")
        gw = [i for i, t in enumerate(g) if is_per(t)]
        gold_words += len(gw)
        hit_words += sum(is_per(p[i]) for i in gw)
        gs, ps = spans(g), spans(p)
        tp += len(gs & ps)
        n_pred += len(ps)
        n_gold += len(gs)
        if not gw:
            neg += 1
            fr += any(is_per(t) for t in p)
    prec = tp / n_pred if n_pred else 0.0
    rec = tp / n_gold if n_gold else 0.0
    return {"word_recall": round(hit_words / gold_words, 4) if gold_words else None, "exact_p": round(prec, 4), "exact_r": round(rec, 4),
            "exact_f1": round(2 * prec * rec / (prec + rec), 4) if prec + rec else 0.0, "false_rows": round(fr / neg, 4) if neg else None, "n": len(rows)}


def evaluate(model_path: str, device: str) -> dict:
    from transformers import AutoModelForTokenClassification, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_path)
    model = AutoModelForTokenClassification.from_pretrained(model_path).to(device).eval()
    res = {}
    for name in ("val", "test_heldout", "test_hard", "test_negatives"):
        rows = load(name)
        res[name] = score(rows, predict_words(model, tok, rows, device))
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="dslim/bert-base-NER")
    ap.add_argument("--out", default="runs/ner-in")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--eval-only", default=None, help="evaluate this model/checkpoint and exit")
    a = ap.parse_args()

    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if a.eval_only:
        res = evaluate(a.eval_only, device)
        print(json.dumps(res, indent=1))
        return

    from transformers import AutoModelForTokenClassification, AutoTokenizer, DataCollatorForTokenClassification, Trainer, TrainingArguments

    tok = AutoTokenizer.from_pretrained(a.base)
    model = AutoModelForTokenClassification.from_pretrained(a.base)
    assert [model.config.id2label[i] for i in range(len(LABELS))] == LABELS, model.config.id2label
    args = TrainingArguments(output_dir=a.out, num_train_epochs=a.epochs, learning_rate=a.lr, per_device_train_batch_size=a.batch, per_device_eval_batch_size=64,
                             weight_decay=0.01, warmup_steps=0.06, lr_scheduler_type="linear", eval_strategy="epoch", save_strategy="no", logging_steps=100,
                             fp16=torch.cuda.is_available(), report_to="none", seed=0)
    Trainer(model=model, args=args, train_dataset=encode(tok, load("train")), eval_dataset=encode(tok, load("val")),
            data_collator=DataCollatorForTokenClassification(tok)).train()
    model.save_pretrained(a.out)
    tok.save_pretrained(a.out)
    res = evaluate(a.out, device)
    (Path(a.out) / "eval.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
