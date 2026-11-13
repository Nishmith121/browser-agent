"""Build redaction-aware chat samples from Multimodal-Mind2Web (osunlp/Multimodal-Mind2Web, OpenRAIL licence).

For every step: crop the full-page screenshot to a 1280x720 viewport around the target, list the interactive
candidates in that crop as numbered elements (Set-of-Marks), run the SAME redaction as the browser
(DOM rules for sensitive fields, structured-PII regex, placeholders), paint the redacted regions black, draw the
marks, and convert the gold action to the protocol JSON (typed sensitive values become placeholders).

  python mind2web_builder.py --parquet "data/mind2web/*.parquet" --out data/m2w_redacted --condition redacted --max-samples 300
  python mind2web_builder.py ... --condition clean --out data/m2w_clean     # same steps without redaction (unsafe baseline)

Optional extras (heavy packages; off by default): --ner (transformers token classifier on element text),
--faces (mediapipe face detector on the crop).
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import random
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chat_format import make_sample, split_for  # noqa: E402
from redact_py import RedactionMap, classify_field, detect_pii  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from app.schemas import StepRequest  # noqa: E402

VIEW_W, VIEW_H = 1280, 720
MAX_ELEMENTS = 40
INTERACTIVE_TAGS = {"a", "button", "input", "select", "textarea", "summary", "option"}
FIELD_TAGS = {"input", "textarea", "select"}


# ---- cleaned_html -> text/attrs per backend_node_id -------------------------------------------
class _Nodes(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.info: dict[str, dict] = {}
        self._stack: list[str | None] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        bid = a.get("backend_node_id")
        if bid is not None:
            self.info[bid] = {"tag": tag, "attrs": a, "text": []}
        self._stack.append(bid)

    def handle_endtag(self, tag):
        if self._stack:
            self._stack.pop()

    def handle_data(self, data):
        d = data.strip()
        if not d:
            return
        for bid in self._stack:
            if bid is not None and len(self.info[bid]["text"]) < 40:
                self.info[bid]["text"].append(d)


def parse_nodes(cleaned_html: str) -> dict[str, dict]:
    p = _Nodes()
    p.feed(cleaned_html or "")
    for v in p.info.values():
        v["text"] = " ".join(v["text"])[:120]
    return p.info


def _bbox(attrs: dict) -> list[float] | None:
    try:
        x, y, w, h = (float(v) for v in attrs["bounding_box_rect"].split(","))
        return [x, y, w, h]
    except (KeyError, ValueError):
        return None


def _attr(a: dict, *names: str) -> str | None:
    for n in names:
        if a.get(n):
            return str(a[n])
    return None


# ---- one step -> one sample -------------------------------------------------------------------
def build_step(row: dict, cmap: RedactionMap, condition: str, rng: random.Random, ner=None, faces=None):
    """Returns (sample, PIL image) or None when the step cannot be turned into a clean training example."""
    pos = [json.loads(x) for x in row["pos_candidates"]]
    if not pos:
        return None
    op = json.loads(row["operation"])
    nodes = parse_nodes(row["cleaned_html"])
    img = Image.open(io.BytesIO(row["screenshot"]["bytes"])).convert("RGB")
    W, H = img.size
    target = next((c for c in pos if c.get("is_original_target")), pos[0])
    ta = json.loads(target["attributes"])
    tb = _bbox(ta)
    if not tb or tb[2] <= 0 or tb[3] <= 0:
        return None

    # viewport crop around the target
    y0 = int(max(0, min(tb[1] + tb[3] / 2 - VIEW_H / 2, max(0, H - VIEW_H))))
    crop_h = min(VIEW_H, H - y0)
    crop = img.crop((0, y0, min(W, VIEW_W), y0 + crop_h))

    def candidate(c):
        a = json.loads(c["attributes"])
        b = _bbox(a)
        if not b or b[2] < 2 or b[3] < 2 or b[2] > VIEW_W * 0.95 or b[1] + b[3] / 2 < y0 or b[1] + b[3] / 2 > y0 + crop_h:
            return None
        info = nodes.get(a.get("backend_node_id", ""), {"tag": c["tag"], "attrs": {}, "text": ""})
        return {"bid": a.get("backend_node_id"), "tag": c["tag"], "box": [b[0], b[1] - y0, b[2], b[3]], "a": {**info["attrs"], **a},
                "text": info["text"], "is_target": c is target or a.get("backend_node_id") == ta.get("backend_node_id")}

    cands = [candidate(c) for c in pos]
    negs = [json.loads(x) for x in row["neg_candidates"]]
    negs = [n for n in negs if n["tag"] in INTERACTIVE_TAGS or json.loads(n["attributes"]).get("is_clickable") == "true"]
    cx, cy = tb[0] + tb[2] / 2, tb[1] + tb[3] / 2 - y0
    neg_c = [c for c in (candidate(n) for n in negs) if c]
    neg_c.sort(key=lambda c: (c["box"][0] + c["box"][2] / 2 - cx) ** 2 + (c["box"][1] + c["box"][3] / 2 - cy) ** 2)
    chosen = [c for c in cands if c][:1] + neg_c[: MAX_ELEMENTS - 1]
    if not chosen or not chosen[0]["is_target"]:
        return None
    chosen.sort(key=lambda c: (round(c["box"][1] / 8), c["box"][0]))  # reading order -> element ids 1..N
    target_id = next(i for i, c in enumerate(chosen, 1) if c["is_target"])

    redact = condition == "redacted"
    draw = ImageDraw.Draw(crop)
    elements, summary = [], Counter()
    secrets: list[str] = []
    for i, c in enumerate(chosen, 1):
        a, tag = c["a"], c["tag"]
        label = _attr(a, "aria_label", "aria-label", "title", "alt", "placeholder") or (c["text"] or None)
        el = {"id": i, "tag": tag, "type": a.get("type"), "label": label, "text": "" if tag in FIELD_TAGS else c["text"],
              "placeholder": _attr(a, "placeholder"), "bbox": [round(v) for v in c["box"]]}
        c["el"] = el
        if redact:
            sens = classify_field(a.get("type"), a.get("autocomplete"), a.get("name"), a.get("id"), _attr(a, "aria_label", "aria-label"),
                                  _attr(a, "placeholder"), label) if tag in FIELD_TAGS else None
            c["sens"] = sens
            if sens:
                el.update(text="", placeholder=None, redacted=True, category=sens)
                draw.rectangle([c["box"][0], c["box"][1], c["box"][0] + c["box"][2], c["box"][1] + c["box"][3]], fill=(0, 0, 0))
                summary[sens] += 1
            else:
                pii = False
                for k in ("label", "text", "placeholder"):
                    if el[k]:
                        spans = detect_pii(el[k])
                        if spans:
                            pii = True
                            el[k] = cmap.apply_spans(el[k], spans)
                if ner:
                    pii = ner(el, cmap) or pii
                if pii:  # no per-character boxes in this dataset: paint the whole element
                    draw.rectangle([c["box"][0], c["box"][1], c["box"][0] + c["box"][2], c["box"][1] + c["box"][3]], fill=(0, 0, 0))
                    summary["PII"] += 1
        elements.append(el)
    if redact and faces:
        for fb in faces(crop):
            draw.rectangle([fb[0], fb[1], fb[0] + fb[2], fb[1] + fb[3]], fill=(0, 0, 0))
            summary["FACE"] += 1
    for el in elements:  # Set-of-Marks on the (redacted) image, like the browser
        x, y, w, h = el["bbox"]
        draw.rectangle([x, y, x + w, y + h], outline=(225, 29, 72), width=2)
        draw.rectangle([x, max(0, y - 14), x + 7 * len(str(el["id"])) + 6, max(14, y)], fill=(225, 29, 72))
        draw.text((x + 3, max(0, y - 13)), str(el["id"]), fill=(255, 255, 255))

    # gold action in the protocol format
    t_el = elements[target_id - 1]
    value = op.get("value") or ""
    if op["op"] == "TYPE":
        text = value
        if redact:
            sens = chosen[target_id - 1].get("sens")
            if sens:  # a typed sensitive value becomes a vault placeholder, never the value
                name = {"PASSWORD": "PASSWORD", "OTP": "OTP"}.get(sens, f"SECRET:{sens.lower()}")
                text = "{" + name + "}"
                secrets.append(name.split(":")[-1] if ":" in name else name)
            else:
                text = cmap.sanitise(value)
        action = {"type": "type", "element_id": target_id, "text": text, "clear_first": True}
    elif op["op"] == "SELECT":
        action = {"type": "select", "element_id": target_id, "option": cmap.sanitise(value) if redact else value}
    else:
        action = {"type": "click", "element_id": target_id}

    reprs = row["action_reprs"][: int(row["target_action_index"])]
    history = [{"step": k + 1, "action": {"type": "step", "target": cmap.sanitise(r) if redact else r}, "result": "ok"} for k, r in enumerate(reprs)]
    task = cmap.sanitise(row["confirmed_task"]) if redact else row["confirmed_task"]
    req = StepRequest(session_id=row["annotation_id"], step=int(row["target_action_index"]) + 1, task=task, viewport={"width": VIEW_W, "height": crop.height, "scale": 1.0},
                      elements=elements, available_secrets=sorted(set(secrets)), history=history, redaction_summary=dict(summary), screenshot="")
    return req, action, crop


def iter_rows(paths: list[str]):
    import pyarrow.parquet as pq

    cols = ["action_uid", "cleaned_html", "operation", "pos_candidates", "neg_candidates", "website", "annotation_id",
            "confirmed_task", "screenshot", "action_reprs", "target_action_index"]
    for p in paths:
        f = pq.ParquetFile(p)
        for g in range(f.num_row_groups):
            yield from f.read_row_group(g, columns=cols).to_pylist()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", required=True, help="glob of Multimodal-Mind2Web parquet shards")
    ap.add_argument("--out", required=True)
    ap.add_argument("--condition", choices=["redacted", "clean"], default="redacted")
    ap.add_argument("--max-samples", type=int, default=0)
    ap.add_argument("--test-fraction", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--ner", action="store_true", help="also run a token-classification NER model on element text")
    ap.add_argument("--faces", action="store_true", help="also blur faces with mediapipe")
    a = ap.parse_args()

    ner = faces = None
    if a.ner:
        from transformers import pipeline

        clf = pipeline("token-classification", model="dslim/bert-base-NER", aggregation_strategy="simple")

        def ner(el, cmap):  # noqa: F811 - replaces the None above
            hit = False
            for k in ("label", "text"):
                if el[k]:
                    for e in clf(el[k]):
                        if e["entity_group"] == "PER" and e["score"] > 0.6:
                            el[k] = el[k].replace(e["word"], cmap.assign("NAME", e["word"]))
                            hit = True
            return hit
    if a.faces:
        import mediapipe as mp  # noqa: F401  (a face detector hook would go here)
        raise SystemExit("--faces needs the BlazeFace model file; see training/README.md")

    out = Path(a.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    rng = random.Random(a.seed)
    rows = sorted(iter_rows(sorted(glob.glob(a.parquet))), key=lambda r: (r["annotation_id"], int(r["target_action_index"])))
    maps: dict[str, RedactionMap] = {}
    n, skipped, per_split = 0, 0, Counter()
    with (out / "samples.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            cmap = maps.setdefault(row["annotation_id"], RedactionMap())  # one placeholder map per task
            res = build_step(row, cmap, a.condition, rng, ner, faces)
            if res is None:
                skipped += 1
                continue
            req, action, crop = res
            sid = f"m2w-{row['action_uid']}"
            crop.save(out / "images" / f"{sid}.jpg", quality=88)
            split = split_for(row["website"], a.test_fraction)
            f.write(json.dumps(make_sample(sid, "mind2web", row["website"], split, a.condition, f"images/{sid}.jpg", req, action), ensure_ascii=False) + "\n")
            n += 1
            per_split[split] += 1
            if a.max_samples and n >= a.max_samples:
                break
    print(f"wrote {n} samples ({dict(per_split)}), skipped {skipped}, to {out}")


if __name__ == "__main__":
    main()
