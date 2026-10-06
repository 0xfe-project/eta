"""Development stand-in for the agent runtime (RFC §9 step 1).

It consumes ``agent_command`` rows the way the real controller will: one active
execution per agent, different agents in parallel, leases with fencing, and
no automatic replay of executions whose outcome is unknown. Instead of calling
Codex it streams a canned reply. A message containing "确认" exercises the
choice interaction flow.
"""

import logging
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from django.db import IntegrityError, close_old_connections, transaction
from django.db.models import Q
from django.utils import timezone

from . import services
from .models import Agent, AgentCommand, Interaction, Message

logger = logging.getLogger(__name__)

CONFIRM_TRIGGER = "确认"
INTERRUPTED_FAILURE = {"code": "REPLY_INTERRUPTED"}


class Halt(Exception):
    """The command was stopped, or this worker lost its claim."""


class FakeRuntime:
    def __init__(
        self,
        worker_id: str | None = None,
        *,
        lease_seconds: float = 30,
        step_delay: float = 0.4,
    ):
        self.worker_id = worker_id or f"fake-{uuid.uuid4().hex[:8]}"
        self.lease = timedelta(seconds=lease_seconds)
        self.step_delay = step_delay

    # --- Scheduling ---------------------------------------------------------

    def claim(self) -> uuid.UUID | None:
        """Claim the next runnable command, or ``None``."""
        now = timezone.now()
        # Paused for input, and now answered or asked to stop.
        resumable = AgentCommand.objects.filter(
            Q(interrupt_requested_at__isnull=False)
            | Q(messages__interactions__status=Interaction.Status.SUBMITTED),
            status=AgentCommand.Status.WAITING_APPROVAL,
            claimed_by__isnull=True,
        )
        queued = AgentCommand.objects.filter(
            status=AgentCommand.Status.QUEUED, not_before__lte=now
        ).exclude(agent__commands__status__in=AgentCommand.ACTIVE_STATUSES)
        for candidates in (resumable, queued):
            for command_id, conversation_id in (
                candidates.order_by("created_at", "agent_sequence")
                .values_list("id", "agent__conversation_id")
                .distinct()[:20]
            ):
                if self._try_claim(command_id, conversation_id):
                    return command_id
        return None

    def _try_claim(self, command_id, conversation_id) -> bool:
        try:
            with transaction.atomic():
                services.lock_conversation(conversation_id)
                command = AgentCommand.objects.get(pk=command_id)
                if command.claimed_by is not None:
                    return False
                if command.status == AgentCommand.Status.QUEUED:
                    if AgentCommand.objects.filter(
                        agent_id=command.agent_id,
                        status=AgentCommand.Status.QUEUED,
                        agent_sequence__lt=command.agent_sequence,
                    ).exists():
                        return False  # Per-agent FIFO.
                    command.status = AgentCommand.Status.DISPATCHING
                    command.attempt_count += 1
                elif command.status != AgentCommand.Status.WAITING_APPROVAL:
                    return False
                command.claimed_by = self.worker_id
                command.claim_until = timezone.now() + self.lease
                # The partial unique index rejects a second active command.
                command.save(
                    update_fields=[
                        "status",
                        "attempt_count",
                        "claimed_by",
                        "claim_until",
                    ]
                )
                return True
        except IntegrityError:
            return False

    def reconcile_expired_leases(self) -> None:
        """Settle commands whose worker disappeared without replaying them."""
        expired = AgentCommand.objects.filter(
            claimed_by__isnull=False, claim_until__lt=timezone.now()
        ).values_list("id", "agent__conversation_id")
        for command_id, conversation_id in expired:
            with transaction.atomic():
                conversation = services.lock_conversation(conversation_id)
                command = AgentCommand.objects.select_related("agent").get(
                    pk=command_id
                )
                if command.claim_until is None or command.claim_until >= timezone.now():
                    continue
                if command.status == AgentCommand.Status.DISPATCHING:
                    # Never handed to the runtime: safe to queue again.
                    command.status = AgentCommand.Status.QUEUED
                elif command.status == AgentCommand.Status.RUNNING:
                    # The prompt may have run; never resubmit it.
                    self._finish(
                        conversation,
                        command,
                        stopped=command.interrupt_requested_at is not None,
                        failure=INTERRUPTED_FAILURE,
                    )
                command.claimed_by = None
                command.claim_until = None
                command.save(update_fields=["status", "claimed_by", "claim_until"])

    def run_forever(self, concurrency: int = 4, poll_interval: float = 0.5) -> None:
        logger.info("Fake runtime %s started", self.worker_id)
        running: set = set()
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            while True:
                running = {future for future in running if not future.done()}
                self.reconcile_expired_leases()
                while len(running) < concurrency:
                    command_id = self.claim()
                    if command_id is None:
                        break
                    running.add(pool.submit(self._execute_in_thread, command_id))
                close_old_connections()
                time.sleep(poll_interval)

    def _execute_in_thread(self, command_id) -> None:
        try:
            self.execute(command_id)
        except Exception:
            logger.exception("Fake runtime failed on command %s", command_id)
        finally:
            close_old_connections()

    # --- Execution ----------------------------------------------------------

    def execute(self, command_id) -> None:
        """Advance a claimed command until it finishes or waits for input."""
        try:
            state = self._write(command_id, self._start)
            if state == "wait":
                return
            text = state
            chunks = [text[i : i + 12] for i in range(0, len(text), 12)]
            shown = ""
            for chunk in chunks:
                self._sleep()
                shown += chunk
                self._write(command_id, self._stream(shown))
            self._sleep()
            self._write(command_id, self._complete)
        except Halt:
            return

    def _sleep(self) -> None:
        if self.step_delay:
            time.sleep(self.step_delay)

    def _write(self, command_id, step: Callable):
        """Run one step under the conversation lock, enforcing stop and fencing."""
        conversation_id = (
            AgentCommand.objects.filter(pk=command_id)
            .values_list("agent__conversation_id", flat=True)
            .get()
        )
        with transaction.atomic():
            conversation = services.lock_conversation(conversation_id)
            command = AgentCommand.objects.select_related("agent").get(pk=command_id)
            if command.claimed_by != self.worker_id:
                raise Halt
            if command.interrupt_requested_at is not None:
                self._finish(conversation, command, stopped=True)
                self._release(command)
            else:
                command.claim_until = timezone.now() + self.lease
                command.save(update_fields=["claim_until"])
                reply = command.messages.get(role=Message.Role.ASSISTANT)
                return step(conversation, command, reply)
        # Raised after commit so the stopped state is persisted.
        raise Halt

    def _start(self, conversation, command, reply):
        text = command.input.get("text", "")
        agent = command.agent

        if command.status == AgentCommand.Status.DISPATCHING:
            command.status = AgentCommand.Status.RUNNING
            command.started_at = timezone.now()
            command.save(update_fields=["status", "started_at"])
            if agent.status != Agent.Status.BUSY:
                agent.status = Agent.Status.BUSY
                agent.save(update_fields=["status", "updated_at"])
            services.save_message(
                conversation,
                reply,
                status=Message.Status.RESPONDING,
                content=[self._activity(reply, "理解请求", "running")],
            )
            if CONFIRM_TRIGGER in text:
                return self._ask(conversation, command, reply)
            services.refresh_agent_status(conversation, agent)
            return self._reply_text(text)

        interaction = reply.interactions.filter(
            status=Interaction.Status.SUBMITTED
        ).first()
        if interaction is None:
            # Claimed while still waiting for an answer; nothing to do yet.
            self._release(command)
            return "wait"
        command.status = AgentCommand.Status.RUNNING
        command.save(update_fields=["status"])
        services.save_interaction(
            conversation, interaction, status=Interaction.Status.RESOLVED
        )
        services.save_message(conversation, reply, status=Message.Status.RESPONDING)
        services.refresh_agent_status(conversation, agent)
        if interaction.answer.get("value") != "allow":
            return "已取消该操作。"
        return self._reply_text(text)

    @staticmethod
    def _reply_text(text: str) -> str:
        return f"这是开发用模拟运行时的回复。已收到：「{text}」"

    def _ask(self, conversation, command, reply):
        interaction = Interaction.objects.create(
            conversation=conversation,
            agent=command.agent,
            message=reply,
            prompt="允许执行示例操作？",
            options=[
                {"value": "allow", "label": "允许"},
                {"value": "deny", "label": "拒绝"},
            ],
        )
        services.emit_interaction(conversation, interaction)
        command.status = AgentCommand.Status.WAITING_APPROVAL
        command.save(update_fields=["status"])
        services.save_message(
            conversation, reply, status=Message.Status.WAITING_FOR_INPUT
        )
        services.refresh_agent_status(conversation, command.agent)
        # Free the worker while a human decides; claim() resumes it.
        self._release(command)
        return "wait"

    def _stream(self, shown: str):
        def step(conversation, command, reply):
            blocks = [
                self._activity(reply, "理解请求", "completed"),
                {"id": f"text-{reply.id.hex[:12]}", "type": "text", "text": shown},
            ]
            services.save_message(conversation, reply, content=blocks)

        return step

    def _complete(self, conversation, command, reply):
        self._finish(conversation, command, stopped=False)
        self._release(command)

    def _finish(self, conversation, command, *, stopped: bool, failure=None) -> None:
        if stopped:
            services.finish_command(conversation, command, "interrupted")
        elif failure:
            services.finish_command(conversation, command, "failed", failure["code"])
        else:
            services.finish_command(conversation, command, "succeeded")

    def _release(self, command) -> None:
        command.claimed_by = None
        command.claim_until = None
        command.save(update_fields=["claimed_by", "claim_until"])

    @staticmethod
    def _activity(reply, label: str, status: str) -> dict:
        # Stable ids so clients update the same block across revisions.
        block_id = f"activity-{reply.id.hex[:12]}"
        return {"id": block_id, "type": "activity", "label": label, "status": status}
