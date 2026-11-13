from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import audit, vlm
from .agent import decide
from .schemas import StepRequest, StepResponse

app = FastAPI(title="PrivaSight agent server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.post("/v1/step", response_model=StepResponse)
async def step(req: StepRequest) -> StepResponse:
    return await decide(req)


@app.get("/health")
async def health() -> dict:
    return await vlm.health()


@app.post("/v1/session/end")
async def session_end(body: dict) -> dict:
    return {"cleared": audit.end_session(str(body.get("session_id", "")))}
