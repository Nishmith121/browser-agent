"""Audit log: every request payload is written to disk so evaluation can prove no ground-truth PII arrived."""
import base64
import json
import re
import shutil
import time

from . import config
from .prompt import PROMPT_VERSION
from .schemas import StepRequest

_SAFE = re.compile(r"[^A-Za-z0-9_-]")


def _dir(session_id: str):
    return config.LOG_DIR / _SAFE.sub("_", session_id)[:64]


def log_request(req: StepRequest, raw_reply: str | None = None, action: dict | None = None) -> None:
    d = _dir(req.session_id)
    d.mkdir(parents=True, exist_ok=True)
    payload = req.model_dump()
    shot = payload.pop("screenshot")
    b64 = shot.split(",", 1)[-1]
    try:
        (d / f"step{req.step:03d}.png").write_bytes(base64.b64decode(b64))
    except Exception:  # noqa: BLE001 - a bad image must not break logging
        pass
    entry = {"ts": time.time(), "prompt_version": PROMPT_VERSION, "request": payload, "raw_reply": raw_reply, "action": action}
    with (d / "requests.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def end_session(session_id: str) -> bool:
    d = _dir(session_id)
    if d.exists():
        shutil.rmtree(d)
        return True
    return False
