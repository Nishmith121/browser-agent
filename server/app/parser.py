"""Turns raw VLM output into one validated action (Section 6, 'Action parsing')."""
import json
import re

from pydantic import ValidationError

from . import config
from .schemas import ActionAdapter, StepRequest

_PLACEHOLDER = re.compile(r"\{(?:PASSWORD|OTP|SECRET:[A-Za-z0-9_-]+)\}|\[[A-Z_]+_\d+\]|\[REDACTED_[A-Z_]+\]")

# Defence in depth: a typed value that looks like real PII and is not a placeholder is rejected.
_PII = {
    "email": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "phone": re.compile(r"(?<!\d)(?:\+91[\s-]?|0)?[6-9]\d{9}(?!\d)"),
    "aadhaar": re.compile(r"(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)"),
    "pan": re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"),
    "card": re.compile(r"(?<!\d)(?:\d[\s-]?){13,19}(?!\d)"),
}


class ActionError(ValueError):
    pass


def extract_json(text: str) -> str:
    """First balanced {...} object in the text (models sometimes wrap JSON in prose or fences)."""
    start = text.find("{")
    if start < 0:
        raise ActionError("no JSON object in reply")
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise ActionError("unterminated JSON object")


def pii_in_typed_text(text: str) -> str | None:
    bare = _PLACEHOLDER.sub(" ", text)
    for name, rx in _PII.items():
        if rx.search(bare):
            return name
    return None


def normalise_secret_name(text: str, available: list[str]) -> str:
    """Small models often type the bare secret name ('PASSWORD'); the placeholder syntax is what the device substitutes."""
    t = text.strip().strip("{}[]'\"")
    if t in available or t.upper() in available:
        name = t if t in available else t.upper()
        return "{" + name + "}" if name in ("PASSWORD", "OTP") else "{SECRET:" + name + "}"
    return text


def parse_action(raw: str, req: StepRequest):
    try:
        data = json.loads(extract_json(raw))
    except json.JSONDecodeError as e:
        raise ActionError(f"invalid JSON: {e}") from e
    try:
        action = ActionAdapter.validate_python(data)
    except ValidationError as e:
        first = e.errors()[0]
        raise ActionError(f"schema error at {'.'.join(map(str, first['loc']))}: {first['msg']}") from e

    ids = {el.id for el in req.elements}
    eid = getattr(action, "element_id", None)
    if eid is not None and eid not in ids:
        raise ActionError(f"element_id {eid} does not exist (valid ids: {sorted(ids)})")
    if action.type == "type":
        action.text = normalise_secret_name(action.text, req.available_secrets)
        kind = None if config.ALLOW_TYPED_PII else pii_in_typed_text(action.text)
        if kind:
            raise ActionError(f"typed text looks like {kind} PII; use a placeholder instead")
    return action
