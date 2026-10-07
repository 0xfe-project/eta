"""Runtime controller: turns queued intent into execution (RFC §5-7).

Each tick runs short database transactions; Docker and runtime calls always
happen outside them. Every write locks the conversation row first, like the
API, so the controller and request handlers never deadlock.
"""

import json
import logging
import os
import socket
import threading
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .. import llm, services
from ..models import (
    Agent,
    AgentCheckpoint,
    AgentCommand,
    AgentSession,
    AgentStorage,
    Approval,
    Interaction,
    Message,
    RuntimeInstance,
)
from . import mcp, objects
from .auth import runtime_token
from .driver import RuntimeSpec
from .internal_api import LEASE_SECONDS
from .projection import mark_runtime_failed
from .runtime_client import RuntimeClient, RuntimeHttpError, RuntimeUnavailable

logger = logging.getLogger(__name__)

ACTIVE = AgentCommand.ACTIVE_STATUSES
LIVE_EXECUTION = (
    AgentCommand.Status.DISPATCHING,
    AgentCommand.Status.RUNNING,
    AgentCommand.Status.WAITING_APPROVAL,
)
READY = (RuntimeInstance.Status.READY, RuntimeInstance.Status.BUSY)
REDISPATCH_SECONDS = 3
HOST_ID = socket.gethostname()
START_TIMEOUT_SECONDS = 120
IDLE_SECONDS = 600
# A runtime that never came up is retried after this long.
RETRY_SECONDS = 30
DISPATCH_TIMEOUT_SECONDS = 120
CHECKPOINT_AFTER_TURNS = 5
# The per-agent container is the isolation boundary.
CODEX_SANDBOX = "danger-full-access"
CODEX_APPROVAL_POLICY = "on-request"
# The OpenTelemetry Collector on the runtime network.
RUNTIME_OTLP_ENDPOINT = "http://otel-collector:4318"


def _seconds(value: float) -> timedelta:
    return timedelta(seconds=value)


class Controller:
    def __init__(
        self, driver, *, controller_id: str | None = None, client=RuntimeClient
    ):
        self.driver = driver
        self.controller_id = controller_id or f"controller-{uuid.uuid4().hex[:8]}"
        self.client = client

    def run_forever(
        self, interval: float = 0.5, stop: threading.Event | None = None
    ) -> None:
        """Tick until ``stop`` is set; a tick in progress always finishes."""
        stop = stop or threading.Event()
        logger.info("Controller %s started", self.controller_id)
        while not stop.is_set():
            self.tick()
            stop.wait(interval)
        logger.info("Controller %s stopped", self.controller_id)

    def tick(self) -> None:
        for step in (
            self.expire_runtimes,
            self.fail_stale_queued,
            self.restart_outdated,
            self.ensure_runtimes,
            self.reconcile_unknown,
            self.dispatch,
            self.deliver_interrupts,
            self.deliver_steers,
            self.deliver_decisions,
            self.schedule_checkpoints,
            self.stop_idle,
            self.stop_deleted,
        ):
            try:
                step()
            except Exception:
                logger.exception("Controller step %s failed", step.__name__)

    # --- runtime lifecycle ----------------------------------------------------

    def expire_runtimes(self) -> None:
        now = timezone.now()
        live = RuntimeInstance.objects.filter(ended_at__isnull=True).select_related(
            "agent"
        )
        for instance in live:
            retry_failed = (
                instance.status == RuntimeInstance.Status.FAILED
                and AgentCommand.objects.filter(
                    agent=instance.agent,
                    kind__in=AgentCommand.USER_KINDS,
                    status=AgentCommand.Status.QUEUED,
                ).exists()
            )
            if instance.lease_expires_at < now:
                reason = "LEASE_EXPIRED"
            elif retry_failed:
                # New work arrived for a failed runtime: try a fresh one.
                reason = "RETRY"
            else:
                continue
            # Fence physically before a replacement may write the state volume.
            self.driver.stop(instance.container_id)
            self.end_instance(
                instance,
                reason,
                RuntimeInstance.Status.FAILED
                if reason == "LEASE_EXPIRED"
                else RuntimeInstance.Status.STOPPED,
            )

    def end_instance(self, instance: RuntimeInstance, reason: str, status: str) -> None:
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
            # Whatever ran there may or may not have happened: hold the slot
            # until the next runtime reconciles it.
            instance.commands.filter(status__in=LIVE_EXECUTION).update(
                status=AgentCommand.Status.OUTCOME_UNKNOWN
            )
            approvals = instance.approvals.filter(
                status__in=[Approval.Status.PENDING, Approval.Status.DECIDED]
            )
            approvals.filter(status=Approval.Status.DECIDED).update(
                status=Approval.Status.DELIVERY_UNKNOWN
            )
            approvals.update(status=Approval.Status.EXPIRED, resolved_at=timezone.now())
            for interaction in Interaction.objects.filter(
                approval__runtime_instance=instance,
                status__in=[Interaction.Status.PENDING, Interaction.Status.SUBMITTED],
            ):
                services.save_interaction(
                    conversation, interaction, status=Interaction.Status.EXPIRED
                )
            for reply in Message.objects.filter(
                command__runtime_instance=instance,
                role=Message.Role.ASSISTANT,
                status=Message.Status.WAITING_FOR_INPUT,
            ):
                services.save_message(
                    conversation, reply, status=Message.Status.RESPONDING
                )
            agent = instance.agent
            if agent.status not in (Agent.Status.ERROR, Agent.Status.RECOVERY_FAILED):
                agent.status = Agent.Status.STOPPED
                agent.save(update_fields=["status", "updated_at"])
            services.refresh_agent_status(conversation, agent)

    def ensure_runtimes(self) -> None:
        wanted = Agent.objects.filter(
            Q(
                commands__status__in=[
                    AgentCommand.Status.QUEUED,
                    AgentCommand.Status.OUTCOME_UNKNOWN,
                ]
            )
            | Q(desired_state=Agent.DesiredState.RUNNING),
            deleted_at__isnull=True,
        ).distinct()
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
        storage = self._storage(agent)
        session, _ = AgentSession.objects.get_or_create(agent=agent)
        # Check before creating it: a missing state volume means lost state.
        state_missing = not self.driver.volume_exists(storage.state_volume_ref)
        self.driver.ensure_volume(storage.state_volume_ref)
        if storage.status != AgentStorage.Status.READY:
            AgentStorage.objects.filter(pk=storage.pk).update(
                status=AgentStorage.Status.READY
            )
        restore = None
        if state_missing and session.thread_id:
            restore = (
                agent.checkpoints.filter(status=AgentCheckpoint.Status.AVAILABLE)
                .order_by("-created_at")
                .first()
            )
        try:
            snapshot = mcp.snapshot(agent)
        except mcp.McpConfigError:
            logger.exception("Invalid MCP configuration for agent %s", agent.pk)
            snapshot = None

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
                mcp_snapshot=snapshot or [],
                config_version=agent.config_version,
                restored_checkpoint=restore,
            )
            agent.status = (
                Agent.Status.RECOVERING if recovering else Agent.Status.PROVISIONING
            )
            agent.save(update_fields=["generation", "status", "updated_at"])
            if recovering:
                gap = None
                if restore:
                    # Turns after the checkpoint are not in the restored Codex
                    # state. Record the gap; never re-run them.
                    gap = {
                        "checkpoint_id": str(restore.id),
                        "commands": [
                            str(pk)
                            for pk in agent.commands.filter(
                                kind__in=AgentCommand.USER_KINDS,
                                finished_at__gt=restore.completed_at,
                            ).values_list("pk", flat=True)
                        ],
                    }
                AgentSession.objects.filter(agent=agent).update(
                    status=AgentSession.Status.RECOVERING,
                    **({"recovery_gap": gap} if restore else {}),
                )
            if snapshot is None:
                instance.status = RuntimeInstance.Status.FAILED
                mark_runtime_failed(conversation, agent, instance, "MCP_CONFIG_INVALID")
                instance.ended_at = timezone.now()
                instance.end_reason = "MCP_CONFIG_INVALID"
                instance.save()
                return None
            services.refresh_agent_status(conversation, agent)

        try:
            started = self.driver.start(
                self._spec(agent, instance, storage, session, restore)
            )
        except Exception:
            logger.exception("Failed to start runtime for agent %s", agent.pk)
            with transaction.atomic():
                conversation = services.lock_conversation(agent.conversation_id)
                instance.refresh_from_db()
                mark_runtime_failed(conversation, agent, instance, "START_FAILED")
                instance.save(update_fields=["status", "error_code"])
            self.end_instance(instance, "START_FAILED", RuntimeInstance.Status.FAILED)
            return None
        RuntimeInstance.objects.filter(pk=instance.pk).update(
            container_id=started.container_id,
            endpoint=started.endpoint,
            image_digest=started.image_digest,
        )
        instance.refresh_from_db()
        return instance

    def _storage(self, agent: Agent) -> AgentStorage:
        storage, _ = AgentStorage.objects.get_or_create(
            agent=agent,
            defaults={
                "workspace_path": f"agents/{agent.pk}/workspace",
                "state_volume_ref": self.driver.name(f"state-{agent.pk}"),
                "host_id": HOST_ID,
            },
        )
        return storage

    def _spec(self, agent, instance, storage, session, restore) -> RuntimeSpec:
        token = runtime_token(instance.pk, instance.generation)
        env = {
            "AXP_AGENT_ID": str(agent.pk),
            "AXP_INSTANCE_ID": str(instance.pk),
            "AXP_GENERATION": str(instance.generation),
            "AXP_RUNTIME_TOKEN": token,
            "AXP_CONTROL_PLANE_URL": settings.AXP_INTERNAL_URL,
            # Model requests go through the LLM gateway, which checks the
            # runtime's token with the internal API; provider credentials
            # never enter the container.
            "AXP_LLM_BASE_URL": settings.AXP_LLM_GATEWAY_URL.rstrip("/") + "/v1",
            "AXP_THREAD_ID": session.thread_id or "",
            "AXP_CODEX_SETTINGS": json.dumps(
                {
                    "model": agent.model,
                    "model_context_window": llm.context_window(agent.model),
                    "sandbox": CODEX_SANDBOX,
                    "approval_policy": CODEX_APPROVAL_POLICY,
                    "developer_instructions": agent.description,
                }
            ),
            "AXP_MCP_SNAPSHOT": json.dumps(instance.mcp_snapshot),
            "AXP_CONFIG_VERSION": str(instance.config_version),
            "AXP_HEARTBEAT_SECONDS": str(LEASE_SECONDS / 4),
            "AXP_JUICEFS_META_URL": settings.AXP_JUICEFS_META_URL,
            "AXP_WORKSPACE_PATH": storage.workspace_path,
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
            env["AXP_RESTORE"] = json.dumps(
                {
                    "checkpoint_id": str(restore.pk),
                    "checksum": restore.checksum,
                    "url": objects.download_url(restore.state_object_key),
                }
            )
        if settings.AXP_CODEX_LAUNCH:
            env["AXP_CODEX_LAUNCH"] = settings.AXP_CODEX_LAUNCH
        return RuntimeSpec(
            agent_id=str(agent.pk),
            instance_id=str(instance.pk),
            generation=instance.generation,
            name=self.driver.name(f"agent-{agent.pk}-g{instance.generation}"),
            env=env,
            state_volume=storage.state_volume_ref,
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
            if self._checkpoint_due(agent, minimum_turns=1):
                self.enqueue_checkpoint(agent)
                continue
            self.driver.stop(instance.container_id)
            self.end_instance(instance, "IDLE", RuntimeInstance.Status.STOPPED)

    def restart_outdated(self) -> None:
        """Restart runtimes started with old instructions or MCP bindings.

        Only between turns, so a turn never sees its configuration change; the
        replacement resumes the same thread with the new configuration.
        """
        for instance in RuntimeInstance.objects.filter(
            ended_at__isnull=True, status__in=READY
        ).select_related("agent"):
            agent = instance.agent
            if instance.config_version >= agent.config_version:
                continue
            if agent.commands.filter(status__in=ACTIVE).exists():
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
            if instance.agent.commands.filter(status__in=LIVE_EXECUTION).exists():
                continue
            self.driver.stop(instance.container_id)
            self.end_instance(instance, "DELETED", RuntimeInstance.Status.STOPPED)

    # --- queue ----------------------------------------------------------------

    def _busy(self, agent: Agent) -> bool:
        return agent.commands.filter(
            status__in=[AgentCommand.Status.QUEUED, *ACTIVE]
        ).exists()

    def fail_stale_queued(self) -> None:
        cutoff = timezone.now() - _seconds(DISPATCH_TIMEOUT_SECONDS)
        stale = AgentCommand.objects.filter(
            kind__in=AgentCommand.USER_KINDS,
            status=AgentCommand.Status.QUEUED,
            created_at__lt=cutoff,
        ).select_related("agent")
        for command in stale:
            # A command queued behind a long turn on a ready runtime still waits.
            if command.agent.runtimes.filter(
                ended_at__isnull=True, status__in=READY
            ).exists():
                continue
            with transaction.atomic():
                conversation = services.lock_conversation(command.agent.conversation_id)
                command.refresh_from_db()
                if command.status == AgentCommand.Status.QUEUED:
                    services.finish_command(
                        conversation, command, "failed", "DISPATCH_TIMEOUT"
                    )

    def dispatch(self) -> None:
        for instance in RuntimeInstance.objects.filter(
            ended_at__isnull=True, status__in=READY
        ).select_related("agent"):
            agent = instance.agent
            client = self.client(instance)
            resend_before = timezone.now() - _seconds(REDISPATCH_SECONDS)
            # PUT is idempotent: resend dispatches whose response we never saw.
            for command in agent.commands.filter(
                status=AgentCommand.Status.DISPATCHING,
                runtime_instance=instance,
                dispatched_at__lt=resend_before,
            ):
                self._send(client, command)
            command = self._claim(instance)
            if command:
                self._send(client, command)

    def _claim(self, instance: RuntimeInstance) -> AgentCommand | None:
        agent = instance.agent
        with transaction.atomic():
            services.lock_conversation(agent.conversation_id)
            if agent.commands.filter(status__in=ACTIVE).exists():
                return None
            command = (
                agent.commands.filter(status=AgentCommand.Status.QUEUED)
                .order_by("agent_sequence")
                .first()
            )
            if command is None:
                return None
            command.status = AgentCommand.Status.DISPATCHING
            command.runtime_instance = instance
            command.dispatch_generation = instance.generation
            command.attempt_count += 1
            command.save(
                update_fields=[
                    "status",
                    "runtime_instance",
                    "dispatch_generation",
                    "attempt_count",
                ]
            )
            if command.kind in AgentCommand.USER_KINDS:
                agent.last_active_at = timezone.now()
                agent.save(update_fields=["last_active_at", "updated_at"])
            return command

    def _send(self, client, command: AgentCommand) -> None:
        AgentCommand.objects.filter(pk=command.pk).update(dispatched_at=timezone.now())
        try:
            client.put_command(command)
        except RuntimeHttpError as exc:
            if exc.code == "COMMAND_CONFLICT":
                self._fail(command, "TURN_FAILED")
            else:
                logger.warning("Dispatch of %s deferred: %s", command.pk, exc)
        except RuntimeUnavailable as exc:
            logger.warning("Runtime unreachable for %s: %s", command.pk, exc)

    def _fail(self, command: AgentCommand, code: str) -> None:
        with transaction.atomic():
            conversation = services.lock_conversation(command.agent.conversation_id)
            command = AgentCommand.objects.select_related("agent").get(pk=command.pk)
            if command.kind == AgentCommand.Kind.CHECKPOINT:
                command.status = AgentCommand.Status.FAILED
                command.finished_at = timezone.now()
                command.save(update_fields=["status", "finished_at"])
                AgentCheckpoint.objects.filter(command=command).exclude(
                    status=AgentCheckpoint.Status.AVAILABLE
                ).update(status=AgentCheckpoint.Status.FAILED)
            else:
                services.finish_command(conversation, command, "failed", code)

    def reconcile_unknown(self) -> None:
        unknown = AgentCommand.objects.filter(
            status=AgentCommand.Status.OUTCOME_UNKNOWN
        ).select_related("agent")
        for command in unknown:
            instance = command.agent.runtimes.filter(
                ended_at__isnull=True, status__in=READY
            ).first()
            if instance is None:
                continue
            try:
                view = self.client(instance).get_command(command.pk)
            except (RuntimeHttpError, RuntimeUnavailable):
                continue
            status = (view or {}).get("status")
            with transaction.atomic():
                conversation = services.lock_conversation(command.agent.conversation_id)
                command = AgentCommand.objects.select_related("agent").get(
                    pk=command.pk
                )
                if command.status != AgentCommand.Status.OUTCOME_UNKNOWN:
                    continue
                if status in ("accepted", "starting", "running"):
                    # The shared ledger kept it; this runtime carries it on.
                    command.status = AgentCommand.Status.RUNNING
                    command.runtime_instance = instance
                    command.dispatch_generation = instance.generation
                    command.save(
                        update_fields=[
                            "status",
                            "runtime_instance",
                            "dispatch_generation",
                        ]
                    )
                elif command.kind == AgentCommand.Kind.CHECKPOINT:
                    command.status = AgentCommand.Status.FAILED
                    command.finished_at = timezone.now()
                    command.save(update_fields=["status", "finished_at"])
                    AgentCheckpoint.objects.filter(command=command).exclude(
                        status=AgentCheckpoint.Status.AVAILABLE
                    ).update(status=AgentCheckpoint.Status.FAILED)
                elif status == "succeeded":
                    services.finish_command(conversation, command, "succeeded")
                elif status == "interrupted":
                    services.finish_command(conversation, command, "interrupted")
                elif status == "failed":
                    services.finish_command(
                        conversation, command, "failed", "TURN_FAILED"
                    )
                elif view is None and instance.restored_checkpoint_id is None:
                    # The ledger never recorded it, so it never ran: queue again.
                    command.status = AgentCommand.Status.QUEUED
                    command.runtime_instance = None
                    command.dispatch_generation = None
                    command.dispatched_at = None
                    command.save(
                        update_fields=[
                            "status",
                            "runtime_instance",
                            "dispatch_generation",
                            "dispatched_at",
                        ]
                    )
                else:
                    services.finish_command(
                        conversation, command, "failed", "REPLY_INTERRUPTED"
                    )

    # --- control channel ------------------------------------------------------

    def deliver_interrupts(self) -> None:
        pending = AgentCommand.objects.filter(
            interrupt_requested_at__isnull=False,
            interrupt_sent_at__isnull=True,
            status__in=LIVE_EXECUTION,
            runtime_instance__ended_at__isnull=True,
        ).select_related("runtime_instance", "agent")
        for command in pending:
            try:
                view = self.client(command.runtime_instance).interrupt(command.pk)
            except (RuntimeHttpError, RuntimeUnavailable) as exc:
                logger.warning("Interrupt of %s deferred: %s", command.pk, exc)
                continue
            if view is None:
                # The runtime never accepted it: cancel locally.
                with transaction.atomic():
                    conversation = services.lock_conversation(
                        command.agent.conversation_id
                    )
                    command.refresh_from_db()
                    if command.status == AgentCommand.Status.DISPATCHING:
                        services.finish_command(conversation, command, "cancelled")
                continue
            AgentCommand.objects.filter(pk=command.pk).update(
                interrupt_sent_at=timezone.now()
            )

    def deliver_steers(self) -> None:
        """Hand queued steers to their agent's running turn.

        A steer stays queued until the runtime reports the turn took it in;
        if the turn ends first, it is claimed and runs as its own turn.
        """
        resend_before = timezone.now() - _seconds(REDISPATCH_SECONDS)
        steers = (
            AgentCommand.objects.filter(
                kind=AgentCommand.Kind.TURN,
                status=AgentCommand.Status.QUEUED,
                input__steer=True,
                interrupt_requested_at__isnull=True,
            )
            .filter(Q(dispatched_at__isnull=True) | Q(dispatched_at__lt=resend_before))
            .order_by("agent_sequence")
        )
        for steer in steers:
            target = (
                AgentCommand.objects.filter(
                    agent_id=steer.agent_id,
                    kind=AgentCommand.Kind.TURN,
                    status__in=[
                        AgentCommand.Status.RUNNING,
                        AgentCommand.Status.WAITING_APPROVAL,
                    ],
                    codex_turn_id__isnull=False,
                    interrupt_requested_at__isnull=True,
                    runtime_instance__ended_at__isnull=True,
                )
                .select_related("runtime_instance")
                .first()
            )
            if target is None:
                continue
            AgentCommand.objects.filter(pk=steer.pk).update(
                dispatched_at=timezone.now()
            )
            try:
                self.client(target.runtime_instance).steer(target, steer)
            except (RuntimeHttpError, RuntimeUnavailable) as exc:
                logger.info("Steer %s not taken: %s", steer.pk, exc)

    def deliver_decisions(self) -> None:
        decided = Approval.objects.filter(
            status=Approval.Status.DECIDED,
            delivery_attempted_at__isnull=True,
            runtime_instance__ended_at__isnull=True,
        ).select_related("runtime_instance", "agent")
        for approval in decided:
            try:
                self.client(approval.runtime_instance).decide(approval)
            except RuntimeUnavailable:
                continue
            except RuntimeHttpError as exc:
                if exc.status != 409:
                    continue
                # The runtime no longer waits on this request.
                with transaction.atomic():
                    conversation = services.lock_conversation(
                        approval.agent.conversation_id
                    )
                    Approval.objects.filter(pk=approval.pk).update(
                        status=Approval.Status.EXPIRED, resolved_at=timezone.now()
                    )
                    interaction = Interaction.objects.filter(approval=approval).first()
                    if interaction and interaction.status in (
                        Interaction.Status.PENDING,
                        Interaction.Status.SUBMITTED,
                    ):
                        services.save_interaction(
                            conversation, interaction, status=Interaction.Status.EXPIRED
                        )
                continue
            Approval.objects.filter(pk=approval.pk).update(
                delivery_attempted_at=timezone.now()
            )

    # --- checkpoints ----------------------------------------------------------

    def _checkpoint_due(self, agent: Agent, minimum_turns: int) -> bool:
        if CHECKPOINT_AFTER_TURNS <= 0:
            return False
        if not AgentSession.objects.filter(
            agent=agent, thread_id__isnull=False
        ).exists():
            return False
        latest = agent.checkpoints.order_by("-created_at").first()
        if latest and latest.status in (
            AgentCheckpoint.Status.PENDING,
            AgentCheckpoint.Status.CREATING,
        ):
            return False
        since = latest.created_at if latest else None
        turns = agent.commands.filter(
            kind__in=AgentCommand.USER_KINDS, status=AgentCommand.Status.SUCCEEDED
        )
        if since:
            turns = turns.filter(finished_at__gt=since)
        count = turns.count()
        if (
            latest
            and latest.status == AgentCheckpoint.Status.FAILED
            and count < CHECKPOINT_AFTER_TURNS
        ):
            # Do not retry a failed checkpoint until enough new work accrues.
            return False
        return count >= minimum_turns

    def schedule_checkpoints(self) -> None:
        for instance in RuntimeInstance.objects.filter(
            ended_at__isnull=True, status=RuntimeInstance.Status.READY
        ).select_related("agent"):
            agent = instance.agent
            if not self._busy(agent) and self._checkpoint_due(
                agent, CHECKPOINT_AFTER_TURNS
            ):
                self.enqueue_checkpoint(agent)

    def enqueue_checkpoint(self, agent: Agent) -> AgentCheckpoint:
        checkpoint_id = uuid.uuid4()
        key = objects.checkpoint_key(agent.pk, checkpoint_id)
        with transaction.atomic():
            services.lock_conversation(agent.conversation_id)
            agent = Agent.objects.select_for_update().get(pk=agent.pk)
            agent.last_command_seq += 1
            agent.save(update_fields=["last_command_seq", "updated_at"])
            command = AgentCommand.objects.create(
                agent=agent,
                agent_sequence=agent.last_command_seq,
                kind=AgentCommand.Kind.CHECKPOINT,
                input={
                    "checkpoint_id": str(checkpoint_id),
                    "upload_url": objects.upload_url(key),
                },
            )
            return AgentCheckpoint.objects.create(
                id=checkpoint_id,
                agent=agent,
                command=command,
                thread_id=agent.session.thread_id,
                state_object_key=key,
            )
