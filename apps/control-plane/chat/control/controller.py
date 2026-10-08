"""Runtime controller: keeps a runtime running for every agent with work.

Runtimes take their work from the agent queue (chat/queue.py) themselves; the
controller starts, replaces and stops their containers. Each tick runs short
database transactions; Docker and queue calls always happen outside them.
Every write locks the conversation row first, like the API, so the
controller and request handlers never deadlock.
"""

import json
import logging
import os
import socket
import threading
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import close_old_connections, transaction
from django.db.models import Q
from django.utils import timezone

from .. import llm, queue, services
from ..models import Agent, AgentCommand, AgentSession, RuntimeInstance
from . import objects
from .auth import runtime_token
from .driver import RuntimeSpec
from .internal_api import LEASE_SECONDS
from .projection import mark_runtime_failed

logger = logging.getLogger(__name__)

ACTIVE = AgentCommand.ACTIVE_STATUSES
READY = (RuntimeInstance.Status.READY, RuntimeInstance.Status.BUSY)
HOST_ID = socket.gethostname()
START_TIMEOUT_SECONDS = 120
IDLE_SECONDS = 600
# A runtime that never came up is retried after this long.
RETRY_SECONDS = 30
# The OpenTelemetry Collector on the runtime network.
RUNTIME_OTLP_ENDPOINT = "http://otel-collector:4318"


def _seconds(value: float) -> timedelta:
    return timedelta(seconds=value)


def _instructions(agent: Agent) -> str:
    """The agent's identity, then the user's instructions."""
    identity = f"你的名字是{agent.name}。"
    return f"{identity}\n\n{agent.description}" if agent.description else identity


class Controller:
    def __init__(self, driver, *, controller_id: str | None = None):
        self.driver = driver
        self.controller_id = controller_id or f"controller-{uuid.uuid4().hex[:8]}"
        # Agents with commands in the queue, as of this tick.
        self.waiting: set[str] = set()

    def run_forever(
        self,
        interval: float = 0.5,
        stop: threading.Event | None = None,
        before_tick=lambda: None,
    ) -> None:
        """Tick until ``stop`` is set; a tick in progress always finishes."""
        stop = stop or threading.Event()
        logger.info("Controller %s started", self.controller_id)
        while not stop.is_set():
            before_tick()
            # Connections broken by a database restart are replaced.
            close_old_connections()
            self.tick()
            stop.wait(interval)
        logger.info("Controller %s stopped", self.controller_id)

    def tick(self) -> None:
        for step in (
            self.look_at_queue,
            self.expire_runtimes,
            self.restart_outdated,
            self.ensure_runtimes,
            self.stop_idle,
            self.stop_deleted,
        ):
            try:
                step()
            except Exception:
                logger.exception("Controller step %s failed", step.__name__)

    def look_at_queue(self) -> None:
        self.waiting = queue.agents_with_commands()

    # --- runtime lifecycle ----------------------------------------------------

    def expire_runtimes(self) -> None:
        now = timezone.now()
        live = RuntimeInstance.objects.filter(ended_at__isnull=True).select_related(
            "agent"
        )
        for instance in live:
            retry_failed = (
                instance.status == RuntimeInstance.Status.FAILED
                and str(instance.agent_id) in self.waiting
            )
            if instance.lease_expires_at < now:
                reason = "LEASE_EXPIRED"
                if instance.last_heartbeat_at is None:
                    # It never came up: what waits for it fails.
                    self._fail_start(instance, "START_TIMEOUT")
            elif retry_failed:
                # New work arrived for a failed runtime: try a fresh one.
                reason = "RETRY"
            else:
                continue
            # Fence physically before a replacement starts.
            self.driver.stop(instance.container_id)
            self.end_instance(
                instance,
                reason,
                RuntimeInstance.Status.FAILED
                if reason == "LEASE_EXPIRED"
                else RuntimeInstance.Status.STOPPED,
            )

    def _fail_start(self, instance: RuntimeInstance, code: str) -> None:
        with transaction.atomic():
            conversation = services.lock_conversation(instance.agent.conversation_id)
            instance.refresh_from_db()
            mark_runtime_failed(conversation, instance.agent, instance, code)
            instance.save(update_fields=["status", "error_code"])

    def end_instance(self, instance: RuntimeInstance, reason: str, status: str) -> None:
        # Queued commands no longer in the queue were taken by this instance
        # (only one runs per agent): they may have started.
        taken = [
            command.pk
            for command in AgentCommand.objects.filter(
                agent_id=instance.agent_id, status=AgentCommand.Status.QUEUED
            )
            if command.queue_seq is None or not queue.waiting(command.queue_seq)
        ]
        with transaction.atomic():
            conversation = services.lock_conversation(instance.agent.conversation_id)
            instance = RuntimeInstance.objects.select_related("agent").get(
                pk=instance.pk
            )
            if instance.ended_at is not None:
                return
            instance.ended_at = timezone.now()
            instance.status = status
            instance.end_reason = reason
            instance.save(update_fields=["ended_at", "status", "end_reason"])
            # Its container, and whatever ran there since the last snapshot,
            # is gone. What it took from the queue is never replayed; the rest
            # waits there for the next instance.
            for command in AgentCommand.objects.select_related("agent").filter(
                Q(runtime_instance=instance, status__in=ACTIVE) | Q(pk__in=taken)
            ):
                if command.interrupt_requested_at:
                    services.finish_command(conversation, command, "cancelled")
                else:
                    services.finish_command(
                        conversation, command, "failed", "REPLY_INTERRUPTED"
                    )
            agent = instance.agent
            if agent.status not in (Agent.Status.ERROR, Agent.Status.RECOVERY_FAILED):
                agent.status = Agent.Status.STOPPED
                agent.save(update_fields=["status", "updated_at"])
            services.refresh_agent_status(conversation, agent)

    def ensure_runtimes(self) -> None:
        wanted = Agent.objects.filter(
            Q(pk__in=self.waiting) | Q(desired_state=Agent.DesiredState.RUNNING),
            deleted_at__isnull=True,
        )
        retry_after = timezone.now() - _seconds(RETRY_SECONDS)
        for agent in wanted:
            if agent.runtimes.filter(ended_at__isnull=True).exists():
                continue
            last = agent.runtimes.order_by("-generation").first()
            if (
                last
                and last.status == RuntimeInstance.Status.FAILED
                and last.last_heartbeat_at is None
                and last.ended_at > retry_after
            ):
                # It never came up: back off instead of crash-looping.
                continue
            self.provision(agent)

    def provision(self, agent: Agent) -> RuntimeInstance | None:
        session, _ = AgentSession.objects.get_or_create(agent=agent)
        # Every container starts empty; the agent's home comes from its snapshot.
        restore = objects.snapshot_exists(agent.pk)

        with transaction.atomic():
            conversation = services.lock_conversation(agent.conversation_id)
            agent = Agent.objects.select_for_update().get(pk=agent.pk)
            if agent.runtimes.filter(ended_at__isnull=True).exists():
                return None
            agent.generation += 1
            recovering = bool(session.thread_id)
            instance = RuntimeInstance.objects.create(
                agent=agent,
                generation=agent.generation,
                host_id=HOST_ID,
                controller_id=self.controller_id,
                status=(
                    RuntimeInstance.Status.RECOVERING
                    if recovering
                    else RuntimeInstance.Status.PROVISIONING
                ),
                lease_expires_at=timezone.now() + _seconds(START_TIMEOUT_SECONDS),
                config_version=agent.config_version,
            )
            agent.status = (
                Agent.Status.RECOVERING if recovering else Agent.Status.PROVISIONING
            )
            agent.save(update_fields=["generation", "status", "updated_at"])
            if recovering:
                AgentSession.objects.filter(agent=agent).update(
                    status=AgentSession.Status.RECOVERING
                )
            services.refresh_agent_status(conversation, agent)

        try:
            queue.open_consumer(agent.pk)
            started = self.driver.start(self._spec(agent, instance, session, restore))
        except Exception:
            logger.exception("Failed to start runtime for agent %s", agent.pk)
            self._fail_start(instance, "START_FAILED")
            self.end_instance(instance, "START_FAILED", RuntimeInstance.Status.FAILED)
            return None
        RuntimeInstance.objects.filter(pk=instance.pk).update(
            container_id=started.container_id,
            image_digest=started.image_digest,
        )
        instance.refresh_from_db()
        return instance

    def _spec(self, agent, instance, session, restore: bool) -> RuntimeSpec:
        token = runtime_token(instance.pk, instance.generation)
        env = {
            "AXP_AGENT_ID": str(agent.pk),
            "AXP_INSTANCE_ID": str(instance.pk),
            "AXP_GENERATION": str(instance.generation),
            "AXP_RUNTIME_TOKEN": token,
            # The runtime's only route out: the internal API and, for model
            # requests, the LLM gateway. Provider credentials never enter the
            # container.
            "AXP_GATEWAY_URL": settings.AXP_RUNTIME_GATEWAY_URL,
            # Its work: the agent's queue.
            "AXP_NATS_URL": settings.AXP_NATS_URL,
            "AXP_THREAD_ID": session.thread_id or "",
            "AXP_CODEX_SETTINGS": json.dumps(
                {
                    "model": agent.model,
                    "model_context_window": llm.context_window(agent.model),
                    "developer_instructions": _instructions(agent),
                    "plugins": agent.plugins,
                }
            ),
            "AXP_CONFIG_VERSION": str(instance.config_version),
            "AXP_HEARTBEAT_SECONDS": str(LEASE_SECONDS / 4),
            # The runtime and Codex export without credentials; the collector
            # holds them. Resource attributes tie records to the agent.
            "OTEL_EXPORTER_OTLP_ENDPOINT": RUNTIME_OTLP_ENDPOINT,
            "OTEL_SERVICE_NAME": "agent-runtime",
            "OTEL_RESOURCE_ATTRIBUTES": ",".join(
                a
                for a in (
                    os.environ.get("OTEL_RESOURCE_ATTRIBUTES", ""),
                    f"axp.agent.id={agent.pk}",
                    f"axp.runtime.instance.id={instance.pk}",
                    f"axp.runtime.generation={instance.generation}",
                )
                if a
            ),
        }
        if restore:
            env["AXP_SNAPSHOT_URL"] = objects.download_url(agent.pk)
        if settings.AXP_CODEX_LAUNCH:
            env["AXP_CODEX_LAUNCH"] = settings.AXP_CODEX_LAUNCH
        return RuntimeSpec(
            agent_id=str(agent.pk),
            instance_id=str(instance.pk),
            generation=instance.generation,
            name=self.driver.name(f"agent-{agent.pk}-g{instance.generation}"),
            env=env,
        )

    def stop_idle(self) -> None:
        idle_before = timezone.now() - _seconds(IDLE_SECONDS)
        for instance in RuntimeInstance.objects.filter(
            ended_at__isnull=True, status=RuntimeInstance.Status.READY
        ).select_related("agent"):
            agent = instance.agent
            if agent.desired_state == Agent.DesiredState.RUNNING or self._busy(agent):
                continue
            if (agent.last_active_at or instance.created_at) > idle_before:
                continue
            self.driver.stop(instance.container_id)
            self.end_instance(instance, "IDLE", RuntimeInstance.Status.STOPPED)

    def restart_outdated(self) -> None:
        """Restart runtimes started with an old configuration.

        Only between turns, so a turn never sees its configuration change; the
        replacement resumes the same thread with the new configuration.
        """
        for instance in RuntimeInstance.objects.filter(
            ended_at__isnull=True, status__in=READY
        ).select_related("agent"):
            agent = instance.agent
            if instance.config_version >= agent.config_version:
                continue
            if self._busy(agent):
                continue
            self.driver.stop(instance.container_id)
            self.end_instance(
                instance, "CONFIG_CHANGED", RuntimeInstance.Status.STOPPED
            )

    def stop_deleted(self) -> None:
        """Stop runtimes of deleted agents once their interrupted work settles."""
        for instance in RuntimeInstance.objects.filter(
            ended_at__isnull=True, agent__deleted_at__isnull=False
        ).select_related("agent"):
            if instance.agent.commands.filter(status__in=ACTIVE).exists():
                continue
            self.driver.stop(instance.container_id)
            self.end_instance(instance, "DELETED", RuntimeInstance.Status.STOPPED)
            queue.forget(instance.agent_id)

    def _busy(self, agent: Agent) -> bool:
        return (
            str(agent.pk) in self.waiting
            or agent.commands.filter(status__in=ACTIVE).exists()
        )
