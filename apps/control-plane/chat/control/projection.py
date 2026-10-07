"""Import runtime outbox events and project them onto product state.

Runs inside one transaction per batch, holding the conversation lock. Raw
runtime payloads are stored in ``agent_event``; only allowlisted, translated
fields reach messages, interactions and ``ui_event``.
"""

from django.utils import timezone

from .. import services
from ..errors import ApiError
from ..models import (
    Agent,
    AgentCheckpoint,
    AgentCommand,
    AgentEvent,
    AgentSession,
    Approval,
    Interaction,
    Message,
    RuntimeInstance,
)
from . import objects

ACTIVITY_LABELS = {
    "command": "运行命令",
    "file_change": "修改文件",
    "mcp_tool": "调用工具",
    "tool": "调用工具",
    "web_search": "搜索网页",
    "agent": "协作子智能体",
    "image": "生成图片",
    "compaction": "压缩上下文",
}
ACTIVITY_STATUSES = {"running", "completed", "failed"}
MAX_BATCH = 100


def import_events(instance: RuntimeInstance, events: list[dict]) -> int:
    """Store and project an ordered batch. Returns the acked source sequence."""
    if len(events) > MAX_BATCH:
        raise ApiError(400, "BATCH_TOO_LARGE", "事件批次过大。")
    agent = instance.agent
    conversation = services.lock_conversation(agent.conversation_id)
    instance = RuntimeInstance.objects.select_for_update().get(pk=instance.pk)
    agent.refresh_from_db()
    for event in events:
        seq = event.get("source_seq")
        event_id = event.get("source_event_id")
        if not isinstance(seq, int) or not isinstance(event_id, str):
            raise ApiError(400, "BAD_EVENT", "事件格式无效。")
        if seq <= instance.last_source_seq:
            existing = AgentEvent.objects.filter(
                runtime_instance=instance, source_seq=seq
            ).first()
            if (
                existing is None
                or existing.source_event_id != event_id
                or (existing.payload != event.get("payload"))
            ):
                raise ApiError(409, "EVENT_CONFLICT", "事件与已记录内容冲突。")
            continue
        if seq != instance.last_source_seq + 1:
            raise ApiError(
                409,
                "EVENT_GAP",
                "事件序号不连续。",
                {"next_expected_source_seq": instance.last_source_seq + 1},
            )
        payload = event.get("payload") or {}
        command = _command(agent, payload.get("command_id"))
        conversation.last_event_seq += 1
        conversation.save(update_fields=["last_event_seq", "updated_at"])
        AgentEvent.objects.create(
            conversation=conversation,
            agent=agent,
            command=command,
            runtime_instance=instance,
            source_event_id=event_id,
            source_seq=seq,
            seq=conversation.last_event_seq,
            type=str(event.get("type"))[:64],
            payload=payload,
        )
        instance.last_source_seq = seq
        handler = HANDLERS.get(event.get("type"))
        if handler:
            handler(conversation, agent, instance, command, payload)
    instance.save(
        update_fields=["last_source_seq", "mcp_status", "status", "error_code"]
    )
    return instance.last_source_seq


def _command(agent: Agent, command_id) -> AgentCommand | None:
    if not command_id:
        return None
    try:
        return (
            AgentCommand.objects.select_related("agent")
            .filter(pk=command_id, agent=agent)
            .first()
        )
    except (ValueError, TypeError):
        return None


def _reply(command: AgentCommand | None) -> Message | None:
    if command is None:
        return None
    return command.messages.filter(role=Message.Role.ASSISTANT).first()


def _touch(agent: Agent) -> None:
    agent.last_active_at = timezone.now()
    agent.save(update_fields=["last_active_at", "updated_at"])


# --- handlers -----------------------------------------------------------------


def turn_started(conversation, agent, instance, command, payload):
    if command is None or command.status in services.TERMINAL_COMMAND_STATUSES:
        return
    if command.status == AgentCommand.Status.DISPATCHING:
        command.status = AgentCommand.Status.RUNNING
    command.codex_turn_id = payload.get("turn_id")
    command.started_at = command.started_at or timezone.now()
    command.save(update_fields=["status", "codex_turn_id", "started_at"])
    AgentSession.objects.filter(agent=agent).update(last_turn_id=command.codex_turn_id)
    if agent.status != Agent.Status.BUSY:
        agent.status = Agent.Status.BUSY
        agent.save(update_fields=["status", "updated_at"])
    _touch(agent)
    reply = _reply(command)
    if reply and reply.status == Message.Status.QUEUED:
        services.save_message(conversation, reply, status=Message.Status.RESPONDING)
    services.refresh_agent_status(conversation, agent)


def item_updated(conversation, agent, instance, command, payload):
    reply = _reply(command)
    item = payload.get("item") or {}
    if reply is None or reply.status in services.TERMINAL_MESSAGE_STATUSES:
        return
    item_id = str(item.get("id") or "")[:100]
    kind = item.get("kind")
    if kind == "agent_message":
        block = {
            "id": f"t-{item_id}",
            "type": "text",
            "text": str(item.get("text") or ""),
        }
    elif kind in ACTIVITY_LABELS:
        status = item.get("status")
        block = {
            "id": f"a-{item_id}",
            "type": "activity",
            "label": ACTIVITY_LABELS[kind],
            "status": status if status in ACTIVITY_STATUSES else "running",
        }
    else:
        return
    blocks = list(reply.content)
    for index, existing in enumerate(blocks):
        if existing["id"] == block["id"]:
            if existing == block:
                return
            blocks[index] = block
            break
    else:
        blocks.append(block)
    changes = {"content": blocks}
    if reply.status == Message.Status.QUEUED:
        changes["status"] = Message.Status.RESPONDING
    services.save_message(conversation, reply, **changes)
    _touch(agent)


def _approval_prompt(kind: str, summary: dict) -> str:
    if kind == "command":
        prompt = "允许运行命令？"
        if summary.get("command"):
            prompt += f"\n{summary['command']}"
    else:
        prompt = "允许修改工作区文件？"
    if summary.get("reason"):
        prompt += f"\n原因：{summary['reason']}"
    return prompt[:500]


def approval_requested(conversation, agent, instance, command, payload):
    if command is None:
        return
    kind = "command" if payload.get("kind") == "command" else "file_change"
    raw = payload.get("summary") or {}
    summary = {
        "command": str(raw.get("command") or "")[:500] or None,
        "reason": str(raw.get("reason") or "")[:300] or None,
    }
    approval = Approval.objects.create(
        agent=agent,
        command=command,
        runtime_instance=instance,
        generation=instance.generation,
        sdk_request_id=str(payload.get("approval_id"))[:100],
        kind=kind,
        summary=summary,
    )
    reply = _reply(command)
    if reply is None:
        return
    stopping = reply.status not in (Message.Status.QUEUED, Message.Status.RESPONDING)
    interaction = Interaction.objects.create(
        conversation=conversation,
        agent=agent,
        message=reply,
        approval=approval,
        prompt=_approval_prompt(kind, summary),
        options=[
            {"value": "allow", "label": "允许"},
            {"value": "deny", "label": "拒绝"},
        ],
        # A stop already in flight will cancel this request.
        status=Interaction.Status.EXPIRED if stopping else Interaction.Status.PENDING,
    )
    services.emit_interaction(conversation, interaction)
    if stopping:
        return
    if command.status == AgentCommand.Status.RUNNING:
        command.status = AgentCommand.Status.WAITING_APPROVAL
        command.save(update_fields=["status"])
    services.save_message(conversation, reply, status=Message.Status.WAITING_FOR_INPUT)
    services.refresh_agent_status(conversation, agent)


def _approval(instance, payload) -> Approval | None:
    return (
        Approval.objects.filter(
            agent_id=instance.agent_id, sdk_request_id=str(payload.get("approval_id"))
        )
        .select_related("interaction")
        .order_by("-created_at")
        .first()
    )


def approval_applied(conversation, agent, instance, command, payload):
    approval = _approval(instance, payload)
    if approval is None:
        return
    approval.status = Approval.Status.APPLIED
    approval.decision = str(payload.get("decision"))[:16]
    approval.resolved_at = timezone.now()
    approval.save(update_fields=["status", "decision", "resolved_at"])
    interaction = getattr(approval, "interaction", None)
    if interaction and interaction.status == Interaction.Status.SUBMITTED:
        services.save_interaction(
            conversation, interaction, status=Interaction.Status.RESOLVED
        )
    elif interaction and interaction.status == Interaction.Status.PENDING:
        services.save_interaction(
            conversation, interaction, status=Interaction.Status.EXPIRED
        )
    command = approval.command
    if command.status == AgentCommand.Status.WAITING_APPROVAL:
        command.status = AgentCommand.Status.RUNNING
        command.save(update_fields=["status"])
    reply = _reply(command)
    if reply and reply.status == Message.Status.WAITING_FOR_INPUT:
        services.save_message(conversation, reply, status=Message.Status.RESPONDING)
    services.refresh_agent_status(conversation, agent)


def approval_expired(conversation, agent, instance, command, payload):
    approval = _approval(instance, payload)
    if approval is None or approval.status == Approval.Status.APPLIED:
        return
    approval.status = Approval.Status.EXPIRED
    approval.resolved_at = timezone.now()
    approval.save(update_fields=["status", "resolved_at"])
    interaction = getattr(approval, "interaction", None)
    if interaction and interaction.status in (
        Interaction.Status.PENDING,
        Interaction.Status.SUBMITTED,
    ):
        services.save_interaction(
            conversation, interaction, status=Interaction.Status.EXPIRED
        )


def turn_completed(conversation, agent, instance, command, payload):
    if command is None:
        return
    status = payload.get("status")
    if status == "completed":
        services.finish_command(conversation, command, "succeeded")
    elif status == "interrupted":
        services.finish_command(conversation, command, "interrupted")
    else:
        services.finish_command(conversation, command, "failed", "TURN_FAILED")
    if payload.get("turn_id"):
        AgentSession.objects.filter(agent=agent).update(last_turn_id=payload["turn_id"])
    _touch(agent)


def turn_steered(conversation, agent, instance, command, payload):
    """The running turn took a steer in: the rest of it answers the steer."""
    if command is not None:
        services.finish_command(conversation, command, "succeeded")
    steer = _command(agent, payload.get("steer_command_id"))
    if steer is None or steer.status in services.TERMINAL_COMMAND_STATUSES:
        return
    now = timezone.now()
    steer.status = AgentCommand.Status.RUNNING
    steer.runtime_instance = instance
    steer.dispatch_generation = instance.generation
    steer.codex_turn_id = payload.get("turn_id")
    steer.started_at = now
    if command is not None and command.interrupt_requested_at:
        # Stopping the turn's first part stops all of it.
        steer.interrupt_requested_at = steer.interrupt_requested_at or now
    steer.save(
        update_fields=[
            "status",
            "runtime_instance",
            "dispatch_generation",
            "codex_turn_id",
            "started_at",
            "interrupt_requested_at",
        ]
    )
    agent.status = Agent.Status.BUSY
    agent.save(update_fields=["status", "updated_at"])
    reply = _reply(steer)
    if reply and reply.status == Message.Status.QUEUED:
        services.save_message(conversation, reply, status=Message.Status.RESPONDING)
    services.refresh_agent_status(conversation, agent)
    _touch(agent)


def outcome_unknown(conversation, agent, instance, command, payload):
    # The runtime could not prove the turn did not run: never replay it.
    if command is not None:
        services.finish_command(conversation, command, "failed", "REPLY_INTERRUPTED")


def checkpoint_started(conversation, agent, instance, command, payload):
    AgentCheckpoint.objects.filter(
        pk=payload.get("checkpoint_id"),
        agent=agent,
        status=AgentCheckpoint.Status.PENDING,
    ).update(status=AgentCheckpoint.Status.CREATING)


def checkpoint_completed(conversation, agent, instance, command, payload):
    checkpoint = AgentCheckpoint.objects.filter(
        pk=payload.get("checkpoint_id"), agent=agent
    ).first()
    if checkpoint is None or checkpoint.status == AgentCheckpoint.Status.AVAILABLE:
        return
    checksum = str(payload.get("checksum") or "")
    # Only a verified object makes the checkpoint usable.
    if not checksum or not objects.verify(checkpoint.state_object_key, checksum):
        checkpoint.status = AgentCheckpoint.Status.FAILED
        checkpoint.save(update_fields=["status"])
        _finish_checkpoint_command(checkpoint.command, "failed")
        return
    manifest = payload.get("manifest") or {}
    checkpoint.status = AgentCheckpoint.Status.AVAILABLE
    checkpoint.checksum = checksum
    checkpoint.size_bytes = payload.get("size")
    checkpoint.storage_manifest = manifest
    checkpoint.sdk_version = str(manifest.get("sdk_version") or "")[:50]
    checkpoint.runtime_version = str(manifest.get("runtime_version") or "")[:100]
    checkpoint.last_event_seq = conversation.last_event_seq
    checkpoint.completed_at = timezone.now()
    checkpoint.save()
    _finish_checkpoint_command(checkpoint.command, "succeeded")


def checkpoint_failed(conversation, agent, instance, command, payload):
    checkpoint = AgentCheckpoint.objects.filter(
        pk=payload.get("checkpoint_id"), agent=agent
    ).first()
    if checkpoint and checkpoint.status != AgentCheckpoint.Status.AVAILABLE:
        checkpoint.status = AgentCheckpoint.Status.FAILED
        checkpoint.save(update_fields=["status"])
        _finish_checkpoint_command(checkpoint.command, "failed")


def _finish_checkpoint_command(command: AgentCommand, outcome: str) -> None:
    if command.status in services.TERMINAL_COMMAND_STATUSES:
        return
    command.status = (
        AgentCommand.Status.SUCCEEDED
        if outcome == "succeeded"
        else AgentCommand.Status.FAILED
    )
    command.finished_at = timezone.now()
    command.save(update_fields=["status", "finished_at"])


def mcp_status(conversation, agent, instance, command, payload):
    key = str(payload.get("module_key") or "")[:64]
    if key:
        instance.mcp_status = {**instance.mcp_status, key: payload.get("status")}


def runtime_failed(conversation, agent, instance, command, payload):
    mark_runtime_failed(
        conversation, agent, instance, str(payload.get("code") or "RUNTIME_FAILED")
    )


def mark_runtime_failed(conversation, agent, instance, code: str) -> None:
    """A runtime that cannot become ready: say so, and fail what waits on it."""
    instance.status = RuntimeInstance.Status.FAILED
    instance.error_code = code[:64]
    recovery = code.startswith("RECOVERY")
    agent.status = Agent.Status.RECOVERY_FAILED if recovery else Agent.Status.ERROR
    agent.last_error_code = code[:64]
    agent.save(update_fields=["status", "last_error_code", "updated_at"])
    if recovery:
        AgentSession.objects.filter(agent=agent).update(
            status=AgentSession.Status.RECOVERY_FAILED, last_error=code[:100]
        )
    reason = (
        "AGENT_RECOVERY_FAILED"
        if recovery
        else "AGENT_EXTENSION_FAILED"
        if code.startswith("MCP")
        else "AGENT_UNAVAILABLE"
    )
    waiting = AgentCommand.objects.select_related("agent").filter(
        agent=agent,
        kind__in=AgentCommand.USER_KINDS,
        status__in=[AgentCommand.Status.QUEUED, AgentCommand.Status.DISPATCHING],
    )
    for waiting_command in waiting:
        services.finish_command(conversation, waiting_command, "failed", reason)
    services.refresh_agent_status(conversation, agent)


HANDLERS = {
    "turn.started": turn_started,
    "item.updated": item_updated,
    "approval.requested": approval_requested,
    "approval.applied": approval_applied,
    "approval.expired": approval_expired,
    "turn.completed": turn_completed,
    "turn.steered": turn_steered,
    "command.outcome_unknown": outcome_unknown,
    "checkpoint.started": checkpoint_started,
    "checkpoint.completed": checkpoint_completed,
    "checkpoint.failed": checkpoint_failed,
    "mcp.status": mcp_status,
    "runtime.failed": runtime_failed,
}
