"""Turn results/*.jsonl into tables and charts (reports/phase6/).

  python report.py            # reads results/<condition>.jsonl for every enabled condition that has results

Outputs: summary.md, runs.csv, per_task.csv and four PNG charts (success by site, steps, latency, leakage).
Success is mean +- std over runs (std needs >= 2 runs). The first step of each condition's very first run is
dropped from the latency statistics (it pays for loading the model into memory).
"""
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import yaml  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE / "reports" / "phase6"
SITES = ["demobank", "hr", "hospital", "shopmart", "mailbox", "videomeet"]
SITE_LABEL = {"demobank": "DemoBank", "hr": "HR Portal", "hospital": "Hospital", "shopmart": "ShopMart", "mailbox": "MailBox", "videomeet": "VideoMeet"}

# Reference palette (dataviz skill, light mode): categorical slots in fixed order, never cycled.
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#6250d6"]
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e6e5e1"


def style():
    plt.rcParams.update({
        "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
        "text.color": INK, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
        "axes.edgecolor": GRID, "axes.spines.top": False, "axes.spines.right": False,
        "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.axisbelow": True,
        "font.size": 10, "axes.titlesize": 12, "axes.titleweight": "bold", "axes.titlelocation": "left",
        "legend.frameon": False,
    })


def load():
    conds = yaml.safe_load((HERE / "conditions.yaml").read_text(encoding="utf-8"))["conditions"]
    rows, meta = [], {}
    for c in conds:
        if c.get("kind") == "data":  # data-generation runs are not baselines
            continue
        f = HERE / "results" / f"{c['name']}.jsonl"
        if not f.exists() or not f.read_text(encoding="utf-8").strip():
            continue
        meta[c["name"]] = c
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines()):
            r = json.loads(line)
            r["_idx"] = i
            r["label"] = c["label"]
            rows.append(r)
    df = pd.DataFrame(rows)
    df["leaked"] = df["leaks"].apply(lambda d: bool(d))
    df["n_leaked_kinds"] = df["leaks"].apply(lambda d: len(d or {}))
    return df, meta


def ms_stats(values):
    v = np.array([x for x in values if x is not None], dtype=float)
    return (np.median(v), np.percentile(v, 95), len(v)) if len(v) else (np.nan, np.nan, 0)


def latency_samples(df, col):
    """Per-step samples for a condition; drops step 1 of that condition's first run (model load)."""
    out = {}
    for name, g in df.groupby("condition", sort=False):
        vals = []
        for _, r in g.iterrows():
            xs = list(r[col] or [])
            if r["_idx"] == 0 and xs:
                xs = xs[1:]
            vals += xs
        out[name] = vals
    return out


def run_rates(g):
    """Overall success rate of each run index (one number per full pass over the tasks)."""
    return g.groupby("run")["success"].mean()


def fmt_rate(m, s, n_runs):
    return f"{100 * m:.1f}% ± {100 * s:.1f}" if n_runs >= 2 and not np.isnan(s) else f"{100 * m:.1f}% (1 run)"


def bar_labels(ax, bars, fmt="{:.0f}%", pad=3):
    for b in bars:
        h = b.get_height()
        ax.annotate(fmt.format(h), (b.get_x() + b.get_width() / 2, h), ha="center", va="bottom", xytext=(0, pad), textcoords="offset points", fontsize=8, color=INK2)


def chart_success(df, order):
    fig, ax = plt.subplots(figsize=(10, 4.6))
    groups = SITES + ["all"]
    w = 0.8 / len(order)
    for i, c in enumerate(order):
        g = df[df.condition == c]
        vals, errs = [], []
        for s in groups:
            gs = g if s == "all" else g[g.site == s]
            rates = gs.groupby("run")["success"].mean()
            vals.append(100 * gs["success"].mean() if len(gs) else np.nan)
            errs.append(100 * rates.std() if len(rates) >= 2 else 0)
        x = np.arange(len(groups)) + (i - (len(order) - 1) / 2) * w
        bars = ax.bar(x, vals, w * 0.88, color=SERIES[i], label=g["label"].iloc[0], yerr=errs, error_kw={"ecolor": INK2, "elinewidth": 1, "capsize": 2})
        bar_labels(ax, bars)
    ax.set_xticks(range(len(groups)), [SITE_LABEL.get(s, "All sites") for s in groups])
    ax.set_ylim(0, 112)
    ax.set_ylabel("Task success rate (%)")
    ax.set_title("Task success by site (mean over runs, bars show ± std when ≥ 2 runs)")
    ax.legend(loc="upper center", ncol=2, bbox_to_anchor=(0.5, -0.08))
    fig.tight_layout()
    fig.savefig(OUT / "success_by_site.png", dpi=160)
    plt.close(fig)


def chart_steps(df, order):
    fig, ax = plt.subplots(figsize=(10, 4.2))
    groups = SITES + ["all"]
    w = 0.8 / len(order)
    for i, c in enumerate(order):
        g = df[df.condition == c]
        vals = [(g if s == "all" else g[g.site == s])["steps"].mean() for s in groups]
        x = np.arange(len(groups)) + (i - (len(order) - 1) / 2) * w
        bars = ax.bar(x, vals, w * 0.88, color=SERIES[i], label=g["label"].iloc[0])
        bar_labels(ax, bars, "{:.1f}")
    ax.set_xticks(range(len(groups)), [SITE_LABEL.get(s, "All sites") for s in groups])
    ax.set_ylabel("Steps per task run")
    ax.set_title("Steps per task (all runs, successful or not; the step limit is 15)")
    ax.legend(loc="upper center", ncol=2, bbox_to_anchor=(0.5, -0.08))
    fig.tight_layout()
    fig.savefig(OUT / "steps_per_task.png", dpi=160)
    plt.close(fig)


def chart_latency(df, order, labels):
    panels = [("step_latency_ms", "End-to-end step\n(capture → action done)"), ("local_ms", "Local perception\n(on-device redaction)"), ("model_ms", "Model + server\n(per step)")]
    fig, axes = plt.subplots(1, 3, figsize=(11, 4.4))
    for ax, (col, title) in zip(axes, panels):
        samples = latency_samples(df, col)
        data = [np.array(samples.get(c, []), dtype=float) / 1000 for c in order]
        bp = ax.boxplot(data, widths=0.5, patch_artist=True, whis=(5, 95), showfliers=False, medianprops={"color": INK, "linewidth": 1.5},
                        whiskerprops={"color": INK2, "linewidth": 1}, capprops={"color": INK2, "linewidth": 1})
        for patch, color in zip(bp["boxes"], SERIES):
            patch.set_facecolor(color)
            patch.set_alpha(0.85)
            patch.set_edgecolor(SURFACE)
        for k, d in enumerate(data, start=1):
            if len(d):
                ax.annotate(f"{np.median(d):.2f}s", (k, np.median(d)), xytext=(18, 0), textcoords="offset points", fontsize=8, va="center", color=INK2)
        ax.set_xticks(range(1, len(order) + 1), [f"cond {i + 1}" for i in range(len(order))])
        ax.set_title(title, fontsize=10)
        ax.set_ylabel("seconds")
    handles = [plt.Rectangle((0, 0), 1, 1, color=SERIES[i]) for i in range(len(order))]
    fig.legend(handles, [f"cond {i + 1}: {labels[c]}" for i, c in enumerate(order)], loc="lower center", ncol=2, fontsize=9)
    fig.suptitle("Latency per step (boxes: quartiles; whiskers: 5th–95th percentile; label: median)", x=0.01, ha="left", fontsize=12, fontweight="bold")
    fig.tight_layout(rect=(0, 0.1, 1, 0.94))
    fig.savefig(OUT / "latency.png", dpi=160)
    plt.close(fig)


def chart_leakage(df, order, labels):
    fig, ax = plt.subplots(figsize=(8.5, 3.8))
    vals = [100 * df[df.condition == c]["leaked"].mean() for c in order]
    counts = [int(df[df.condition == c]["leaked"].sum()) for c in order]
    totals = [int((df.condition == c).sum()) for c in order]
    y = np.arange(len(order))
    bars = ax.barh(y, vals, 0.5, color=SERIES[: len(order)])
    for b, v, k, n in zip(bars, vals, counts, totals):
        ax.annotate(f"{v:.0f}%  ({k} of {n} runs)", (max(v, 0), b.get_y() + b.get_height() / 2), xytext=(6, 0), textcoords="offset points", va="center", fontsize=9, color=INK)
    ax.set_yticks(y, [labels[c] for c in order])
    ax.invert_yaxis()
    ax.set_xlim(0, 118)
    ax.set_xlabel("Runs where a ground-truth PII value reached the server logs (%)")
    ax.set_title("Leakage: ground-truth PII found in the agent server's request logs")
    fig.tight_layout()
    fig.savefig(OUT / "leakage.png", dpi=160)
    plt.close(fig)


def md_table(header, rows):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    style()
    df, meta = load()
    if df.empty:
        sys.exit("no results found in eval/results/")
    order = list(dict.fromkeys(df["condition"]))
    labels = {c: meta[c]["label"] for c in order}
    n_tasks = df["task"].nunique()

    chart_success(df, order)
    chart_steps(df, order)
    chart_latency(df, order, labels)
    chart_leakage(df, order, labels)

    df.drop(columns=["step_latency_ms", "local_ms", "model_ms", "actions", "checks", "sessions"], errors="ignore").to_csv(OUT / "runs.csv", index=False)
    pt = df.groupby(["task", "site", "condition"]).agg(runs=("success", "size"), passed=("success", "sum"), steps=("steps", "mean")).reset_index()
    pt.to_csv(OUT / "per_task.csv", index=False)

    L = ["# Phase 6 — baseline results", ""]
    L.append(f"{n_tasks} tasks across {df['site'].nunique()} synthetic sites; conditions below. Success = the site's final state matches the expected state "
            "(checked through its `/check` endpoint) within the task's step limit. Mean ± std is taken over runs (full passes over all tasks).")
    L.append("")
    L.append("## Overall")
    rows = []
    for c in order:
        g = df[df.condition == c]
        rr = run_rates(g)
        e2e, loc, mod = (ms_stats(latency_samples(df, k)[c]) for k in ("step_latency_ms", "local_ms", "model_ms"))
        rows.append([labels[c], meta[c]["model"], f"{g['task'].nunique()} × {g['run'].nunique()}", fmt_rate(g["success"].mean(), rr.std(), len(rr)),
                     f"{g['steps'].mean():.1f}", f"{e2e[0] / 1000:.1f} / {e2e[1] / 1000:.1f}", f"{loc[0]:.0f} / {loc[1]:.0f}", f"{mod[0] / 1000:.1f} / {mod[1] / 1000:.1f}"])
    L.append(md_table(["Condition", "Model", "Tasks × runs", "Task success", "Steps / task", "E2E step s (median / p95)", "Local ms (median / p95)", "Model s (median / p95)"], rows))
    L += ["", "## Success by site", ""]
    rows = []
    for s in SITES:
        row = [SITE_LABEL[s]]
        for c in order:
            g = df[(df.condition == c) & (df.site == s)]
            rr = g.groupby("run")["success"].mean()
            row.append(fmt_rate(g["success"].mean(), rr.std(), len(rr)) if len(g) else "–")
        rows.append(row)
    L.append(md_table(["Site"] + [labels[c] for c in order], rows))
    L += ["", "![success by site](success_by_site.png)", "", "## Steps per task", "", "![steps](steps_per_task.png)", "", "## Latency", "",
          "Local perception is the on-device redaction (OCR/NER/faces + painting); model is the agent server round trip. "
          "E2E includes executing the action and waiting for the page to settle.", "", "![latency](latency.png)"]
    L += ["", "## Leakage", ""]
    rows = []
    for c in order:
        g = df[df.condition == c]
        kinds = {}
        for d in g["leaks"]:
            for k, v in (d or {}).items():
                kinds[k] = kinds.get(k, 0) + v
        rows.append([labels[c], f"{int(g['leaked'].sum())} of {len(g)}", ", ".join(f"{k}:{v}" for k, v in sorted(kinds.items(), key=lambda kv: -kv[1])[:8]) or "none"])
    L.append(md_table(["Condition", "Runs with a leak", "Leaked categories (occurrences)"], rows))
    L += ["", "Every sensitive value of every persona (name, email, phones, Aadhaar, PAN, DOB, addresses, account, IFSC, card, password) and the task's vault secrets "
          "are searched, exactly and with spaces/dashes removed, in every request the server logged. The clean-screens condition is the unsafe baseline: "
          "leaks there are expected and show what redaction prevents.", "", "![leakage](leakage.png)", "", "## Per task", ""]
    pivot = pt.pivot_table(index=["site", "task"], columns="condition", values="passed", aggfunc="sum")
    runs = pt.pivot_table(index=["site", "task"], columns="condition", values="runs", aggfunc="sum")
    rows = []
    for (site, task) in pivot.index:
        rows.append([SITE_LABEL[site], task] + [f"{int(pivot.loc[(site, task), c])}/{int(runs.loc[(site, task), c])}" if c in pivot.columns and not pd.isna(pivot.loc[(site, task), c]) else "–" for c in order])
    L.append(md_table(["Site", "Task"] + [labels[c] for c in order], rows))
    fails = df[~df["success"]].groupby(["condition", "end_reason"]).size().reset_index(name="runs")
    if len(fails):
        L += ["", "## How failed runs ended", "", md_table(["Condition", "End reason", "Runs"], fails.values.tolist())]
    (OUT / "summary.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"wrote {OUT / 'summary.md'} and charts for {len(order)} condition(s)")


if __name__ == "__main__":
    main()
