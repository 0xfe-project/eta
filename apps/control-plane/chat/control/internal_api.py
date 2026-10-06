"""Internal runtime protocol, runtime -> control plane (RFC §6).

Served by a separate process (``config.internal_urls``) on the runtime
network. It is never mounted on the public server and has its own OpenAPI.
"""

import uuid
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.http import HttpRequest, HttpResponse, StreamingHttpResponse
from django.utils import timezone
from ninja import NinjaAPI, Schema
from pydantic import ConfigDict, Field

from .. import services
from ..errors import ApiError, install_error_handlers
from ..models import Agent, AgentCheckpoint, AgentSession, RuntimeInstance
from . import projection
from .auth import token_matches
from .objects import FilesystemStore, object_store

api = NinjaAPI(
    title="AXP Internal Runtime Protocol",
    version="1",
    urls_namespace="internal",
    docs_url="/docs" if settings.DEBUG else None,
)
install_error_handlers(api)

RUNTIME_STATUSES = {"starting", "ready", "busy", "recovery_failed", "error"}


class Strict(Schema):
    model_config = ConfigDict(extra="ignore")


class HeartbeatIn(Strict):
    status: str
    error_code: str | None = None
    current_command_id: str | None = None
    thread_id: str | None = None
    mcp_config_version: int = 0
    protocol_version: str = "1"
    sdk_version: str | None = None
    runtime_version: str | None = None


class SessionIn(Strict):
    thread_id: str = Field(min_length=1, max_length=100)
    resumed: bool = False
    sdk_version: str | None = None
    runtime_version: str | None = None


class EventIn(Strict):
    source_seq: int
    source_event_id: str = Field(max_length=100)
    type: str = Field(max_length=64)
    payload: dict


class EventsIn(Strict):
    events: list[EventIn] = Field(max_length=projection.MAX_BATCH)


def _fenced() -> ApiError:
    return ApiError(409, "STALE_GENERATION", "运行实例已失效。")


def _instance(
    request: HttpRequest, instance_id, *, live: bool = True
) -> RuntimeInstance:
    """Authenticate a runtime by its instance-bound token."""
    instance = (
        RuntimeInstance.objects.select_related("agent").filter(pk=instance_id).first()
        if _is_uuid(instance_id)
        else None
    )
    if instance is None or not token_matches(request, instance):
        raise ApiError(403, "INVALID_RUNTIME_TOKEN", "运行实例令牌无效。")
    if live and (
        instance.ended_at is not None
        or instance.generation != instance.agent.generation
    ):
        raise _fenced()
    return instance


def _is_uuid(value) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except ValueError:
        return False


@api.post("/v1/runtime-instances/{instance_id}/heartbeat", auth=None)
def heartbeat(request: HttpRequest, instance_id: str, body: HeartbeatIn):
    instance = _instance(request, instance_id)
    now = timezone.now()
    with transaction.atomic():
        conversation = services.lock_conversation(instance.agent.conversation_id)
        instance = RuntimeInstance.objects.select_related("agent").get(pk=instance.pk)
        if instance.ended_at is not None:
            raise _fenced()
        agent = instance.agent
        instance.last_heartbeat_at = now
        instance.lease_expires_at = now + timedelta(
            seconds=settings.AXP_RUNTIME_LEASE_SECONDS
        )
        status = body.status if body.status in RUNTIME_STATUSES else "starting"
        if status in ("recovery_failed", "error"):
            if instance.status != RuntimeInstance.Status.FAILED:
                projection.mark_runtime_failed(
                    conversation, agent, instance, body.error_code or "RUNTIME_FAILED"
                )
        elif status in ("ready", "busy"):
            instance.status = (
                RuntimeInstance.Status.READY
                if status == "ready"
                else RuntimeInstance.Status.BUSY
            )
            if agent.status not in (Agent.Status.READY, Agent.Status.BUSY):
                agent.status = Agent.Status.READY
                agent.last_error_code = None
                agent.save(update_fields=["status", "last_error_code", "updated_at"])
                services.refresh_agent_status(conversation, agent)
        instance.save(
            update_fields=[
                "last_heartbeat_at",
                "lease_expires_at",
                "status",
                "error_code",
            ]
        )
    return {
        "lease_expires_at": instance.lease_expires_at.isoformat(),
        "generation": instance.generation,
    }


@api.put("/v1/runtime-instances/{instance_id}/session", auth=None)
def register_session(request: HttpRequest, instance_id: str, body: SessionIn):
    instance = _instance(request, instance_id)
    with transaction.atomic():
        session, _ = AgentSession.objects.select_for_update().get_or_create(
            agent=instance.agent
        )
        if session.thread_id and session.thread_id != body.thread_id:
            # Never let a runtime silently swap the agent's thread.
            raise ApiError(409, "THREAD_MISMATCH", "会话与记录不一致。")
        session.thread_id = body.thread_id
        session.status = AgentSession.Status.READY
        session.sdk_version = (body.sdk_version or "")[:50]
        session.runtime_version = (body.runtime_version or "")[:100]
        session.last_resume_at = timezone.now() if body.resumed else None
        session.last_error = None
        session.save()
    return {"thread_id": session.thread_id}


@api.post("/v1/runtime-instances/{instance_id}/events", auth=None)
def post_events(request: HttpRequest, instance_id: str, body: EventsIn):
    instance = _instance(request, instance_id)
    events = [event.model_dump() for event in body.events]
    with transaction.atomic():
        acked = projection.import_events(instance, events)
    return {"acked_source_seq": acked}


def _checkpoint_for(request, checkpoint_id) -> AgentCheckpoint:
    checkpoint = (
        AgentCheckpoint.objects.select_related("agent").filter(pk=checkpoint_id).first()
        if _is_uuid(checkpoint_id)
        else None
    )
    if checkpoint is None:
        raise ApiError(404, "NOT_FOUND", "资源不存在。")
    instance = (
        RuntimeInstance.objects.filter(agent=checkpoint.agent, ended_at__isnull=True)
        .select_related("agent")
        .first()
    )
    if instance is None or not token_matches(request, instance):
        raise ApiError(403, "INVALID_RUNTIME_TOKEN", "运行实例令牌无效。")
    return checkpoint


@api.put("/v1/checkpoints/{checkpoint_id}/object", auth=None)
def upload_checkpoint(request: HttpRequest, checkpoint_id: str):
    store = object_store()
    if not isinstance(store, FilesystemStore):
        raise ApiError(404, "NOT_FOUND", "资源不存在。")
    checkpoint = _checkpoint_for(request, checkpoint_id)
    if checkpoint.status not in (
        AgentCheckpoint.Status.PENDING,
        AgentCheckpoint.Status.CREATING,
    ):
        raise ApiError(409, "CHECKPOINT_CLOSED", "检查点不可写入。")
    # Stream the body; checkpoints exceed Django's in-memory body limit.
    store.write(checkpoint.state_object_key, request)
    return HttpResponse(status=204)


@api.get("/v1/checkpoints/{checkpoint_id}/object", auth=None)
def download_checkpoint(request: HttpRequest, checkpoint_id: str):
    store = object_store()
    checkpoint = _checkpoint_for(request, checkpoint_id)
    if not isinstance(store, FilesystemStore) or (
        checkpoint.status != AgentCheckpoint.Status.AVAILABLE
    ):
        raise ApiError(404, "NOT_FOUND", "资源不存在。")
    handle = store.open(checkpoint.state_object_key)
    return StreamingHttpResponse(
        iter(lambda: handle.read(1 << 20), b""),
        content_type="application/gzip",
    )
