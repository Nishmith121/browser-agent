"""Thin client for an OpenAI-compatible chat endpoint (Ollama for laptop dev, vLLM on the lab GPU)."""
import httpx

from . import config


def _data_url(screenshot: str) -> str:
    return screenshot if screenshot.startswith("data:") else f"data:image/png;base64,{screenshot}"


async def complete(system: str, user_text: str, screenshot: str) -> str:
    body = {
        "model": config.VLM_MODEL,
        "temperature": config.VLM_TEMPERATURE,
        "max_tokens": config.VLM_MAX_TOKENS,
        "messages": [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": _data_url(screenshot)}},
                    {"type": "text", "text": user_text},
                ],
            },
        ],
    }
    async with httpx.AsyncClient(timeout=config.VLM_TIMEOUT_S) as client:
        r = await client.post(
            f"{config.VLM_BASE_URL}/chat/completions",
            json=body,
            headers={"Authorization": f"Bearer {config.VLM_API_KEY}"},
        )
        r.raise_for_status()
        choice = r.json()["choices"][0]
        content = choice["message"].get("content") or ""
        if not content.strip():
            # Thinking models (e.g. the default qwen3-vl tags) can spend the whole token budget on reasoning.
            raise RuntimeError(
                f"model returned empty content (finish_reason={choice.get('finish_reason')}); "
                "use an Instruct variant such as qwen3-vl:2b-instruct, or raise VLM_MAX_TOKENS"
            )
        return content


def _installed(model: str, ids: list) -> bool:
    """Ollama lists untagged models as '<name>:latest'."""
    want = model if ":" in model else f"{model}:latest"
    return model in ids or want in ids


async def health() -> dict:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{config.VLM_BASE_URL}/models")
            r.raise_for_status()
            ids = [m.get("id") for m in r.json().get("data", [])]
        return {"model_reachable": True, "model": config.VLM_MODEL, "model_installed": _installed(config.VLM_MODEL, ids)}
    except Exception as e:  # noqa: BLE001 - health must never raise
        return {"model_reachable": False, "model": config.VLM_MODEL, "error": str(e)}
