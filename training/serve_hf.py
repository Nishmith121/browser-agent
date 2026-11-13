"""OpenAI-compatible chat server for the base model and the LoRA adapter, with plain Transformers + PEFT.

For the LIVE task-success comparison (Phase 7 acceptance) on a GPU you can reach, including a free Kaggle/Colab GPU
exposed through a tunnel. vLLM (training/README.md) is faster; this exists because vLLM is not always available.

  python serve_hf.py --model Qwen/Qwen3-VL-2B-Instruct --adapter runs/privasight-2b --port 8001

It serves two model names from ONE loaded model, so both conditions use the same weights, quantisation and decoding:
  base           the base model (adapter disabled)
  privasight-2b  base + LoRA adapter       (name set with --adapter-name)

The agent server talks to it like to Ollama/vLLM: VLM_BASE_URL=http://<host>:8001/v1 VLM_MODEL=privasight-2b.
Only redacted screenshots and placeholder text ever arrive here (that is the point of PrivaSight); nothing is stored.
The request format is the one the agent server sends (server/app/vlm.py), and the chat built from it is the training
format (chat_format.py: system prompt, user turn = image + text), so training and serving match.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import time

import uvicorn
from fastapi import FastAPI, HTTPException


def build_app(a: argparse.Namespace) -> FastAPI:
    import torch
    from PIL import Image
    from transformers import AutoModelForImageTextToText, AutoProcessor, BitsAndBytesConfig

    dtype = torch.bfloat16 if torch.cuda.get_device_capability(0)[0] >= 8 else torch.float16  # T4/P100: no real bf16
    processor = AutoProcessor.from_pretrained(a.model)
    try:
        processor.image_processor.size = {"longest_edge": a.max_pixels, "shortest_edge": 64 * 64}  # same budget as training
    except Exception:  # noqa: BLE001
        pass
    kw = dict(dtype=dtype, device_map={"": 0}, attn_implementation="sdpa")
    if a.quant == "4bit":
        kw["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype)
    model = AutoModelForImageTextToText.from_pretrained(a.model, **kw)
    names = ["base"]
    if a.adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, a.adapter)
        names.append(a.adapter_name)
    model.eval()
    lock = asyncio.Lock()  # one generation at a time: the agent loop is sequential anyway

    def to_chat(messages: list[dict]) -> tuple[list[dict], Image.Image]:
        system = next((m["content"] for m in messages if m["role"] == "system"), "")
        user = next(m for m in reversed(messages) if m["role"] == "user")
        parts = user["content"] if isinstance(user["content"], list) else [{"type": "text", "text": user["content"]}]
        text = "\n".join(p["text"] for p in parts if p.get("type") == "text")
        url = next((p["image_url"]["url"] for p in parts if p.get("type") == "image_url"), None)
        if not url:
            raise HTTPException(400, "a screenshot (image_url) is required")
        image = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[-1]))).convert("RGB")
        chat = [{"role": "system", "content": system}, {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": text}]}]
        return chat, image

    def generate(chat: list[dict], image, use_adapter: bool, max_new_tokens: int) -> str:
        prompt = processor.apply_chat_template(chat, add_generation_prompt=True, tokenize=False)
        batch = processor(text=[prompt], images=[image], return_tensors="pt").to(model.device)
        with torch.no_grad():
            if a.adapter and not use_adapter:
                with model.disable_adapter():
                    out = model.generate(**batch, max_new_tokens=max_new_tokens, do_sample=False)
            else:
                out = model.generate(**batch, max_new_tokens=max_new_tokens, do_sample=False)
        return processor.tokenizer.decode(out[0][batch["input_ids"].shape[1]:], skip_special_tokens=True)

    app = FastAPI(title="PrivaSight HF model server")

    @app.get("/v1/models")
    async def models() -> dict:
        return {"data": [{"id": n} for n in names]}

    @app.post("/v1/chat/completions")
    async def chat(body: dict) -> dict:
        name = body.get("model", "base")
        if name not in names:
            raise HTTPException(404, f"unknown model {name!r}; served: {names}")
        conversation, image = to_chat(body["messages"])
        t0 = time.perf_counter()
        async with lock:
            reply = await asyncio.to_thread(generate, conversation, image, name != "base", int(body.get("max_tokens") or 300))
        print(f"[{name}] {round((time.perf_counter() - t0) * 1000)} ms: {reply[:120]!r}", flush=True)
        return {"model": name, "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": reply}}]}

    return app


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3-VL-2B-Instruct")
    ap.add_argument("--adapter", default=None, help="LoRA adapter directory (e.g. runs/privasight-2b)")
    ap.add_argument("--adapter-name", default="privasight-2b")
    ap.add_argument("--quant", choices=["4bit", "none"], default="4bit", help="4bit = the QLoRA setting the adapter was trained in")
    ap.add_argument("--max-pixels", type=int, default=1280 * 720)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8001)
    a = ap.parse_args()
    uvicorn.run(build_app(a), host=a.host, port=a.port)


if __name__ == "__main__":
    main()
