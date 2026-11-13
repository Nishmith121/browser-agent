"""Scripted stand-in for the VLM (OpenAI-compatible /v1/chat/completions) used to test the pipeline
plumbing deterministically. It reads the text prompt only, never the image.

  uvicorn fake_vlm:app --port 11435
"""
import re

from fastapi import FastAPI

app = FastAPI()


def element_id(text: str, label: str) -> int | None:
    m = re.search(rf'\[(\d+)\] <[^>]*> label="{label}"', text)
    return int(m.group(1)) if m else None


def decide(text: str) -> str:
    task = re.search(r"Task: (.*)", text).group(1)
    user = (re.search(r"as (\w+)", task) or re.search(r"(user\d+)", task) or re.search(r"(\w+)", task)).group(1)
    history = text.split("History:")[1] if "History:" in text else ""
    if "mobile number" in task.lower():  # scenario: change the phone number on the profile page
        ph = re.findall(r"\[PHONE_\d+\]", task)
        field = element_id(text, "Mobile number")
        if "- Saved" in text:
            return '{"type":"done","summary":"Mobile number saved."}'
        if "'type': 'type'" not in history and field and ph:
            return f'{{"type":"type","element_id":{field},"text":"{ph[-1]}"}}'
        m = re.search(r'\[(\d+)\] <button[^>]*> text="Save changes"', text)
        if "'type': 'click'" not in history and m:
            return f'{{"type":"click","element_id":{m.group(1)}}}'
        return '{"type":"ask_user","question":"Could not update the number."}'
    if "Welcome," in text:
        return '{"type":"done","summary":"Logged in; dashboard is showing."}'
    if "Username" in text and "Password" in text:
        if f"'element_id': {element_id(text, 'Username')}," not in history:
            return f'{{"type":"type","element_id":{element_id(text, "Username")},"text":"{user}"}}'
        if "{PASSWORD}" not in history:
            return f'{{"type":"type","element_id":{element_id(text, "Password")},"text":"{{PASSWORD}}"}}'
        m = re.search(r'\[(\d+)\] <button[^>]*> text="Sign in"', text)
        return f'{{"type":"click","element_id":{m.group(1)}}}'
    return '{"type":"ask_user","question":"I do not know what to do on this page."}'


@app.post("/v1/chat/completions")
async def chat(body: dict):
    parts = body["messages"][-1]["content"]
    text = next(p["text"] for p in parts if p["type"] == "text")
    return {"choices": [{"message": {"role": "assistant", "content": decide(text)}}]}


@app.get("/v1/models")
async def models():
    return {"data": [{"id": "fake"}]}
