"""Model name, endpoint and sampling come from environment variables so models swap without code changes."""
import os
from pathlib import Path

VLM_BASE_URL = os.getenv("VLM_BASE_URL", "http://localhost:11434/v1")  # Ollama; vLLM: http://host:8000/v1
VLM_MODEL = os.getenv("VLM_MODEL", "qwen3-vl:4b")
VLM_API_KEY = os.getenv("VLM_API_KEY", "none")
VLM_TEMPERATURE = float(os.getenv("VLM_TEMPERATURE", "0.1"))
VLM_MAX_TOKENS = int(os.getenv("VLM_MAX_TOKENS", "300"))
VLM_TIMEOUT_S = float(os.getenv("VLM_TIMEOUT_S", "120"))
# EVALUATION ONLY: turns off the typed-PII rejection so the unsafe "clean screens" baseline is not protected by it.
# Never set in normal use (the default keeps the defence on).
ALLOW_TYPED_PII = os.getenv("ALLOW_TYPED_PII") == "1"
LOG_DIR = Path(os.getenv("LOG_DIR", str(Path(__file__).resolve().parent.parent / "logs")))
