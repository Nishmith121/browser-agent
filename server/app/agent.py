"""One sanitised observation in, one validated action out."""
import time

from . import audit, config, vlm
from .parser import ActionError, parse_action
from .prompt import SYSTEM_PROMPT, user_text
from .schemas import AskUser, StepRequest, StepResponse


async def decide(req: StepRequest) -> StepResponse:
    t0 = time.perf_counter()
    raw, error = "", None
    for attempt in range(2):  # one retry with the validation error appended
        try:
            raw = await vlm.complete(SYSTEM_PROMPT, user_text(req, error), req.screenshot)
        except Exception as e:  # noqa: BLE001 - model unreachable etc. becomes an ask_user, not a 500
            action = AskUser(type="ask_user", question=f"The model server failed: {e}")
            audit.log_request(req, None, action.model_dump())
            return _resp("error", action, t0, str(e))
        try:
            action = parse_action(raw, req)
        except ActionError as e:
            error = str(e)
            continue
        audit.log_request(req, raw, action.model_dump())
        return _resp("done" if action.type == "done" else "continue", action, t0)
    action = AskUser(type="ask_user", question=f"I could not choose a valid action ({error}).")
    audit.log_request(req, raw, action.model_dump())
    return _resp("error", action, t0, error or "")


def _resp(status, action, t0, message: str = "") -> StepResponse:
    return StepResponse(
        status=status,
        action=action,
        model=config.VLM_MODEL,
        latency_ms=round((time.perf_counter() - t0) * 1000),
        message=message,
    )
