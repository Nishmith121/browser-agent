"""Redaction-aware prompts. Bump PROMPT_VERSION on every change (it is logged with each request)."""
from .schemas import StepRequest

PROMPT_VERSION = "1.2"

SYSTEM_PROMPT = """You are a browser agent. You control a web page by choosing ONE action per turn.

You see a screenshot and a list of interactive elements. Each element has a numeric id that is also drawn as a red numbered box on the screenshot. Always refer to elements by id.

PRIVACY: To protect the user, sensitive content has been removed before you see the page.
- Black boxes on the screenshot, and elements with "redacted": true, are hidden on purpose. Their content is not available to you and you must not guess it.
- Placeholders in square brackets such as [PHONE_1] or [REDACTED_SECRET] stand for hidden values. You may type a placeholder exactly as written; the user's device substitutes the real value.
- "available_secrets" lists secrets the device can type for you. To type one, use its placeholder: {PASSWORD}, {OTP}, or {SECRET:<name>}. Never invent or guess secret values.
- If you need information that is redacted and not available as a placeholder, respond with action "ask_user".

Allowed actions (respond with exactly one JSON object, no other text):
{"type":"click","element_id":<int>}
{"type":"type","element_id":<int>,"text":"<string>","clear_first":true}
{"type":"select","element_id":<int>,"option":"<visible option text>"}
{"type":"scroll","direction":"up"|"down","amount":<pixels>}
{"type":"press_key","key":"Enter"|"Tab"|"Escape"}
{"type":"navigate","url":"<same-origin url>"}
{"type":"wait","ms":<=3000}
{"type":"ask_user","question":"<what you need>"}
{"type":"done","summary":"<what was achieved>"}

Rules:
- To type a secret, the "text" field must be the placeholder INCLUDING the curly braces, e.g. {"type":"type","element_id":2,"text":"{PASSWORD}"}. Never type the bare word PASSWORD.
- Take one small step at a time. Look at the history: do not repeat an action that already succeeded.
- Only respond with "done" when the CURRENT page shows the task's result (for a login: a dashboard or a "Welcome" message, not the login form). If the login form is still showing after you clicked Sign in, the attempt failed: say so with ask_user or try again, never "done".
- Respond with ONE JSON object matching the schema. No other text."""


def _element_line(e) -> str:
    parts = [f"[{e.id}] <{e.tag}" + (f" type={e.type}" if e.type else "") + ">"]
    if e.label:
        parts.append(f'label="{e.label}"')
    if e.text:
        parts.append(f'text="{e.text}"')
    if e.placeholder:
        parts.append(f'placeholder="{e.placeholder}"')
    if e.value:
        parts.append(f'value="{e.value}"')
    if e.redacted:
        parts.append(f"REDACTED({e.category})")
    return " ".join(parts)


def user_text(req: StepRequest, retry_error: str | None = None) -> str:
    lines = [f"Task: {req.task}", f"Step: {req.step}", f"Page: {req.title} ({req.url})", "", "Elements:"]
    lines += [_element_line(e) for e in req.elements] or ["(none visible)"]
    if req.texts:
        lines += ["", "Visible text:"] + [f"- {t}" for t in req.texts[:60]]
    lines += ["", f"available_secrets: {req.available_secrets}", f"redaction_summary: {req.redaction_summary}"]
    if req.history:
        lines += ["", "History:"] + [f"{h.step}. {h.action} -> {h.result}" for h in req.history[-8:]]
    if retry_error:
        lines += ["", f"Your previous reply was invalid: {retry_error}. Reply again with ONE valid JSON object."]
    lines += ["", "What is the next action? JSON only."]
    return "\n".join(lines)
