"""Offline step accuracy on the held-out websites (the dataset's test split), against any OpenAI-compatible endpoint.

  # the three conditions of Section 9.1 (same test steps, different screens / models):
  python eval_offline.py --data data/final_clean    --base-url http://gpu:8001/v1 --model Qwen/Qwen3-VL-4B-Instruct   # base, clean screens
  python eval_offline.py --data data/final_redacted --base-url http://gpu:8001/v1 --model Qwen/Qwen3-VL-4B-Instruct   # base, redacted
  python eval_offline.py --data data/final_redacted --base-url http://gpu:8001/v1 --model privasight                   # LoRA, redacted

Metrics per step: valid JSON, action type correct, element correct (click/type/select), exact match (type + element
+ text/option). Task success needs the live harness (eval/run_eval.py); this is the fast, cheap signal.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "server"))
from app.parser import extract_json  # noqa: E402  (the same extraction the agent server uses)


def ask(client: httpx.Client, base_url: str, model: str, sample: dict, data: Path, max_tokens: int) -> str:
    system, user, _gold = sample["messages"]
    img = base64.b64encode((data / sample["image"]).read_bytes()).decode()
    mime = "image/png" if sample["image"].endswith(".png") else "image/jpeg"
    text = next(p["text"] for p in user["content"] if p["type"] == "text")
    body = {
        "model": model, "temperature": 0.0, "max_tokens": max_tokens,
        "messages": [{"role": "system", "content": system["content"]},
                     {"role": "user", "content": [{"type": "image_url", "image_url": {"url": f"data:{mime};base64,{img}"}}, {"type": "text", "text": text}]}],
    }
    r = client.post(f"{base_url}/chat/completions", json=body, timeout=300)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"] or ""


def score(reply: str, gold: dict) -> dict:
    out = {"valid": False, "type": False, "element": False, "exact": False}
    try:
        pred = json.loads(extract_json(reply))
    except Exception:  # noqa: BLE001
        return out
    out["valid"] = isinstance(pred, dict)
    out["type"] = pred.get("type") == gold["type"]
    if "element_id" in gold:
        out["element"] = out["type"] and pred.get("element_id") == gold["element_id"]
    else:
        out["element"] = out["type"]  # actions without an element (scroll, done, ...)
    key = {"type": "text", "select": "option", "done": None, "press_key": "key", "navigate": "url"}.get(gold["type"])
    out["exact"] = out["element"] and (key is None or pred.get(key) == gold.get(key))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--split", default="test")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--max-tokens", type=int, default=300)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    data = Path(a.data)
    samples = [json.loads(x) for x in (data / f"{a.split}.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    if a.limit:
        samples = samples[: a.limit]
    client = httpx.Client()

    def one(s):
        gold = json.loads(s["messages"][2]["content"])
        try:
            return s, score(ask(client, a.base_url, a.model, s, data, a.max_tokens), gold)
        except Exception as e:  # noqa: BLE001
            return s, {"valid": False, "type": False, "element": False, "exact": False, "error": str(e)[:80]}

    with ThreadPoolExecutor(a.workers) as ex:
        results = list(ex.map(one, samples))

    groups: dict[str, list[dict]] = defaultdict(list)
    for s, r in results:
        for g in ("all", f"source:{s['source']}", f"site:{s['website']}"):
            groups[g].append(r)
    table = {g: {k: round(sum(r[k] for r in rs) / len(rs), 4) for k in ("valid", "type", "element", "exact")} | {"n": len(rs)} for g, rs in sorted(groups.items())}
    print(f"model={a.model} data={a.data} split={a.split}")
    print(f"{'group':<26}{'n':>5}  valid   type  element  exact")
    for g, m in table.items():
        print(f"{g:<26}{m['n']:>5}  {m['valid']:.3f}  {m['type']:.3f}  {m['element']:.3f}  {m['exact']:.3f}")
    if a.out:
        Path(a.out).write_text(json.dumps({"model": a.model, "data": a.data, "split": a.split, "table": table}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
