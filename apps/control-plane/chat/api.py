"""Public chat API (RFC §3). This module is the complete list of endpoints the
web client may call."""

from django.db import transaction
from django.http import HttpRequest, HttpResponse, StreamingHttpResponse
from ninja import Header, Query, Router, Status

from . import services, stream
from .errors import ApiError
from .idempotency import run_idempotent
from .schemas import (
    AgentCreateIn,
    AgentOut,
    AgentUpdateIn,
    ChatSnapshotOut,
    ErrorOut,
    InteractionAnswerIn,
    InteractionOut,
    MessageCreateIn,
    MessageOut,
    MessagePageOut,
    SendMessageOut,
)

router = Router(tags=["chat"])

_ERRORS = {
    400: ErrorOut,
    404: ErrorOut,
    409: ErrorOut,
    410: ErrorOut,
    422: ErrorOut,
    429: ErrorOut,
}


@router.get("/chat", response={200: ChatSnapshotOut, **_ERRORS})
def get_chat(request: HttpRequest):
    return services.get_snapshot()


@router.get("/chat/messages", response={200: MessagePageOut, **_ERRORS})
def list_messages(
    request: HttpRequest,
    before: str | None = None,
    limit: int = Query(
        services.HISTORY_PAGE_SIZE, ge=1, le=services.MAX_HISTORY_PAGE_SIZE
    ),
):
    return services.get_history(before, limit)


@router.post("/agents", response={201: AgentOut, **_ERRORS})
def create_agent(request: HttpRequest, body: AgentCreateIn):
    def handler():
        agent = services.create_agent(body.name, body.description, body.model)
        return Status(201, services.agent_public(agent)), str(agent.id)

    return run_idempotent(request, body.model_dump(), handler)


@router.patch("/agents/{agent_id}", response={200: AgentOut, **_ERRORS})
def update_agent(request: HttpRequest, agent_id: str, body: AgentUpdateIn):
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    with transaction.atomic():
        agent = services.update_agent(agent_id, changes)
    return services.agent_public(agent)


@router.delete("/agents/{agent_id}", response={204: None, **_ERRORS})
def delete_agent(request: HttpRequest, agent_id: str):
    with transaction.atomic():
        services.delete_agent(agent_id)
    return HttpResponse(status=204)


@router.post("/chat/messages", response={202: SendMessageOut, **_ERRORS})
def send_message(request: HttpRequest, body: MessageCreateIn):
    def handler():
        message, reply = services.send_message(body.agent_id, body.text)
        payload = {
            "message": services.message_public(message),
            "reply": services.message_public(reply),
        }
        return Status(202, payload), str(reply.id)

    return run_idempotent(request, body.model_dump(), handler)


@router.post("/chat/messages/{message_id}/stop", response={200: MessageOut, **_ERRORS})
def stop_message(request: HttpRequest, message_id: str):
    def handler():
        reply = services.stop_reply(message_id)
        return Status(200, services.message_public(reply)), str(reply.id)

    return run_idempotent(request, {}, handler)


@router.post(
    "/chat/interactions/{interaction_id}/answer",
    response={202: InteractionOut, **_ERRORS},
)
def answer_interaction(
    request: HttpRequest, interaction_id: str, body: InteractionAnswerIn
):
    def handler():
        interaction = services.answer_interaction(interaction_id, body.value)
        answered = services.interaction_public(interaction)
        return Status(202, answered), str(interaction.id)

    return run_idempotent(request, body.model_dump(), handler)


@router.get(
    "/chat/stream",
    response=_ERRORS,
    openapi_extra={
        "responses": {
            200: {
                "description": "SSE：agent.updated / agent.deleted / message.updated / "
                "interaction.updated",
                "content": {"text/event-stream": {}},
            }
        }
    },
)
def chat_stream(
    request: HttpRequest,
    cursor: str | None = None,
    last_event_id: str | None = Header(None, alias="Last-Event-ID"),
):
    # A reconnecting EventSource resumes from its last delivered event.
    start = last_event_id or cursor
    if not start:
        raise ApiError(400, "INVALID_CURSOR", "缺少事件游标。")
    seq = stream.resolve_start_seq(start)
    response = StreamingHttpResponse(
        stream.event_stream(seq), content_type="text/event-stream"
    )
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    return response
