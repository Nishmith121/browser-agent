"""Record expert trajectories on the synthetic sites through the REAL extension (Phase 7 data).

  python generate_data.py                       # all generated tasks, redacted and clean builds
  python generate_data.py --limit 12 --conditions oracle-redacted   # smoke test
  python generate_data.py --resume              # continue an interrupted run

Starts the test sites, the oracle (a scripted expert behind the same chat API as the VLM, training/oracle_vlm.py) and
the agent server pointed at it, then drives Chromium through training/tasks_gen/*.yaml with eval/run_tasks.mjs.
Results go to eval/results/oracle-*.jsonl and the server's audit log keeps each observation (request + redacted
screenshot) with the expert's action; build_dataset.py turns the successful runs into chat samples.
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "eval"))
import run_eval as ev  # noqa: E402  (reuses its service helpers)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conditions", default="oracle-redacted,oracle-clean")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--tasks", default=None)
    ap.add_argument("--build", action="store_true")
    a = ap.parse_args()

    import yaml

    conds = {c["name"]: c for c in yaml.safe_load((ROOT / "eval" / "conditions.yaml").read_text(encoding="utf-8"))["conditions"]}
    chosen = [conds[n] for n in a.conditions.split(",")]
    ev.keep_awake()
    ev.ensure_sites()
    ev.build_extensions({c["extension"] for c in chosen}, a.build)
    if not ev.up("http://localhost:11436/v1/models"):
        print("starting the oracle ...")
        import subprocess as sp

        sp.Popen([sys.executable, "-m", "uvicorn", "oracle_vlm:app", "--port", "11436"], cwd=HERE, creationflags=ev.DETACHED, stdout=sp.DEVNULL, stderr=sp.DEVNULL)
        ev.wait_for("http://localhost:11436/v1/models", "oracle")
    for c in chosen:
        print(f"\n=== {c['name']} ===")
        ev.start_agent_server(c["model"], c["base_url"], c.get("server_env"))
        cmd = ["node", "run_tasks.mjs", "--condition", c["name"], "--runs", "1", "--tasks-dir", str(HERE / "tasks_gen")]
        if a.limit:
            cmd += ["--limit", str(a.limit)]
        if a.tasks:
            cmd += ["--tasks", a.tasks]
        if a.resume:
            cmd += ["--resume"]
        subprocess.run(cmd, cwd=ROOT / "eval", check=False)
    # leave the agent server pointed at nothing special: the next evaluation restarts it per condition


if __name__ == "__main__":
    main()
