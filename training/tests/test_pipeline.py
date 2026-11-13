import io
import json
import random
import sys
from pathlib import Path

import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import chat_format  # noqa: E402
import eval_offline  # noqa: E402
import mind2web_builder as mb  # noqa: E402
import oracle_vlm as oracle  # noqa: E402
from app.prompt import user_text  # noqa: E402
from app.schemas import StepRequest  # noqa: E402
from redact_py import RedactionMap  # noqa: E402


def req(task, elements, texts=(), history=(), step=1, url="http://localhost:8080/demobank/login", secrets=()):
    return StepRequest(session_id="s", step=step, task=task, url=url, title="t", screenshot="", viewport={"width": 1280, "height": 800},
                       elements=elements, texts=list(texts), history=list(history), available_secrets=list(secrets))


LOGIN_ELS = [
    {"id": 1, "tag": "input", "type": "text", "label": "Username"},
    {"id": 2, "tag": "input", "type": "password", "label": "Password", "redacted": True, "category": "PASSWORD"},
    {"id": 3, "tag": "button", "type": "submit", "text": "Sign in"},
]


# ---- chat format ------------------------------------------------------------------------------
def test_sample_uses_the_server_prompt_and_validates_the_action():
    r = req("Log in", LOGIN_ELS)
    s = chat_format.make_sample("id1", "synthetic", "demobank", "train", "redacted", "images/x.png", r, {"type": "click", "element_id": 3})
    assert s["messages"][0]["content"] == chat_format.SYSTEM_PROMPT
    assert s["messages"][1]["content"][1]["text"] == user_text(r)
    assert json.loads(s["messages"][2]["content"]) == {"type": "click", "element_id": 3}
    with pytest.raises(Exception):
        chat_format.make_sample("id2", "synthetic", "x", "train", "redacted", "i", r, {"type": "fly"})


def test_split_is_by_website_and_stable():
    assert chat_format.split_for("shopmart", test_sites={"shopmart"}) == "test"
    assert chat_format.split_for("demobank", test_sites={"shopmart"}) == "train"
    assert chat_format.split_for("espn") == chat_format.split_for("espn")


# ---- the oracle -------------------------------------------------------------------------------
def decide(r):
    return oracle.decide(oracle.parse(user_text(r)))


def test_oracle_logs_in_step_by_step_and_stops_when_logged_in():
    t = "Log in to DemoBank as user12 using the stored password"
    assert decide(req(t, LOGIN_ELS, step=1)) == {"type": "type", "element_id": 1, "text": "user12", "clear_first": True}
    h = [{"step": 1, "action": {"type": "type", "element_id": 1, "text": "user12"}, "result": "ok"}]
    assert decide(req(t, LOGIN_ELS, step=2, history=h)) == {"type": "type", "element_id": 2, "text": "{PASSWORD}", "clear_first": True}
    h.append({"step": 2, "action": {"type": "type", "element_id": 2, "text": "{PASSWORD}"}, "result": "ok"})
    assert decide(req(t, LOGIN_ELS, step=3, history=h)) == {"type": "click", "element_id": 3}
    nav = [{"id": 1, "tag": "a", "text": "Dashboard"}, {"id": 2, "tag": "a", "text": "Log out"}]
    assert decide(req(t, nav, step=4, history=h, url="http://localhost:8080/demobank/dashboard"))["type"] == "done"


def test_oracle_uses_placeholders_from_the_task_and_does_not_retype_on_a_new_page():
    t = "Change my mobile number to [PHONE_2] and save the changes"
    els = [{"id": 5, "tag": "input", "type": "tel", "label": "Mobile number", "value": "[PHONE_1]", "redacted": True},
           {"id": 7, "tag": "button", "text": "Save changes"}]
    url = "http://localhost:8080/demobank/profile"
    a1 = decide(req(t, els, url=url))
    assert a1 == {"type": "type", "element_id": 5, "text": "[PHONE_2]", "clear_first": True}
    h = [{"step": 1, "action": a1, "result": "ok"}]
    assert decide(req(t, els, step=2, history=h, url=url)) == {"type": "click", "element_id": 7}
    assert decide(req(t, els, step=3, history=h, url=url, texts=["Saved"]))["type"] == "done"


def test_oracle_adds_the_right_product_by_position():
    texts = ["Search products", "Wireless mouse", "Rs 799", "Add to cart", "Mechanical keyboard", "Rs 3499", "Add to cart"]
    els = [{"id": 3, "tag": "button", "text": "Add to cart"}, {"id": 4, "tag": "button", "text": "Add to cart"}]
    a = decide(req("Add the Mechanical keyboard to the cart", els, texts, url="http://localhost:8080/shopmart/search"))
    assert a == {"type": "click", "element_id": 4}


# ---- offline scoring --------------------------------------------------------------------------
def test_offline_score():
    gold = {"type": "type", "element_id": 2, "text": "[PHONE_1]", "clear_first": True}
    assert eval_offline.score('{"type":"type","element_id":2,"text":"[PHONE_1]"}', gold) == {"valid": True, "type": True, "element": True, "exact": True}
    assert eval_offline.score('Sure: {"type":"type","element_id":3,"text":"[PHONE_1]"}', gold)["element"] is False
    assert eval_offline.score('{"type":"click","element_id":2}', gold)["type"] is False
    assert eval_offline.score("no json", gold)["valid"] is False
    assert eval_offline.score('{"type":"done","summary":"x"}', {"type": "done", "summary": "y"})["exact"] is True


# ---- Mind2Web builder on a small synthetic row -------------------------------------------------
def _row():
    img = Image.new("RGB", (1280, 1500), (255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")

    def cand(tag, bid, box, **attrs):
        return json.dumps({"tag": tag, "attributes": json.dumps({"backend_node_id": bid, "bounding_box_rect": ",".join(map(str, box)), **attrs}),
                           "is_original_target": False, "is_top_level_target": False, "backend_node_id": bid})

    target = json.loads(cand("input", "11", [400, 700, 300, 30], type="password"))
    target["is_original_target"] = True
    html = ('<html><body><label backend_node_id="9">Password</label><input backend_node_id="11" type="password" aria-label="Password"/>'
            '<a backend_node_id="12">Contact 9876543210</a><button backend_node_id="13">Sign in</button></body></html>')
    return {
        "action_uid": "u1", "annotation_id": "a1", "website": "bank", "cleaned_html": html, "confirmed_task": "Log in and call 9876543210",
        "operation": json.dumps({"original_op": "TYPE", "value": "hunter2", "op": "TYPE"}), "target_action_index": "0", "action_reprs": ["[input] Password -> TYPE: hunter2"],
        "pos_candidates": [json.dumps(target)],
        "neg_candidates": [cand("a", "12", [100, 600, 250, 20]), cand("button", "13", [400, 760, 100, 30]), cand("html", "1", [0, 0, 1280, 1500])],
        "screenshot": {"bytes": buf.getvalue()},
    }


def test_mind2web_builder_redacts_like_the_browser():
    req_, action, crop = mb.build_step(_row(), RedactionMap(), "redacted", random.Random(0))
    els = {e.id: e for e in req_.elements}
    pw = next(e for e in req_.elements if e.type == "password")
    assert pw.redacted and pw.category == "PASSWORD" and pw.label == "Password"
    assert action == {"type": "type", "element_id": pw.id, "text": "{PASSWORD}", "clear_first": True}  # a typed secret becomes a vault placeholder
    assert "9876543210" not in req_.task and "[PHONE_1]" in req_.task
    link = next(e for e in req_.elements if e.tag == "a")
    assert "9876543210" not in json.dumps(link.model_dump()) and "[PHONE_1]" in link.label
    assert req_.available_secrets == ["PASSWORD"] and "hunter2" not in json.dumps(req_.model_dump())
    # viewport crop is 1280x720 around the target; the password box (page y 700-730) sits at y 345-375 in the crop, painted black
    assert crop.size == (1280, 720) and crop.getpixel((550, 360)) == (0, 0, 0)
    assert len(els) == 3  # the full-page <html> candidate is not listed


def test_mind2web_clean_condition_keeps_everything_raw():
    req_, action, _ = mb.build_step(_row(), RedactionMap(), "clean", random.Random(0))
    assert "9876543210" in req_.task and action["text"] == "hunter2"
    assert not any(e.redacted for e in req_.elements)
