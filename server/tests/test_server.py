import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import audit, config, vlm  # noqa: E402
from app.main import app  # noqa: E402
from app.parser import ActionError, extract_json, parse_action, pii_in_typed_text  # noqa: E402
from app.schemas import StepRequest  # noqa: E402

PNG = "data:image/png;base64,iVBORw0KGgo="


def make_req(**kw) -> StepRequest:
    base = dict(
        session_id="s1", step=1, task="log in", screenshot=PNG,
        viewport={"width": 1280, "height": 800},
        elements=[
            {"id": 1, "tag": "input", "type": "text", "label": "Username"},
            {"id": 2, "tag": "input", "type": "password", "label": "Password", "redacted": True, "category": "PASSWORD"},
        ],
        available_secrets=["PASSWORD"],
    )
    base.update(kw)
    return StepRequest(**base)


def test_extract_json_handles_prose_and_fences():
    assert json.loads(extract_json('Sure!\n```json\n{"type":"click","element_id":1}\n```')) == {"type": "click", "element_id": 1}
    assert json.loads(extract_json('{"type":"done","summary":"a } b"}')) == {"type": "done", "summary": "a } b"}
    with pytest.raises(ActionError):
        extract_json("no json here")


def test_parse_valid_and_invalid_actions():
    r = make_req()
    assert parse_action('{"type":"click","element_id":1}', r).type == "click"
    assert parse_action('{"type":"type","element_id":2,"text":"{PASSWORD}"}', r).clear_first is True
    for bad in ['{"type":"click","element_id":99}', '{"type":"fly"}', '{"type":"wait","ms":99999}', "{not json"]:
        with pytest.raises(ActionError):
            parse_action(bad, r)


def test_typed_pii_rejected_but_placeholders_allowed():
    r = make_req()
    assert pii_in_typed_text("9876543210") == "phone"
    assert pii_in_typed_text("a.b@example.com") == "email"
    assert pii_in_typed_text("4111 1111 1111 1111") is not None  # aadhaar or card rule
    assert pii_in_typed_text("{PASSWORD}") is None
    assert pii_in_typed_text("[PHONE_1]") is None
    with pytest.raises(ActionError):
        parse_action('{"type":"type","element_id":1,"text":"9876543210"}', r)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "LOG_DIR", tmp_path)
    return TestClient(app)


def _body(**kw):
    return make_req(**kw).model_dump()


def test_step_retries_once_with_error_then_succeeds(client, monkeypatch):
    replies = iter(["I will click 99", '{"type":"click","element_id":1}'])
    prompts = []

    async def fake(system, user, shot):
        prompts.append(user)
        return next(replies)

    monkeypatch.setattr(vlm, "complete", fake)
    r = client.post("/v1/step", json=_body()).json()
    assert r["status"] == "continue" and r["action"] == {"type": "click", "element_id": 1}
    assert "previous reply was invalid" in prompts[1]


def test_step_falls_back_to_ask_user_after_two_failures(client, monkeypatch):
    async def fake(*a):
        return "garbage"

    monkeypatch.setattr(vlm, "complete", fake)
    r = client.post("/v1/step", json=_body()).json()
    assert r["status"] == "error" and r["action"]["type"] == "ask_user"


def test_model_down_is_ask_user_not_500(client, monkeypatch):
    async def fake(*a):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(vlm, "complete", fake)
    r = client.post("/v1/step", json=_body())
    assert r.status_code == 200 and r.json()["action"]["type"] == "ask_user"


def test_audit_log_written_and_cleared(client, monkeypatch, tmp_path):
    async def fake(*a):
        return '{"type":"done","summary":"ok"}'

    monkeypatch.setattr(vlm, "complete", fake)
    r = client.post("/v1/step", json=_body(session_id="sess/1")).json()
    assert r["status"] == "done"
    d = next(tmp_path.iterdir())
    entry = json.loads((d / "requests.jsonl").read_text().splitlines()[0])
    assert "screenshot" not in entry["request"] and entry["request"]["task"] == "log in"
    assert (d / "step001.png").exists()
    assert client.post("/v1/session/end", json={"session_id": "sess/1"}).json() == {"cleared": True}
    assert not d.exists()


def test_prompt_mentions_redaction_and_placeholders():
    from app.prompt import SYSTEM_PROMPT, user_text

    assert "{PASSWORD}" in SYSTEM_PROMPT and "ask_user" in SYSTEM_PROMPT
    assert "REDACTED(PASSWORD)" in user_text(make_req())


def test_health_model_installed_matches_latest_tag():
    from app.vlm import _installed

    assert _installed("qwen3-vl-2b-8k", ["qwen3-vl-2b-8k:latest"])
    assert _installed("qwen3-vl:4b", ["qwen3-vl:4b"])
    assert not _installed("qwen3-vl-2b-8k", ["qwen3-vl:4b"])


def test_empty_model_content_gives_actionable_error(monkeypatch):
    import asyncio

    import httpx

    from app import vlm

    class FakeClient:
        def __init__(self, *a, **k): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *a): ...
        async def post(self, *a, **k):
            return httpx.Response(200, json={"choices": [{"message": {"content": "", "reasoning": "hmm"}, "finish_reason": "length"}]},
                                  request=httpx.Request("POST", "http://x"))

    monkeypatch.setattr(vlm.httpx, "AsyncClient", FakeClient)
    with pytest.raises(RuntimeError, match="Instruct variant"):
        asyncio.run(vlm.complete("s", "u", PNG))


def test_bare_secret_name_becomes_placeholder():
    r = make_req(available_secrets=["PASSWORD", "OTP", "payee"])
    assert parse_action('{"type":"type","element_id":2,"text":"PASSWORD"}', r).text == "{PASSWORD}"
    assert parse_action('{"type":"type","element_id":2,"text":"[PASSWORD]"}', r).text == "{PASSWORD}"
    assert parse_action('{"type":"type","element_id":2,"text":"password"}', r).text == "{PASSWORD}"
    assert parse_action('{"type":"type","element_id":2,"text":"{OTP}"}', r).text == "{OTP}"
    assert parse_action('{"type":"type","element_id":2,"text":"payee"}', r).text == "{SECRET:payee}"
    assert parse_action('{"type":"type","element_id":1,"text":"user00"}', r).text == "user00"  # normal text untouched


def test_typed_pii_check_is_on_by_default_and_only_off_for_the_eval_baseline(monkeypatch):
    r = make_req()
    bad = '{"type":"type","element_id":1,"text":"9876543210"}'
    with pytest.raises(ActionError):
        parse_action(bad, r)
    monkeypatch.setattr(config, "ALLOW_TYPED_PII", True)  # what ALLOW_TYPED_PII=1 does (evaluation-only)
    assert parse_action(bad, r).text == "9876543210"
