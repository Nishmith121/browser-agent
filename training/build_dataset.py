"""Assemble the fine-tuning dataset.

  python build_dataset.py --condition redacted [--m2w data/m2w_redacted ...] [--out data/final_redacted]

Sources
  * synthetic: successful oracle runs (eval/results/oracle-<condition>.jsonl). The server audit log of each run holds, per
    step, the exact request the VLM would have seen and the redacted screenshot; the expert's action is the label.
  * mind2web: directories made by mind2web_builder.py (samples.jsonl + images/).
Split by WEBSITE: ShopMart, MailBox and VideoMeet are held out (unseen); Mind2Web websites are split by hash.
Output: train.jsonl, test.jsonl, images/, stats.json. For the redacted condition the builder also scans every sample for
the real values of all 50 synthetic personas and refuses to write the dataset if any is found (training on leaked PII
would defeat the purpose).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from chat_format import make_sample  # noqa: E402

from app.schemas import StepRequest  # noqa: E402  (server/app via chat_format's sys.path)

TEST_SITES = {"shopmart", "mailbox", "videomeet"}  # held-out synthetic websites (unseen during training)


def persona_values() -> list[str]:
    out: list[str] = []
    for p in json.loads((ROOT / "testsites" / "personas.json").read_text(encoding="utf-8")):
        for k in ("full_name", "email", "phone", "new_phone", "aadhaar", "pan", "dob", "address", "new_address", "account_number", "ifsc", "card_number", "password"):
            if p.get(k):
                out.append(str(p[k]))
        out.append(f"{p['aadhaar'][:4]} {p['aadhaar'][4:8]} {p['aadhaar'][8:]}")
    return [v for v in out if len(v) >= 6]


def synthetic_samples(condition: str, out_images: Path):
    results = ROOT / "eval" / "results" / f"oracle-{condition}.jsonl"
    if not results.exists():
        return
    logs = ROOT / "server" / "logs"
    for line in results.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if not row.get("success"):
            continue  # rejection sampling: only runs whose final site state is correct
        for session in row.get("sessions", []):
            f = logs / session / "requests.jsonl"
            if not f.exists():
                continue
            for entry in (json.loads(x) for x in f.read_text(encoding="utf-8").splitlines()):
                action = entry.get("action")
                if not action or action.get("type") == "ask_user":
                    continue
                req = entry["request"]
                png = logs / session / f"step{req['step']:03d}.png"
                if not png.exists():
                    continue
                sid = f"syn-{row['task']}-{session}-{req['step']:02d}"
                shutil.copyfile(png, out_images / f"{sid}.png")
                sample_req = StepRequest(**{**req, "screenshot": ""})
                site = row["site"]
                yield make_sample(sid, "synthetic", site, "test" if site in TEST_SITES else "train", condition, f"images/{sid}.png", sample_req, action)


def mind2web_samples(dirs: list[str], out_images: Path):
    for d in dirs:
        d = Path(d)
        for line in (d / "samples.jsonl").read_text(encoding="utf-8").splitlines():
            s = json.loads(line)
            shutil.copyfile(d / s["image"], out_images / Path(s["image"]).name)
            s["image"] = f"images/{Path(s['image']).name}"
            yield s


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--condition", choices=["redacted", "clean"], required=True)
    ap.add_argument("--m2w", nargs="*", default=[], help="Mind2Web sample directories to merge")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    out = Path(a.out or HERE / "data" / f"final_{a.condition}")
    (out / "images").mkdir(parents=True, exist_ok=True)

    samples = list(synthetic_samples(a.condition, out / "images")) + list(mind2web_samples(a.m2w, out / "images"))
    if not samples:
        sys.exit("no samples: run generate_data.py first (or pass --m2w)")

    if a.condition == "redacted":  # the redacted dataset must not contain real persona PII
        vals = persona_values()
        bad = Counter()
        for s in samples:
            blob = json.dumps(s["messages"], ensure_ascii=False)
            for v in vals:
                if v in blob:
                    bad[s["id"]] += 1
        if bad:
            sys.exit(f"REFUSING to write: {len(bad)} samples contain real persona values, e.g. {list(bad)[:3]}")

    for split in ("train", "test"):
        with (out / f"{split}.jsonl").open("w", encoding="utf-8") as f:
            for s in samples:
                if s["split"] == split:
                    f.write(json.dumps(s, ensure_ascii=False) + "\n")
    stats = {
        "samples": len(samples),
        "by_split": dict(Counter(s["split"] for s in samples)),
        "by_source": dict(Counter(s["source"] for s in samples)),
        "by_website": dict(Counter(s["website"] for s in samples)),
        "by_action": dict(Counter(json.loads(s["messages"][2]["content"])["type"] for s in samples)),
        "with_placeholders": sum(1 for s in samples if "[" in s["messages"][2]["content"] and "_" in s["messages"][2]["content"] or "{" in json.loads(s["messages"][2]["content"]).get("text", "")),
        "pii_scan": "passed (0 persona values)" if a.condition == "redacted" else "not applicable (clean = unsafe baseline)",
    }
    (out / "stats.json").write_text(json.dumps(stats, indent=2), encoding="utf-8")
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
