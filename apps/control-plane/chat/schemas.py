"""Public product schemas (RFC §3.1).

Every response and SSE payload goes through these hand-written allowlists.
Internal identifiers such as command, thread or runtime ids must never be added
here.
"""

from datetime import datetime
from typing import Annotated, Literal

from ninja import Schema
from pydantic import ConfigDict, Field, field_validator


class StrictInput(Schema):
    model_config = ConfigDict(extra="forbid")


# --- Inputs -----------------------------------------------------------------


class AgentCreateIn(StrictInput):
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("名称不能为空")
        return value


class AgentRenameIn(AgentCreateIn):
    pass


class MessageCreateIn(StrictInput):
    agent_id: str = Field(min_length=1, max_length=64)
    # Kept verbatim so code indentation survives.
    text: str = Field(min_length=1, max_length=10_000)

    @field_validator("text")
    @classmethod
    def reject_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("消息不能为空")
        return value


class InteractionAnswerIn(StrictInput):
    value: str = Field(min_length=1, max_length=100)


# --- Outputs ----------------------------------------------------------------


class TextBlock(Schema):
    id: str
    type: Literal["text"]
    text: str


class ActivityBlock(Schema):
    id: str
    type: Literal["activity"]
    label: str
    status: Literal["running", "completed", "failed"]


Block = Annotated[TextBlock | ActivityBlock, Field(discriminator="type")]


class Failure(Schema):
    code: str
    message: str


class AgentOut(Schema):
    id: str
    name: str
    status: Literal["idle", "working", "waiting_for_input", "unavailable"]
    revision: int


class MessageOut(Schema):
    id: str
    agent_id: str
    role: Literal["user", "assistant"]
    reply_to_id: str | None
    status: Literal[
        "queued",
        "responding",
        "waiting_for_input",
        "stopping",
        "completed",
        "stopped",
        "failed",
    ]
    revision: int
    blocks: list[Block]
    failure: Failure | None = None
    created_at: datetime


class InteractionOption(Schema):
    value: str
    label: str


class InteractionOut(Schema):
    id: str
    message_id: str
    kind: Literal["choice"]
    prompt: str
    options: list[InteractionOption]
    status: Literal["pending", "submitted", "resolved", "expired"]
    revision: int


class ChatSnapshotOut(Schema):
    agents: list[AgentOut]
    messages: list[MessageOut]
    active_replies: list[MessageOut]
    interactions: list[InteractionOut]
    history_cursor: str | None
    event_cursor: str


class MessagePageOut(Schema):
    items: list[MessageOut]
    next_cursor: str | None


class SendMessageOut(Schema):
    message: MessageOut
    reply: MessageOut


class ErrorBody(Schema):
    code: str
    message: str
    request_id: str


class ErrorOut(Schema):
    error: ErrorBody
