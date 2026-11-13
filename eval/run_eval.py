"""One command that reproduces the baseline tables and charts.

  python run_eval.py                      # all enabled conditions, 3 runs each, then the report
  python run_eval.py --runs 1 --limit 8   # quick pass: 8 tasks, 1 run
  python run_eval.py --conditions qwen3vl-2b-redacted --resume
  python run_eval.py --report-only        # just rebuild tables/charts from eval/results/

It starts what is missing (test sites, Ollama, the agent server for each condition's model), builds the
extensions, drives Chromium through the tasks (run_tasks.mjs) and writes eval/reports/phase6/.
Results are appended per run, so a run that is interrupted (for example by low memory) continues with --resume.
"""
import argparse
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OLLAMA = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
DETACHED = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)


def up(url: str, timeout: float = 3) -> bool:
    try:
        urllib.request.urlopen(url, timeout=timeout).read(64)
        return True
    except Exception:  # noqa: BLE001
        return False


def listening_pids(port: int) -> set[int]:
    out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True).stdout
    return {int(m.group(1)) for m in re.finditer(rf":{port}\s+\S+\s+LISTENING\s+(\d+)", out)}


def stop_port(port: int) -> None:
    for pid in listening_pids(port):
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)


def wait_for(url: str, what: str, seconds: int = 90, contains: str | None = None) -> None:
    end = time.time() + seconds
    while time.time() < end:
        try:
            body = urllib.request.urlopen(url, timeout=3).read().decode()
            if contains is None or contains in body:
                return
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    sys.exit(f"{what} did not become ready at {url}")


def ensure_sites() -> None:
    if not up("http://localhost:8080/demobank/login"):
        print("starting test sites ...")
        subprocess.Popen([sys.executable, "serve.py"], cwd=ROOT / "testsites", creationflags=DETACHED, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for("http://localhost:8080/demobank/login", "test sites")


def ensure_ollama() -> None:
    if not up("http://localhost:11434/api/tags"):
        print("starting Ollama ...")
        subprocess.Popen([str(OLLAMA), "serve"], creationflags=DETACHED, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for("http://localhost:11434/api/tags", "Ollama")


def ollama_models() -> set[str]:
    out = subprocess.run([str(OLLAMA), "list"], capture_output=True, text=True).stdout
    return {line.split()[0].removesuffix(":latest") for line in out.splitlines()[1:] if line.strip()}


def build_extensions(need: set[str], force: bool) -> None:
    ext = ROOT / "extension"
    for name, script in (("dist", "build"), ("dist-clean", "build:clean")):
        if name in need and (force or not (ext / name / "manifest.json").exists()):
            print(f"building extension ({script}) ...")
            subprocess.run(f"npm run {script}", cwd=ext, shell=True, check=True, stdout=subprocess.DEVNULL)
    if "dist" in need:
        subprocess.run("npm run check:no-clean", cwd=ext, shell=True, check=True)  # the shipped build must not contain clean mode


def start_agent_server(model: str, base_url: str, extra_env: dict | None = None) -> None:
    stop_port(8000)
    time.sleep(1)
    env = {**os.environ, "VLM_MODEL": model, "VLM_BASE_URL": base_url, **(extra_env or {})}
    subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8000"], cwd=ROOT / "server", env=env,
                     creationflags=DETACHED, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_for("http://localhost:8000/health", "agent server", contains='"model_installed":true')


def keep_awake() -> None:
    """A sleeping or locked machine stalls Chrome's screenshot calls, which looks like a hung agent."""
    if sys.platform == "win32":
        import ctypes

        ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED = 0x80000000, 0x1, 0x2
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conditions", default="enabled", help="comma-separated condition names, or 'enabled'")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--tasks", default=None, help="comma-separated task ids")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--build", action="store_true", help="rebuild the extensions first")
    ap.add_argument("--report-only", action="store_true")
    a = ap.parse_args()

    conds = yaml.safe_load((HERE / "conditions.yaml").read_text(encoding="utf-8"))["conditions"]
    chosen = [c for c in conds if (c["enabled"] if a.conditions == "enabled" else c["name"] in a.conditions.split(","))]
    for c in chosen:  # base_url may name an environment variable, e.g. ${LORA_BASE_URL} for a tunnelled GPU server
        if c.get("base_url"):
            c["base_url"] = os.path.expandvars(c["base_url"])
            if "$" in c["base_url"]:
                raise SystemExit(f"{c['name']}: set the environment variable in base_url {c['base_url']}")
    local = [c for c in chosen if not c.get("base_url")]  # conditions served by Ollama on this machine

    if not a.report_only:
        keep_awake()
        ensure_sites()
        if local:
            ensure_ollama()
        installed = ollama_models() if local else set()
        build_extensions({c["extension"] for c in chosen}, a.build)
        for c in chosen:
            if not c.get("base_url") and c["model"].removesuffix(":latest") not in installed and "/" not in c["model"]:
                print(f"skip {c['name']}: model {c['model']} is not installed in Ollama")
                continue
            print(f"\n=== {c['name']} ({c['model']}) ===")
            start_agent_server(c["model"], c.get("base_url") or os.environ.get("VLM_BASE_URL", "http://localhost:11434/v1"), c.get("server_env"))
            cmd = ["node", "run_tasks.mjs", "--condition", c["name"], "--runs", str(a.runs)]
            if a.tasks:
                cmd += ["--tasks", a.tasks]
            if a.limit:
                cmd += ["--limit", str(a.limit)]
            if a.resume:
                cmd += ["--resume"]
            subprocess.run(cmd, cwd=HERE, check=False)
            if not c.get("base_url"):
                subprocess.run([str(OLLAMA), "stop", c["model"]], capture_output=True)  # free memory for the next model

    subprocess.run([sys.executable, "report.py"], cwd=HERE, check=True)


if __name__ == "__main__":
    main()
