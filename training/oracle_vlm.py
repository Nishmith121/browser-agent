"""Scripted expert ("oracle") standing in for the VLM, so the REAL extension pipeline can record expert
trajectories on the synthetic sites. It speaks the OpenAI chat API like Ollama/vLLM do, reads only the text
of the prompt (never the image), and answers with the gold action for the current step.

  uvicorn oracle_vlm:app --port 11436

The agent server logs every request and the redacted screenshot, so the server's audit log of an oracle run
IS the training data: the exact observation the model would see and the gold action for it (build_dataset.py).
"""
from __future__ import annotations

import ast
import asyncio
import json
import os
import re
from dataclasses import dataclass, field

from fastapi import FastAPI

app = FastAPI()
# Seconds to wait before answering (default 0). Only for the demo recording (eval/record_demo.mjs), so each step stays on
# screen long enough to read; a real VLM takes about this long anyway.
DELAY_S = float(os.getenv("ORACLE_DELAY_S", "0"))

# ---- parsing the user prompt (format: server/app/prompt.py) ----------------------------------
_EL = re.compile(r'^\[(\d+)\] <(\w+)(?: type=(\S+))?>\s*(.*)$')


@dataclass
class El:
    id: int
    tag: str
    type: str | None
    label: str = ""
    text: str = ""
    placeholder: str = ""
    value: str = ""
    redacted: bool = False


@dataclass
class Page:
    task: str
    step: int
    url: str
    els: list[El]
    texts: list[str]
    history: list[dict]
    secrets: list[str] = field(default_factory=list)

    def by_label(self, *labels: str) -> El | None:
        for want in labels:
            for e in self.els:
                if e.tag in ("input", "select", "textarea") and e.label.strip().lower() == want.lower():
                    return e
        return None

    def by_text(self, *texts: str, tag: str | None = None) -> El | None:
        for want in texts:
            for e in self.els:
                if (tag is None or e.tag == tag) and (e.text.strip().lower() == want.lower() or e.label.strip().lower() == want.lower()):
                    return e
        return None

    def has_text(self, *needles: str) -> bool:
        blob = " | ".join(self.texts).lower()
        return any(n.lower() in blob for n in needles)


def parse(prompt: str) -> Page:
    task = re.search(r"^Task: (.*)$", prompt, re.M).group(1)
    step = int(re.search(r"^Step: (\d+)", prompt, re.M).group(1))
    m = re.search(r"^Page: .*\((.*)\)$", prompt, re.M)
    els: list[El] = []
    for line in prompt.split("Elements:\n", 1)[1].split("\n\n", 1)[0].splitlines():
        m2 = _EL.match(line)
        if not m2:
            continue
        rest = m2.group(4)
        e = El(int(m2.group(1)), m2.group(2), m2.group(3))
        e.redacted = "REDACTED(" in rest
        for key in ("label", "text", "placeholder", "value"):
            mm = re.search(rf'{key}="(.*?)"(?= (?:label|text|placeholder|value)=|\s*REDACTED|$)', rest)
            if mm:
                setattr(e, key, mm.group(1))
        els.append(e)
    texts = [t[2:] for t in prompt.split("Visible text:\n", 1)[1].split("\n\n", 1)[0].splitlines()] if "Visible text:\n" in prompt else []
    hist = []
    if "History:\n" in prompt:
        for line in prompt.split("History:\n", 1)[1].split("\n\n", 1)[0].splitlines():
            mh = re.match(r"^(\d+)\. (\{.*\}) -> (.*)$", line)
            if mh:
                hist.append({"step": int(mh.group(1)), "action": ast.literal_eval(mh.group(2)), "result": mh.group(3)})
    sec = re.search(r"^available_secrets: (\[.*\])$", prompt, re.M)
    return Page(task, step, m.group(1) if m else "", els, texts, hist, ast.literal_eval(sec.group(1)) if sec else [])


# ---- per-session memory: which page each step was on, so "already typed" only counts on this page ----
class Session:
    task = ""
    urls: dict[int, str] = {}


def epoch_start(p: Page) -> int:
    """First step (of the contiguous stretch ending now) that was on the current page."""
    if p.step == 1 or Session.task != p.task:
        Session.task, Session.urls = p.task, {}
    Session.urls[p.step] = p.url
    s = p.step
    while s - 1 in Session.urls and Session.urls[s - 1] == p.url:
        s -= 1
    return s


def done_on_page(p: Page, el: El, kind: str, value: str, since: int) -> bool:
    for h in p.history:
        a = h["action"]
        if h["step"] >= since and a.get("element_id") == el.id and a.get("type") == kind:
            if (kind == "type" and a.get("text") == value) or (kind == "select" and a.get("option") == value):
                return True
    return False


def clicked_on_page(p: Page, el: El, since: int) -> bool:
    return any(h["step"] >= since and h["action"].get("type") == "click" and h["action"].get("element_id") == el.id for h in p.history)


def done(msg: str) -> dict:
    return {"type": "done", "summary": msg}


# ---- value extraction from the task text (placeholders in redacted mode, raw values in clean mode) ----
PH = {"phone": r"(\[PHONE_\d+\]|\b[6-9]\d{9}\b)", "email": r"(\[EMAIL_\d+\]|[\w.+-]+@[\w.-]+\.\w+)"}


def first(rx: str, s: str, flags=0) -> str | None:
    m = re.search(rx, s, flags)
    return m.group(1).strip() if m else None


def address_value(task: str) -> str | None:
    return first(r"address to (.+?)(?: using| and save| and place|, fill|$)", task)


# ---- the policy -------------------------------------------------------------------------------
def fill_then_submit(p: Page, since: int, fields: list[tuple[tuple[str, ...], str, str]], submit: tuple[str, ...], success: tuple[str, ...]) -> dict | None:
    """fields: ((label candidates), kind, value). Returns the next action or None if this page has none of the fields."""
    found = False
    for labels, kind, value in fields:
        el = p.by_label(*labels)
        if el is None:
            continue
        found = True
        if not done_on_page(p, el, kind, value, since):
            return {"type": "type", "element_id": el.id, "text": value, "clear_first": True} if kind == "type" else {"type": "select", "element_id": el.id, "option": value}
    if not found:
        return None
    if p.has_text(*success):
        return done("The form was submitted.")
    btn = p.by_text(*submit, tag="button")
    return {"type": "click", "element_id": btn.id} if btn else None


def decide(p: Page) -> dict:
    t = p.task
    since = epoch_start(p)

    # login
    if re.search(r"\blog in\b", t, re.I) and p.by_label("Username") and p.by_label("Password"):
        user = first(r"\bas (\w+)", t) or first(r"(user\d+)", t)
        act = fill_then_submit(p, since, [(("Username",), "type", user), (("Password",), "type", "{PASSWORD}")], ("Sign in",), ())
        if act:
            return act
    logged_in = p.by_text("Log out") is not None
    if re.search(r"\blog in\b", t, re.I) and not re.search(r"\b(then|, then)\b", t, re.I) and logged_in:
        return done("Logged in.")

    # leave the meeting
    if re.search(r"leave (the )?meeting", t, re.I):
        if p.has_text("You left the meeting"):
            return done("Left the meeting.")
        b = p.by_text("Leave meeting", tag="button")
        if b:
            return {"type": "click", "element_id": b.id}

    # open a page
    for phrase, link, marker in (("ID card page", "ID card", "Employee ID card"), ("medical records", "Records", "Medical record")):
        if re.search(phrase, t, re.I) and not re.search(r"\bthen\b", t, re.I):
            if p.has_text(marker):
                return done(f"Opened {link}.")
            l = p.by_text(link)
            if l:
                return {"type": "click", "element_id": l.id}

    # navigate before a form when the task says so (or the form is on another page)
    if re.search(r"open profile|then open profile", t, re.I) and not p.by_label("Mobile number"):
        l = p.by_text("Profile")
        if l and not p.has_text("Saved"):
            return {"type": "click", "element_id": l.id}
    if re.search(r"open the transfer page", t, re.I) and not p.by_label("Payee account number"):
        l = p.by_text("Transfer") or p.by_text("New transfer")
        if l:
            return {"type": "click", "element_id": l.id}

    # profile / contact / address updates
    phone = first(PH["phone"], t)
    addr = address_value(t)
    if re.search(r"mobile number to", t, re.I) and phone:
        act = fill_then_submit(p, since, [(("Mobile number",), "type", phone)], ("Save changes",), ("Saved",))
        if act:
            return act
    if re.search(r"contact number field to", t, re.I) and phone:
        act = fill_then_submit(p, since, [(("Contact number",), "type", phone)], ("Save",), ("Address updated",))
        if act:
            return act
    if addr and re.search(r"update my address|change my address", t, re.I):
        act = fill_then_submit(p, since, [(("Update address", "Address"), "type", addr)], ("Save changes", "Save"), ("Saved", "Address updated"))
        if act:
            return act

    # payee
    acct = first(r"account number (\[ACCOUNT_\d+\]|\d{9,18})", t)
    ifsc = first(r"IFSC (\[IFSC_\d+\]|[A-Z]{4}0[A-Z0-9]{6})", t)
    amount = first(r"(?:Send|send) (\d+) rupees", t)
    if acct and ifsc and amount:
        act = fill_then_submit(p, since, [(("Payee account number",), "type", acct), (("Payee IFSC",), "type", ifsc), (("Amount (Rs)",), "type", amount)], ("Send",), ("Transfer sent",))
        if act:
            return act

    # leave request / appointment
    lt = first(r"(casual|sick|earned) leave", t, re.I)
    dates = re.findall(r"\d{2}/\d{2}/\d{4}", t)
    if lt and len(dates) == 2:
        reason = first(r"reason (.+)$", t) or ""
        act = fill_then_submit(p, since, [(("Leave type",), "select", f"{lt.capitalize()} leave"), (("From (DD/MM/YYYY)",), "type", dates[0]),
                                          (("To (DD/MM/YYYY)",), "type", dates[1]), (("Reason",), "type", reason)], ("Submit leave request",), ("Leave request submitted",))
        if act:
            return act
    dept = first(r"\b(Cardiology|Dermatology|Neurology|Orthopaedics|Paediatrics)\b", t)
    if dept and len(dates) == 1:
        act = fill_then_submit(p, since, [(("Department",), "select", dept), (("Preferred date (DD/MM/YYYY)",), "type", dates[0])], ("Book appointment",), ("Appointment booked",))
        if act:
            return act

    # shopping
    m = re.search(r"add the (.+?) to the cart", t, re.I)
    if m:
        product = m.group(1).strip().lower()
        if p.has_text("added to cart"):
            return done("Added to cart.")
        term = first(r"Search for (\w+)", t)
        sb = p.by_label("Search products")
        if term and sb and "q=" not in p.url:  # the search form is a GET: once the URL has a query, the search is done
            if not done_on_page(p, sb, "type", term, since):
                return {"type": "type", "element_id": sb.id, "text": term, "clear_first": True}
            return {"type": "click", "element_id": p.by_text("Search", tag="button").id}
        names = [x for i, x in enumerate(p.texts[:-1]) if re.match(r"^Rs \d+", p.texts[i + 1])]
        adds = [e for e in p.els if e.tag == "button" and e.text == "Add to cart"]
        for idx, n in enumerate(names):
            if n.lower() == product and idx < len(adds):
                return {"type": "click", "element_id": adds[idx].id}
    if re.search(r"place the order", t, re.I):
        fields = []
        if phone:
            fields.append((("Delivery phone",), "type", phone))
        if addr and re.search(r"delivery address to", t, re.I):
            fields.append((("Delivery address",), "type", first(r"delivery address to (.+?)(?:, fill|$)", t)))
        if re.search(r"card number", t, re.I):
            fields.append((("Card number",), "type", "{SECRET:card}"))
        if re.search(r"\bCVV\b", t):
            fields.append((("CVV",), "type", "{SECRET:cvv}"))
        act = fill_then_submit(p, since, fields, ("Place order",), ("Order placed",))
        if act:
            return act

    # mail
    subj_reply = first(r"subject (.+?) and reply", t) or first(r"about (.+?) and reply", t)
    reply_text = first(r"saying: (.+)$", t)
    if subj_reply and reply_text:
        if p.has_text("Message sent"):
            return done("Replied.")
        if p.by_label("Message"):
            act = fill_then_submit(p, since, [(("Message",), "type", reply_text)], ("Send",), ("Message sent",))
            if act:
                return act
        rb = p.by_text("Reply", tag="button")
        if rb:
            return {"type": "click", "element_id": rb.id}
        link = p.by_text(subj_reply)
        if link:
            return {"type": "click", "element_id": link.id}
    mm = re.search(r"to (\[EMAIL_\d+\]|[\w.+-]+@[\w.-]+\.\w+) with the subject (.+?) and the message:? (.+?)(?:, then send it)?$", t)
    if mm:
        act = fill_then_submit(p, since, [(("To",), "type", mm.group(1)), (("Subject",), "type", mm.group(2)), (("Message",), "type", mm.group(3))], ("Send",), ("Message sent",))
        if act:
            return act

    return {"type": "ask_user", "question": "I do not know how to continue on this page."}


@app.post("/v1/chat/completions")
async def chat(body: dict):
    parts = body["messages"][-1]["content"]
    text = next(x["text"] for x in parts if x["type"] == "text")
    if DELAY_S:
        await asyncio.sleep(DELAY_S)
    return {"choices": [{"message": {"role": "assistant", "content": json.dumps(decide(parse(text)))}}]}


@app.get("/v1/models")
async def models():
    return {"data": [{"id": "oracle"}]}
