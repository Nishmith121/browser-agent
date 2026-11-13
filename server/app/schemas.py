"""Wire protocol (Section 7). Keep identical to extension/src/shared/protocol.ts."""
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter


class Viewport(BaseModel):
    width: int
    height: int
    scale: float = 1.0


class Element(BaseModel):
    id: int
    tag: str
    type: str | None = None
    label: str | None = None
    text: str = ""
    placeholder: str | None = None
    value: str | None = None  # placeholder-only, e.g. "[PHONE_1]"
    bbox: list[int] = Field(default_factory=list)
    redacted: bool = False
    category: str | None = None


class Click(BaseModel):
    type: Literal["click"]
    element_id: int


class Type(BaseModel):
    type: Literal["type"]
    element_id: int
    text: str
    clear_first: bool = True


class Select(BaseModel):
    type: Literal["select"]
    element_id: int
    option: str


class Scroll(BaseModel):
    type: Literal["scroll"]
    direction: Literal["up", "down"]
    amount: int = Field(default=400, ge=1, le=4000)


class PressKey(BaseModel):
    type: Literal["press_key"]
    key: Literal["Enter", "Tab", "Escape"]


class Navigate(BaseModel):
    type: Literal["navigate"]
    url: str


class Wait(BaseModel):
    type: Literal["wait"]
    ms: int = Field(default=1000, ge=0, le=3000)


class AskUser(BaseModel):
    type: Literal["ask_user"]
    question: str


class Done(BaseModel):
    type: Literal["done"]
    summary: str


Action = Annotated[
    Union[Click, Type, Select, Scroll, PressKey, Navigate, Wait, AskUser, Done],
    Field(discriminator="type"),
]
ActionAdapter: TypeAdapter = TypeAdapter(Action)


class HistoryItem(BaseModel):
    step: int
    action: dict
    result: str


class StepRequest(BaseModel):
    session_id: str
    step: int = 1
    task: str
    url: str = ""
    title: str = ""
    screenshot: str  # redacted PNG, data URL or bare base64
    viewport: Viewport
    elements: list[Element]
    texts: list[str] = Field(default_factory=list)
    available_secrets: list[str] = Field(default_factory=list)
    history: list[HistoryItem] = Field(default_factory=list)
    redaction_summary: dict[str, int] = Field(default_factory=dict)


class StepResponse(BaseModel):
    status: Literal["continue", "done", "error"]
    action: Action
    model: str = ""
    latency_ms: int = 0
    message: str = ""
