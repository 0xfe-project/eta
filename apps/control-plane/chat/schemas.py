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


AGENT_DESCRIPTION_MAX = 10_000


def _clean_name(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        raise ValueError("名称不能为空")
    return value


class AgentCreateIn(StrictInput):
    name: str = Field(min_length=1, max_length=100)
    # Instructions injected into the agent's context; kept verbatim.
    description: str = Field("", max_length=AGENT_DESCRIPTION_MAX)
    # A model id from the LLM gateway's catalog (GET /api/llm/v1/models).
    model: str | None = Field(None, min_length=1, max_length=100)

    _name = field_validator("name")(_clean_name)


class AgentUpdateIn(StrictInput):
    """Partial update: only fields that are sent change."""

    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = Field(None, max_length=AGENT_DESCRIPTION_MAX)
    model: str | None = Field(None, min_length=1, max_length=100)

    _name = field_validator("name")(_clean_name)


class MessageCreateIn(StrictInput):
    agent_id: str = Field(min_length=1, max_length=64)
    # Kept verbatim so code indentation survives.
    text: str = Field(min_length=1, max_length=10_000)
    # "queue" waits for the agent's current turn; "steer" joins it.
    mode: Literal["queue", "steer"] = "queue"

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
    name: str | None = None
    input: str | None = None
    output: str | None = None


Block = Annotated[TextBlock | ActivityBlock, Field(discriminator="type")]


class Failure(Schema):
    code: str
    message: str


class AgentOut(Schema):
    id: str
    name: str
    description: str
    # Model id from the LLM gateway catalog; null until one is chosen.
    model: str | None
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
    active_replies: list[MessageOut]
    interactions: list[InteractionOut]
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
