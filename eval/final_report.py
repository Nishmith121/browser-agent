"""Phase 10: the final metrics tables and charts, rebuilt from the saved results of every phase (no browser, no model).

  python final_report.py

Reads   eval/reports/phase5_wasm.json, phase5_webgpu.json   (redaction recall/precision/latency, Phases 5 and 8)
        eval/reports/phase10_ablation_wasm.json              (layer ablation, Phase 10; a newer phase5_wasm.json run wins)
        eval/reports/phase6/runs.csv                         (live task success and leakage, Phase 6)
        training/results/res_*.json                          (offline step accuracy, Phase 7)
        training/results/ner_eval_*.json                     (name NER, Phase 8)
Writes  eval/reports/final/summary.md + charts, and the tables between the markers in docs/RESULTS.md.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REP = HERE / "reports"
OUT = REP / "final"
TRAIN = ROOT / "training" / "results"
DOC = ROOT / "docs" / "RESULTS.md"

# Validated categorical palette (fixed order) and text inks.
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#6250d6"]
INK, INK2, GRID = "#0b0b0b", "#52514e", "#e4e3df"
STRUCTURED = ["AADHAAR", "PAN", "PHONE", "EMAIL", "CARD", "IFSC", "ACCOUNT", "DOB", "CVV"]


def load(p: Path) -> dict | None:
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def pct(n: float, d: float | None = None, nd: int = 1) -> str:
    if d is not None:
        return "-" if not d else f"{100 * n / d:.{nd}f}%"
    return "-" if n is None else f"{100 * n:.{nd}f}%"


def q(a: list, f: float):
    a = sorted(a)
    return a[min(len(a) - 1, int(f * len(a)))] if a else None


def table(head: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def style(ax, title: str) -> None:
    ax.set_title(title, loc="left", color=INK, fontsize=11, pad=10)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(INK2)
    ax.tick_params(colors=INK2, labelsize=9, length=0)
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


# ---------------------------------------------------------------------------------------------------------------
def redaction_section(md: list[str]) -> None:
    w, g = load(REP / "phase5_wasm.json"), load(REP / "phase5_webgpu.json")
    if not w:
        md.append("_phase5_wasm.json missing: run `node phase5_eval.mjs 3 \",dark,serif,large,shift\" wasm`._")
        return
    md.append(f"### Redaction recall and precision per category\n\nThrough the real extension on {w['captures']} captures "
              "(15 pages x 5 layouts x 3 personas, WASM backend, fine-tuned NER). Recall = ground-truth items whose box is "
              ">= 90% under painted regions; the pixel check confirms they are black (text, fields) or blurred (faces). "
              "Leaked = the value appears in the outgoing JSON.\n")
    rows = []
    for cat, s in sorted(w["stats"].items(), key=lambda kv: (kv[0] == "FACE", kv[0] not in STRUCTURED, kv[0])):
        ok = s["blurred"] if cat == "FACE" else s["black"]
        rows.append([cat, s["total"], pct(s["covered"], s["total"]), pct(ok, s["total"]), s["leaked"]])
    text = [s for c, s in w["stats"].items() if c != "FACE"]
    tot, cov, leak = sum(s["total"] for s in text), sum(s["covered"] for s in text), sum(s["leaked"] for s in text)
    rows.append(["**All text PII**", tot, f"**{pct(cov, tot)}**", "", leak])
    md.append(table(["Category", "Items", "Recall", "Painted (black/blurred)", "Leaked"], rows))
    md.append(f"\nRedaction precision (painted area on ground truth): **{pct(w['precision'])}** (target >= 80%).")
    targets = [
        ["Fields and passwords", ">= 98%", pct(sum(w["stats"][c]["covered"] for c in ("CARD", "CVV") if c in w["stats"]), sum(w["stats"][c]["total"] for c in ("CARD", "CVV") if c in w["stats"])) + " (card/CVV fields; password fields: 100% in the Phase 2 and 9 checks)"],
        ["Text PII", ">= 95%", pct(cov, tot)],
        ["Faces", ">= 95%", pct(w["stats"]["FACE"]["covered"], w["stats"]["FACE"]["total"]) if "FACE" in w["stats"] else "-"],
        ["Precision", ">= 80%", pct(w["precision"])],
    ]
    md.append("\n" + table(["Target (plan, Section 10)", "Required", "Measured"], targets))

    md.append("\n### Local latency, WebGPU vs WASM\n")
    rows = []
    for name, d in (("WASM (int8 NER, CPU face delegate)", w), ("WebGPU (fp16 NER, GPU face delegate)", g)):
        if not d:
            continue
        L = d["latency"]
        rows.append([name, d["captures"], f"{q(L['total'], .5)} / {q(L['total'], .95)}", f"{q(L['ner'], .5)} / {q(L['ner'], .95)}",
                     f"{q(L['face'], .5)} / {q(L['face'], .95)}", f"{q(L['paint'], .5)}", d.get("firstRun")])
    md.append(table(["Backend", "Captures", "Total ms (median / p95)", "NER ms", "Face ms", "Paint ms", "First capture ms (model load)"], rows))
    md.append("\nTotal = ML + mapping + rules + painting per step, excluding the screenshot call and the first capture. These runs revisit "
              "the same pages, so most NER calls are cache hits (median 0 ms). Cache-miss pages (fresh names every step) were measured "
              "separately in Phase 5: median 337 ms, p95 about 600 ms on WASM (target: median < 500 ms). The WebGPU file is the Phase 5 "
              "run with the original NER model (90 captures); the fine-tuned model has no fp16 export, so WebGPU NER is not available for it.")


def ablation_section(md: list[str]) -> None:
    # Any phase5_eval run since Phase 10 carries its own ablation; otherwise use the Phase 10 run.
    w = load(REP / "phase5_wasm.json")
    a = w if w and "ablation" in w else load(REP / "phase10_ablation_wasm.json")
    if not a or "ablation" not in a:
        md.append("\n_Ablation missing: `OUT=reports/phase10_ablation_wasm.json node phase5_eval.mjs 3 \",dark,serif,large,shift\" wasm`._")
        return
    groups = ["structured", "names", "addresses", "faces", "text PII (all)"]
    layers = list(a["ablation"])
    nice = {"dom": "DOM rules only", "dom+regex": "+ regex", "dom+regex+ner": "+ NER", "full": "+ faces, video, OCR (full)"}
    md.append(f"\n### Layer ablation\n\nSame {a['captures']} captures; each layer's painted regions are kept or dropped by their detector "
              "(the layers are independent and their regions are unioned, so dropping a layer's regions equals not running it). "
              "Leakage is not ablated: the leak guard and placeholder map run in every configuration.\n")
    rows = []
    for l in layers:
        r = a["ablation"][l]
        rows.append([nice.get(l, l)] + [pct(r["recall"][gname]["covered"], r["recall"][gname]["total"]) for gname in groups] + [pct(r["precision"])])
    md.append(table(["Layers", "Structured PII", "Names", "Addresses", "Faces", "All text PII", "Precision"], rows))
    md.append("\nReading: DOM rules alone catch only sensitive fields (card, CVV, password); regex adds almost all structured PII "
              "and every address; NER adds names; the full pipeline adds faces and the PII inside images and canvases (OCR: the HR ID card), "
              "which is why structured recall moves from 92% to 100% only at the last step. Each layer costs a little precision.")

    fig, ax = plt.subplots(figsize=(8, 3.6), dpi=150)
    xs = range(len(groups) - 1)
    width = 0.2
    for i, l in enumerate(layers):
        r = a["ablation"][l]["recall"]
        vals = [100 * r[gname]["covered"] / r[gname]["total"] for gname in groups[:-1]]
        ax.bar([x + (i - 1.5) * width for x in xs], vals, width * 0.9, color=SERIES[i], label=nice.get(l, l))
    ax.set_xticks(list(xs), ["Structured PII", "Names", "Addresses", "Faces"])
    ax.set_ylim(0, 105)
    ax.set_ylabel("Recall (%)", color=INK2, fontsize=9)
    style(ax, "Redaction recall as detector layers are added")
    ax.legend(frameon=False, fontsize=8, ncol=4, loc="upper center", bbox_to_anchor=(0.5, -0.12), labelcolor=INK2)
    fig.tight_layout()
    fig.savefig(OUT / "ablation.png")
    plt.close(fig)
    md.append("\n![layer ablation](../eval/reports/final/ablation.png)")


def task_section(md: list[str]) -> None:
    p = REP / "phase6" / "runs.csv"
    if not p.exists():
        return
    df = pd.read_csv(p)
    md.append("\n### Live task success, steps and leakage\n\n32 tasks on the six sites, 3 runs each, Qwen3-VL-2B-Instruct. Two serving setups: "
              "**Ollama** on the laptop (Phase 6 baselines) and **Transformers 4-bit** on a Kaggle T4 behind a tunnel (`training/serve_hf.py`, Phase 10), "
              "where the base model and the LoRA adapter come from one loaded model, so those three conditions differ only in the adapter and the screens. "
              "Success = the site's final state matches the task (checked by its `/check` endpoint) within the step limit. "
              "Leak = any sensitive value of any persona, or a vault secret, in a request the server logged.\n")
    rows = []
    for cond, d in df.groupby("condition", sort=False):
        per_run = d.groupby("run")["success"].mean() * 100
        rows.append([d["label"].iloc[0], f"{len(d)}", f"{per_run.mean():.1f}% ± {per_run.std(ddof=1):.1f}", f"{d['steps'].mean():.1f}",
                     f"{int(d['leaked'].sum())} of {len(d)}"])
    md.append(table(["Condition", "Runs", "Task success (mean ± std over 3 runs)", "Steps / task", "Runs with a leak"], rows))
    md.append("\nThe Transformers server decodes greedily, so its three runs of a task are nearly identical (std 0): the effective sample is the 32 tasks, "
              "not 96 runs. A difference of one task is about 3 points.")
    labels = {r["condition"]: r["label"] for _, r in df.drop_duplicates("condition").iterrows()}
    cols = list(dict.fromkeys(df["condition"]))
    sites = df.groupby(["site", "condition"])["success"].mean().unstack() * 100
    order = ["demobank", "hr", "hospital", "shopmart", "mailbox", "videomeet"]
    site_names = {"demobank": "DemoBank", "hr": "HR Portal", "hospital": "Hospital", "shopmart": "ShopMart", "mailbox": "MailBox", "videomeet": "VideoMeet"}
    md.append("\n" + table(["Site"] + [labels[c] for c in cols], [[site_names[s]] + [f"{sites.loc[s, c]:.1f}%" for c in cols] for s in order if s in sites.index]))
    # The LoRA adapter was trained on DemoBank, HR and Hospital trajectories; ShopMart, MailBox and VideoMeet were held out.
    held = {"shopmart", "mailbox", "videomeet"}
    split = []
    for c in cols:
        d = df[df["condition"] == c]
        tr, ho = d[~d["site"].isin(held)], d[d["site"].isin(held)]
        split.append([labels[c], f"{100 * tr['success'].mean():.1f}% ({int(tr['success'].sum())}/{len(tr)})", f"{100 * ho['success'].mean():.1f}% ({int(ho['success'].sum())}/{len(ho)})"])
    md.append("\nSplit by whether the LoRA adapter saw the site in training (the base-model rows show how hard each group is):\n")
    md.append(table(["Condition", "Training sites (DemoBank, HR, Hospital)", "Unseen sites (ShopMart, MailBox, VideoMeet)"], split))
    md.append("\nEvery site has at least one task that the agent completes end to end with redaction on (definition of done, item 1). "
              "Per-task results, latency and failure reasons: `eval/reports/phase6/summary.md`.")


def offline_section(md: list[str]) -> None:
    files = [("Base, clean screens (unsafe)", "res_base_clean.json"), ("Base, redacted screens", "res_base_redacted.json"),
             ("LoRA trained on redacted, redacted screens", "res_lora_redacted.json"), ("LoRA trained on clean, clean screens (control)", "res_lora_clean.json"),
             ("LoRA trained on clean, redacted screens (control)", "res_loraclean_on_redacted.json")]
    rows, bars = [], []
    for name, f in files:
        d = load(TRAIN / f)
        if not d:
            continue
        t = d["table"]["all"]
        rows.append([name, t["n"], pct(t["valid"]), pct(t["type"]), pct(t["element"]), f"**{pct(t['exact'])}**"])
        bars.append((name, 100 * t["exact"]))
    if not rows:
        return
    md.append("\n### Fine-tuned VLM: offline step accuracy (Phase 7)\n\nQwen3-VL-2B-Instruct, QLoRA r16 on 499 samples (Kaggle T4). "
              "197 held-out steps from websites never seen in training (ShopMart, MailBox, VideoMeet, 9 Mind2Web steps). "
              "Exact = same action type, element and value as the expert. One seed; the standard error of each cell is about 2.5 points.\n")
    md.append(table(["Model and screens", "Steps", "Valid JSON", "Action type", "Element", "Exact match"], rows))
    ex = {f: (load(TRAIN / f) or {}).get("table", {}).get("all", {}).get("exact") for _, f in files}
    if ex["res_loraclean_on_redacted.json"] is not None and ex["res_lora_redacted.json"] is not None:
        md.append(f"\nReading: fine-tuning lifts exact match from about a third to about {pct(ex['res_lora_redacted.json'], nd=0)}, but a LoRA trained on "
                  f"clean screens does as well on redacted screens ({pct(ex['res_loraclean_on_redacted.json'])} vs {pct(ex['res_lora_redacted.json'])}), "
                  "so offline the gain is task learning, not redaction-awareness. Live, the same adapter lifts task success on redacted screens from 46.9% to 90.6% (table above); "
                  "a live run of the clean-trained adapter was not done, so the live result cannot separate the two either.")
    fig, ax = plt.subplots(figsize=(8, 3.2), dpi=150)
    names = [b[0] for b in bars][::-1]
    vals = [b[1] for b in bars][::-1]
    ax.barh(names, vals, color=SERIES[0], height=0.55)
    for y, v in enumerate(vals):
        ax.text(v + 1, y, f"{v:.1f}%", va="center", fontsize=8, color=INK)
    ax.set_xlim(0, 100)
    style(ax, "Exact-match step accuracy on unseen websites")
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.yaxis.grid(False)
    ax.tick_params(axis="y", labelsize=8)
    fig.tight_layout()
    fig.savefig(OUT / "step_accuracy.png")
    plt.close(fig)
    md.append("\n![step accuracy](../eval/reports/final/step_accuracy.png)")


def ner_section(md: list[str]) -> None:
    b, f = load(TRAIN / "ner_eval_base.json"), load(TRAIN / "ner_eval_finetuned.json")
    if not (b and f):
        return
    md.append("\n### Indian-name NER (Phase 8)\n\nPerson entities on held-out synthetic UI text (names and templates unseen in training), "
              "a hand-written list of harder names, and rows with no names (false person tags).\n")
    rows = []
    for split, label in (("test_heldout", "Held-out names (n=1500)"), ("test_hard", "Hand-written hard names (n=1200)")):
        rows.append([label, pct(b[split]["exact_f1"]), pct(f[split]["exact_f1"]), pct(b[split]["word_recall"]), pct(f[split]["word_recall"])])
    rows.append(["Rows with no names (n=1200): false person tags", "", "", pct(b["test_negatives"]["false_rows"]), pct(f["test_negatives"]["false_rows"])])
    md.append(table(["Set", "F1, shipped model", "F1, fine-tuned", "Word recall / false tags, shipped", "fine-tuned"], rows))
    md.append("\nIn the browser the fine-tune did not change name recall (98.9% before and after: the Phase 5 heuristics already recovered the persona names); "
              "the int8 model matches PyTorch and has the same size (108 MB).")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    md: list[str] = []
    redaction_section(md)
    ablation_section(md)
    task_section(md)
    offline_section(md)
    ner_section(md)
    body = "\n".join(md) + "\n"
    (OUT / "summary.md").write_text("# PrivaSight: final metrics\n\nGenerated by `eval/final_report.py`.\n\n" + body.replace("../eval/reports/final/", ""), encoding="utf-8")
    if DOC.exists():
        doc = DOC.read_text(encoding="utf-8")
        new = re.sub(r"(<!-- tables:start -->).*?(<!-- tables:end -->)", lambda m: f"{m.group(1)}\n{body}{m.group(2)}", doc, flags=re.S)
        DOC.write_text(new, encoding="utf-8")
    print(f"wrote {OUT / 'summary.md'} and charts; updated {DOC.name}" if DOC.exists() else f"wrote {OUT / 'summary.md'}")


if __name__ == "__main__":
    main()
