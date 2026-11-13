"""One training sample = the exact chat the agent server sends the VLM at run time (Section 9.1):
system prompt (server/app/prompt.py), user turn = image + task + elements + history, assistant turn = action JSON.
Using the server's own prompt code means training and deployment cannot drift apart.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
from app.prompt import PROMPT_VERSION, SYSTEM_PROMPT, user_text  # noqa: E402
from app.schemas import ActionAdapter, StepRequest  # noqa: E402


def split_for(website: str, test_fraction: float = 0.2, test_sites: set[str] | None = None) -> str:
    """Split by WEBSITE, never by step, so test sites are unseen during training."""
    if test_sites is not None:
        return "test" if website in test_sites else "train"
    h = int(hashlib.sha1(website.encode()).hexdigest(), 16) % 1000
    return "test" if h < test_fraction * 1000 else "train"


def action_json(action: dict) -> str:
    """The assistant turn: one compact JSON object, validated against the wire schema."""
    ActionAdapter.validate_python(action)  # raises if the gold action is not a legal action
    return json.dumps(action, ensure_ascii=False, separators=(",", ":"))


def make_sample(sample_id: str, source: str, website: str, split: str, condition: str, image: str, req: StepRequest, action: dict) -> dict:
    return {
        "id": sample_id,
        "source": source,  # "mind2web" | "synthetic"
        "website": website,
        "split": split,  # "train" | "test"
        "condition": condition,  # "redacted" | "clean"
        "prompt_version": PROMPT_VERSION,
        "image": image,  # path relative to the dataset directory
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": user_text(req)}]},
            {"role": "assistant", "content": action_json(action)},
        ],
    }
