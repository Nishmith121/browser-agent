"""The full check suite (Phase 9 acceptance: it must run clean twice in a row).

  python run_all.py              # one pass
  python run_all.py --passes 2   # the acceptance run

It needs no GPU and no real model. It starts what is missing: the test sites (8080), a scripted fake model (11435) and its own
agent server (8001), so a model server you already run on 8000 is left alone. Every step has an explicit pass rule; a step that
only exits 0 is not trusted when its output has numbers to check (recall, precision, leakage).

Not in this suite on purpose (hours, and they need the real model): the Phase 6 task-success baselines (`run_eval.py`) and the
Phase 7/8 training runs.
"""
import argparse
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
EXT = ROOT / "extension"
NPX = "npx.cmd" if os.name == "nt" else "npx"
NPM = "npm.cmd" if os.name == "nt" else "npm"
NODE = "node"
AGENT_PORT, FAKE_PORT = 8001, 11435


def up(url: str) -> bool:
    try:
        urllib.request.urlopen(url, timeout=3).read(32)
        return True
    except Exception:  # noqa: BLE001
        return False


def start(name: str, cmd: list[str], cwd: Path, url: str, env: dict | None = None, tries: int = 40) -> subprocess.Popen | None:
    if up(url):
        print(f"  [{name}] already running")
        return None
    p = subprocess.Popen(cmd, cwd=cwd, env={**os.environ, **(env or {})}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(tries):
        if up(url):
            print(f"  [{name}] started")
            return p
        time.sleep(0.5)
    p.terminate()
    raise RuntimeError(f"could not start {name}")


def run(cmd: list[str], cwd: Path, env: dict | None = None, timeout: int = 1500) -> tuple[int, str]:
    r = subprocess.run(cmd, cwd=cwd, env={**os.environ, "PYTHONIOENCODING": "utf-8", **(env or {})}, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def pct(text: str, label: str) -> float | None:
    m = re.search(rf"{label}[^0-9]*([0-9.]+)%", text)
    return float(m.group(1)) if m else None


# Each rule returns (ok, detail). `code` is the process exit status, `out` the combined output.
def rule_exit(code, out):
    return code == 0, "exit 0" if code == 0 else f"exit {code}: {out.strip().splitlines()[-1][:120] if out.strip() else ''}"


def rule_vitest(code, out):
    out = re.sub(r"\x1b\[[0-9;]*m", "", out)  # vitest colours its summary; the codes split "Tests" from the count
    m = re.search(r"Tests\s+(\d+) passed", out)
    return code == 0 and bool(m) and "failed" not in out.split("Tests", 1)[-1][:60], m.group(0) if m else "no test summary"


def rule_pytest(code, out):
    m = re.search(r"(\d+) passed", out)
    return code == 0 and bool(m) and " failed" not in out, m.group(0) if m else "no summary"


def rule_no_clean(code, out):
    return "ok: dist has no clean-mode code" in out, out.strip().splitlines()[-1][:100] if out.strip() else "no output"


def rule_phase5(code, out):
    recall, prec = pct(out, r"TEXT PII \(structured \+ names \+ addresses\): recall"), pct(out, r"redaction precision \(painted area on ground truth\):")
    leaked = re.search(r"leaked in JSON: (\d+)", out)
    face = re.search(r"^FACE\s+\d+\s+([0-9.]+)%", out, re.M)
    ok = code == 0 and recall is not None and recall >= 95 and prec is not None and prec >= 80 and leaked is not None and int(leaked.group(1)) == 0 and face is not None and float(face.group(1)) >= 95
    return ok, f"recall {recall}%, precision {prec}%, leaked {leaked.group(1) if leaked else '?'}, faces {face.group(1) if face else '?'}%"


def rule_phase4_recall(code, out):
    return code == 0, ([l for l in out.splitlines() if "recall" in l.lower()] or ["exit 0"])[-1].strip()[:120]


def steps(agent_url: str) -> list[tuple[str, list[str], Path, dict | None, callable]]:
    p3 = {"AGENT_URL": agent_url}
    return [
        ("typecheck", [NPX, "tsc", "--noEmit"], EXT, None, rule_exit),
        ("extension unit tests", [NPX, "vitest", "run"], EXT, None, rule_vitest),
        ("build", [NPM, "run", "build"], EXT, None, rule_exit),
        ("no clean-mode code in the shipped build", [NPM, "run", "check:no-clean"], EXT, None, rule_no_clean),
        ("server tests", [sys.executable, "-m", "pytest", "tests", "-q"], ROOT / "server", None, rule_pytest),
        ("training tests", [sys.executable, "-m", "pytest", "tests", "-q"], ROOT / "training", None, rule_pytest),
        ("phase 1: capture and mark", [NODE, "phase1_check.mjs"], HERE, None, rule_exit),
        ("phase 2: privacy view and no sensitive values sent", [NODE, "phase2_check.mjs"], HERE, None, rule_exit),
        ("phase 3: login with a vault secret (scripted model)", [NODE, "phase3_check.mjs", "1"], HERE, p3, rule_exit),
        ("phase 4: structured-PII recall on all sites", [NODE, "phase4_recall.mjs"], HERE, None, rule_phase4_recall),
        ("phase 4: placeholder round trip (scripted model)", [NODE, "phase4_roundtrip.mjs"], HERE, p3, rule_exit),
        ("phase 5: recall, precision, faces, leakage", [NODE, "phase5_eval.mjs", "3", ",dark,serif,large,shift", "wasm"], HERE, None, rule_phase5),
        ("phase 9: settings, guards, ask_user, resume", [NODE, "phase9_check.mjs"], HERE, None, rule_exit),
    ]


def one_pass(n: int, agent_url: str) -> bool:
    print(f"\n=== pass {n} ===")
    ok_all = True
    for name, cmd, cwd, env, rule in steps(agent_url):
        t0 = time.time()
        try:
            code, out = run(cmd, cwd, env)
            ok, detail = rule(code, out)
        except subprocess.TimeoutExpired:
            ok, detail, out = False, "timed out", ""
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  [{time.time() - t0:.0f}s]  {detail}")
        if not ok:
            ok_all = False
            print("        " + "\n        ".join(out.strip().splitlines()[-12:]))
    return ok_all


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--passes", type=int, default=1)
    a = ap.parse_args()
    procs = []
    try:
        print("services:")
        procs.append(start("test sites :8080", [sys.executable, "serve.py"], ROOT / "testsites", "http://localhost:8080/demobank/login"))
        procs.append(start("fake model :%d" % FAKE_PORT, [sys.executable, "-m", "uvicorn", "fake_vlm:app", "--port", str(FAKE_PORT)], HERE, f"http://localhost:{FAKE_PORT}/v1/models"))
        procs.append(start("agent server :%d" % AGENT_PORT, [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(AGENT_PORT)], ROOT / "server", f"http://localhost:{AGENT_PORT}/health",
                           env={"VLM_BASE_URL": f"http://localhost:{FAKE_PORT}/v1", "VLM_MODEL": "fake"}))
        results = [one_pass(i + 1, f"http://localhost:{AGENT_PORT}") for i in range(a.passes)]
        print(f"\nsuite: {sum(results)}/{len(results)} passes clean")
        return 0 if all(results) else 1
    finally:
        for p in procs:
            if p:
                p.terminate()


if __name__ == "__main__":
    sys.exit(main())
