"""Chat application service.

Turns product intents (create agent, send, stop, answer) into internal records
and keeps the public projections (agent status, messages, interactions) and the
``ui_event`` stream in sync.

Locking rule: every write transaction locks the conversation row first. That
row allocates message and event sequences, which serializes event commits per
conversation and avoids lock-order deadlocks with the runtime worker.
"""

import json
import uuid

from django.core.serializers.json import DjangoJSONEncoder
from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from . import cursors, llm
from .control.mcp import bind_defaults
from .errors import ApiError, not_found
from .models import (
    Agent,
    AgentCommand,
    Approval,
    Conversation,
    Interaction,
    Message,
    UiEvent,
)
from .schemas import AgentOut, InteractionOut, MessageOut

HISTORY_PAGE_SIZE = 50
MAX_HISTORY_PAGE_SIZE = 100
MAX_QUEUED_PER_AGENT = 20


# --- Public projections -----------------------------------------------------


def _render(obj) -> dict:
    # Encode exactly like Ninja's renderer so HTTP and SSE payloads match.
    return json.loads(json.dumps(obj.model_dump(), cls=DjangoJSONEncoder))


def agent_public(agent: Agent) -> dict:
    return _render(
        AgentOut(
            id=str(agent.id),
            name=agent.name,
            description=agent.description,
            model=agent.model,
            status=agent.product_status,
            revision=agent.product_revision,
        )
    )


def message_public(message: Message) -> dict:
    return _render(
        MessageOut(
            id=str(message.id),
            agent_id=str(message.agent_id),
            role=message.role,
            reply_to_id=str(message.reply_to_id) if message.reply_to_id else None,
            status=message.status,
            revision=message.revision,
            blocks=message.content,
            failure=message.failure,
            created_at=message.created_at,
        )
    )


def interaction_public(interaction: Interaction) -> dict:
    return _render(
        InteractionOut(
            id=str(interaction.id),
            message_id=str(interaction.message_id),
            kind=interaction.kind,
            prompt=interaction.prompt,
            options=interaction.options,
            status=interaction.status,
            revision=interaction.revision,
        )
    )


def new_block_id() -> str:
    return uuid.uuid4().hex


def text_block(text: str) -> dict:
    return {"id": new_block_id(), "type": "text", "text": text}


# --- Event emission (callers hold the conversation lock) --------------------


def _emit(conversation: Conversation, type_: str, payload: dict) -> None:
    conversation.last_ui_event_seq += 1
    conversation.save(update_fields=["last_ui_event_seq", "updated_at"])
    UiEvent.objects.create(
        conversation=conversation,
        seq=conversation.last_ui_event_seq,
        type=type_,
        payload=payload,
    )


def emit_agent(conversation: Conversation, agent: Agent) -> None:
    _emit(conversation, UiEvent.Type.AGENT_UPDATED, {"agent": agent_public(agent)})


def emit_message(conversation: Conversation, message: Message) -> None:
    _emit(
        conversation,
        UiEvent.Type.MESSAGE_UPDATED,
        {"message": message_public(message)},
    )


def emit_interaction(conversation: Conversation, interaction: Interaction) -> None:
    _emit(
        conversation,
        UiEvent.Type.INTERACTION_UPDATED,
        {"interaction": interaction_public(interaction)},
    )


def save_message(conversation: Conversation, message: Message, **changes) -> None:
    for field, value in changes.items():
        setattr(message, field, value)
    message.revision += 1
    message.save(update_fields=[*changes, "revision", "updated_at"])
    emit_message(conversation, message)


def save_interaction(
    conversation: Conversation, interaction: Interaction, **changes
) -> None:
    for field, value in changes.items():
        setattr(interaction, field, value)
    interaction.revision += 1
    interaction.save(update_fields=[*changes, "revision", "updated_at"])
    emit_interaction(conversation, interaction)


def refresh_agent_status(conversation: Conversation, agent: Agent) -> None:
    """Recompute the product status from internal state and publish changes."""
    if agent.status in (Agent.Status.RECOVERY_FAILED, Agent.Status.ERROR):
        status = Agent.ProductStatus.UNAVAILABLE
    else:
        active = set(
            Message.objects.filter(
                agent=agent,
                role=Message.Role.ASSISTANT,
                status__in=Message.ACTIVE_STATUSES,
            ).values_list("status", flat=True)
        )
        if Message.Status.WAITING_FOR_INPUT in active:
            status = Agent.ProductStatus.WAITING_FOR_INPUT
        elif active:
            status = Agent.ProductStatus.WORKING
        else:
            status = Agent.ProductStatus.IDLE
    if status == agent.product_status:
        return
    agent.product_status = status
    agent.product_revision += 1
    agent.save(update_fields=["product_status", "product_revision", "updated_at"])
    emit_agent(conversation, agent)


def expire_open_interactions(conversation: Conversation, reply: Message) -> None:
    open_statuses = (Interaction.Status.PENDING, Interaction.Status.SUBMITTED)
    for interaction in reply.interactions.filter(status__in=open_statuses):
        save_interaction(conversation, interaction, status=Interaction.Status.EXPIRED)


# Product-facing failure reasons. Internal causes stay in the control plane.
FAILURES = {
    "TURN_FAILED": "智能体执行失败，请稍后再试。",
    "REPLY_INTERRUPTED": "执行中断，无法确认结果，未自动重试。",
    "AGENT_UNAVAILABLE": "智能体环境暂时不可用，请稍后再试。",
    "AGENT_RECOVERY_FAILED": "智能体会话无法恢复，此消息未执行。",
    "AGENT_EXTENSION_FAILED": "智能体扩展启动失败，此消息未执行。",
    "DISPATCH_TIMEOUT": "智能体环境准备超时，此消息未执行。",
}


def failure(code: str) -> dict:
    return {"code": code, "message": FAILURES[code]}


_OUTCOMES = {
    "succeeded": (AgentCommand.Status.SUCCEEDED, Message.Status.COMPLETED),
    "failed": (AgentCommand.Status.FAILED, Message.Status.FAILED),
    "interrupted": (AgentCommand.Status.INTERRUPTED, Message.Status.STOPPED),
    "cancelled": (AgentCommand.Status.CANCELLED, Message.Status.STOPPED),
}
TERMINAL_COMMAND_STATUSES = (
    AgentCommand.Status.SUCCEEDED,
    AgentCommand.Status.FAILED,
    AgentCommand.Status.CANCELLED,
    AgentCommand.Status.INTERRUPTED,
)
TERMINAL_MESSAGE_STATUSES = (
    Message.Status.COMPLETED,
    Message.Status.STOPPED,
    Message.Status.FAILED,
)


def finish_command(
    conversation: Conversation,
    command: AgentCommand,
    outcome: str,
    failure_code: str | None = None,
) -> bool:
    """Settle a command and its reply. Returns False if it was already final."""
    if command.status in TERMINAL_COMMAND_STATUSES:
        return False
    command_status, reply_status = _OUTCOMES[outcome]
    command.status = command_status
    command.finished_at = timezone.now()
    command.error_code = failure_code
    command.save(update_fields=["status", "finished_at", "error_code"])
    Approval.objects.filter(
        command=command,
        status__in=[Approval.Status.PENDING, Approval.Status.DECIDED],
    ).update(status=Approval.Status.EXPIRED, resolved_at=timezone.now())
    reply = command.messages.filter(role=Message.Role.ASSISTANT).first()
    if reply and reply.status not in TERMINAL_MESSAGE_STATUSES:
        expire_open_interactions(conversation, reply)
        settled = "completed" if outcome == "succeeded" else "failed"
        blocks = [
            {**block, "status": settled}
            if block["type"] == "activity" and block["status"] == "running"
            else block
            for block in reply.content
        ]
        changes = {"status": reply_status, "content": blocks}
        if outcome == "failed":
            changes["failure"] = failure(failure_code or "TURN_FAILED")
        save_message(conversation, reply, **changes)
    agent = command.agent
    if agent.status == Agent.Status.BUSY:
        agent.status = Agent.Status.READY
        agent.save(update_fields=["status", "updated_at"])
    refresh_agent_status(conversation, agent)
    return True


def lock_conversation(conversation_id) -> Conversation:
    return Conversation.objects.select_for_update().get(pk=conversation_id)


# --- Default conversation ---------------------------------------------------


def default_conversation_id() -> uuid.UUID | None:
    return (
        Conversation.objects.filter(is_default=True)
        .values_list("id", flat=True)
        .first()
    )


def ensure_default_conversation() -> uuid.UUID:
    conversation_id = default_conversation_id()
    if conversation_id:
        return conversation_id
    try:
        with transaction.atomic():
            return Conversation.objects.create(is_default=True).id
    except IntegrityError:
        # Another request created it concurrently; its row wins.
        conversation_id = default_conversation_id()
        if conversation_id is None:
            raise
        return conversation_id


def _locked_default() -> Conversation:
    conversation_id = default_conversation_id()
    if conversation_id is None:
        raise not_found()
    return lock_conversation(conversation_id)


# --- Reads ------------------------------------------------------------------


def get_snapshot() -> dict:
    conversation_id = default_conversation_id()
    if conversation_id is None:
        return {
            "agents": [],
            "messages": [],
            "active_replies": [],
            "interactions": [],
            "history_cursor": None,
            "event_cursor": cursors.encode_event_cursor(0),
        }
    # Read the cursor before the objects. Anything committed in between is
    # replayed over SSE and dropped client-side by revision, so nothing is lost.
    event_seq = Conversation.objects.values_list("last_ui_event_seq", flat=True).get(
        pk=conversation_id
    )
    agents = Agent.objects.filter(
        conversation_id=conversation_id, deleted_at__isnull=True
    ).order_by("created_at", "id")
    recent = list(
        Message.objects.filter(conversation_id=conversation_id).order_by("-seq")[
            : HISTORY_PAGE_SIZE + 1
        ]
    )
    has_more = len(recent) > HISTORY_PAGE_SIZE
    recent = list(reversed(recent[:HISTORY_PAGE_SIZE]))
    active = Message.objects.filter(
        conversation_id=conversation_id,
        role=Message.Role.ASSISTANT,
        status__in=Message.ACTIVE_STATUSES,
    ).order_by("seq")
    interactions = Interaction.objects.filter(
        conversation_id=conversation_id,
        status__in=[Interaction.Status.PENDING, Interaction.Status.SUBMITTED],
    ).order_by("created_at", "id")
    return {
        "agents": [agent_public(a) for a in agents],
        "messages": [message_public(m) for m in recent],
        "active_replies": [message_public(m) for m in active],
        "interactions": [interaction_public(i) for i in interactions],
        "history_cursor": (
            cursors.encode_history_cursor(recent[0].seq) if has_more else None
        ),
        "event_cursor": cursors.encode_event_cursor(event_seq),
    }


def get_history(before: str | None, limit: int) -> dict:
    before_seq = cursors.decode_history_cursor(before) if before else None
    conversation_id = default_conversation_id()
    if conversation_id is None:
        return {"items": [], "next_cursor": None}
    query = Message.objects.filter(conversation_id=conversation_id)
    if before_seq is not None:
        query = query.filter(seq__lt=before_seq)
    page = list(query.order_by("-seq")[: limit + 1])
    has_more = len(page) > limit
    page = list(reversed(page[:limit]))
    return {
        "items": [message_public(m) for m in page],
        "next_cursor": (
            cursors.encode_history_cursor(page[0].seq) if has_more else None
        ),
    }


# --- Writes (run inside the idempotency transaction) ------------------------


def _parse_uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise not_found() from exc


def _agent(conversation: Conversation, agent_id: str) -> Agent:
    agent = Agent.objects.filter(
        id=_parse_uuid(agent_id), conversation=conversation, deleted_at__isnull=True
    ).first()
    if agent is None:
        raise not_found()
    return agent


def create_agent(name: str, description: str = "", model: str | None = None) -> Agent:
    if model:
        llm.validate_model(model)
    conversation = lock_conversation(ensure_default_conversation())
    # Model, tools and mounts come from server configuration, not the request.
    agent = Agent.objects.create(
        conversation=conversation,
        name=name,
        description=description,
        model=model or None,
    )
    bind_defaults(agent)
    emit_agent(conversation, agent)
    return agent


def update_agent(agent_id: str, changes: dict) -> Agent:
    if changes.get("model"):
        # Network call: before taking the conversation lock.
        llm.validate_model(changes["model"])
    conversation = _locked_default()
    agent = _agent(conversation, agent_id)
    changed = [
        field for field, value in changes.items() if getattr(agent, field) != value
    ]
    if not changed:
        return agent
    for field in changed:
        setattr(agent, field, changes[field])
    if "description" in changed or "model" in changed:
        # Runtimes receive instructions and the model at start; the
        # controller restarts an idle runtime so the next turn uses them.
        agent.config_version += 1
        changed.append("config_version")
    agent.product_revision += 1
    agent.save(update_fields=[*changed, "product_revision", "updated_at"])
    emit_agent(conversation, agent)
    return agent


def delete_agent(agent_id: str) -> None:
    """Hide the agent and stop its work; its messages stay in the history."""
    conversation = _locked_default()
    agent = _agent(conversation, agent_id)
    agent.deleted_at = timezone.now()
    agent.desired_state = Agent.DesiredState.STOPPED
    agent.save(update_fields=["deleted_at", "desired_state", "updated_at"])
    commands = AgentCommand.objects.select_related("agent").filter(agent=agent)
    for command in commands.filter(status=AgentCommand.Status.QUEUED):
        finish_command(conversation, command, "cancelled")
    # Running work is interrupted by the runtime; the controller then stops it.
    for reply in Message.objects.filter(
        agent=agent, role=Message.Role.ASSISTANT, status__in=Message.ACTIVE_STATUSES
    ).select_related("command"):
        _request_stop(conversation, reply)
    _emit(conversation, UiEvent.Type.AGENT_DELETED, {"agent_id": str(agent.id)})


def send_message(
    agent_id: str, text: str, *, steer: bool = False
) -> tuple[Message, Message]:
    """Queue a turn. A steer joins the agent's running turn instead, once
    the controller delivers it; with no running turn it waits like any turn."""
    return _enqueue(
        agent_id, text, {"text": text, **({"steer": True} if steer else {})}
    )


def compact(agent_id: str) -> tuple[Message, Message]:
    """Queue a compaction of the agent's context, shown as ``/compact``."""
    return _enqueue(agent_id, "/compact", {}, AgentCommand.Kind.COMPACT)


def _enqueue(
    agent_id: str, text: str, input: dict, kind=AgentCommand.Kind.TURN
) -> tuple[Message, Message]:
    # Network call: before taking the conversation lock.
    found = list(
        Agent.objects.filter(
            id=_parse_uuid(agent_id), deleted_at__isnull=True
        ).values_list("model", flat=True)[:1]
    )
    if found:
        llm.ensure_usable(found[0])
    conversation = _locked_default()
    agent = _agent(conversation, agent_id)

    queued = AgentCommand.objects.filter(
        agent=agent, status=AgentCommand.Status.QUEUED
    ).count()
    if queued >= MAX_QUEUED_PER_AGENT:
        raise ApiError(429, "QUEUE_FULL", "该智能体待处理的消息过多，请稍后再发送。")

    Agent.objects.filter(pk=agent.pk).update(last_command_seq=F("last_command_seq") + 1)
    agent.refresh_from_db(fields=["last_command_seq"])
    command = AgentCommand.objects.create(
        agent=agent, agent_sequence=agent.last_command_seq, kind=kind, input=input
    )

    now = timezone.now()
    conversation.last_message_seq += 2
    conversation.save(update_fields=["last_message_seq", "updated_at"])
    message = Message.objects.create(
        conversation=conversation,
        agent=agent,
        command=command,
        seq=conversation.last_message_seq - 1,
        role=Message.Role.USER,
        status=Message.Status.COMPLETED,
        content=[text_block(text)],
        created_at=now,
    )
    reply = Message.objects.create(
        conversation=conversation,
        agent=agent,
        command=command,
        reply_to=message,
        seq=conversation.last_message_seq,
        role=Message.Role.ASSISTANT,
        status=Message.Status.QUEUED,
        content=[],
        created_at=now,
    )
    emit_message(conversation, message)
    emit_message(conversation, reply)
    refresh_agent_status(conversation, agent)
    return message, reply


def _request_stop(conversation: Conversation, reply: Message) -> None:
    command = reply.command
    # A delivered steer may already be in the running turn.
    delivered_steer = command.input.get("steer") and command.dispatched_at
    if command.status == AgentCommand.Status.QUEUED and not delivered_steer:
        # Not yet handed to a runtime: cancel outright.
        finish_command(conversation, command, "cancelled")
    elif reply.status in (
        Message.Status.QUEUED,
        Message.Status.RESPONDING,
        Message.Status.WAITING_FOR_INPUT,
    ):
        # Ask the runtime to interrupt; it confirms by finalizing the reply.
        if command.interrupt_requested_at is None:
            command.interrupt_requested_at = timezone.now()
            command.save(update_fields=["interrupt_requested_at"])
        expire_open_interactions(conversation, reply)
        save_message(conversation, reply, status=Message.Status.STOPPING)
        refresh_agent_status(conversation, reply.agent)
    # stopping or terminal: repeat stops are no-ops.


def stop_reply(message_id: str) -> Message:
    message_uuid = _parse_uuid(message_id)
    conversation = _locked_default()
    reply = (
        Message.objects.select_related("command", "agent")
        .filter(id=message_uuid, conversation=conversation, role=Message.Role.ASSISTANT)
        .first()
    )
    if reply is None:
        raise not_found()
    _request_stop(conversation, reply)
    reply.refresh_from_db()
    return reply


def answer_interaction(interaction_id: str, value: str) -> Interaction:
    interaction_uuid = _parse_uuid(interaction_id)
    conversation = _locked_default()
    interaction = Interaction.objects.filter(
        id=interaction_uuid, conversation=conversation
    ).first()
    if interaction is None:
        raise not_found()

    if value not in {option["value"] for option in interaction.options}:
        raise ApiError(422, "INVALID_CHOICE", "所选项无效。")

    if interaction.status == Interaction.Status.PENDING:
        if interaction.expires_at and interaction.expires_at <= timezone.now():
            raise _expired()
        save_interaction(
            conversation,
            interaction,
            status=Interaction.Status.SUBMITTED,
            answer={"value": value},
        )
        if interaction.approval_id:
            # The controller delivers the decision; "applied" comes from the runtime.
            Approval.objects.filter(
                pk=interaction.approval_id, status=Approval.Status.PENDING
            ).update(
                status=Approval.Status.DECIDED,
                decision="accept" if value == "allow" else "decline",
            )
        return interaction
    if interaction.status == Interaction.Status.EXPIRED:
        raise _expired()
    if interaction.answer and interaction.answer.get("value") == value:
        return interaction
    raise ApiError(409, "INTERACTION_ALREADY_ANSWERED", "该交互已有其他选择。")


def _expired() -> ApiError:
    return ApiError(409, "INTERACTION_EXPIRED", "该交互已失效。")
