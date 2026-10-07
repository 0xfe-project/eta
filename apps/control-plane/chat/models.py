"""Internal persistence for the chat control plane.

These tables are never serialized directly to the browser. Public payloads are
built by ``chat.schemas`` from an explicit field allowlist.
"""

import uuid

from django.db import models
from django.db.models import Q
from django.utils import timezone


def _choices_check(field: str, choices: type[models.TextChoices], name: str):
    return models.CheckConstraint(
        condition=Q(**{f"{field}__in": choices.values}), name=name
    )


class Conversation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # The service has one default conversation holding every agent.
    is_default = models.BooleanField(default=False)
    title = models.CharField(max_length=200, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    last_event_seq = models.BigIntegerField(default=0)
    last_ui_event_seq = models.BigIntegerField(default=0)
    last_message_seq = models.BigIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "conversation"
        constraints = [
            models.UniqueConstraint(
                fields=["is_default"],
                condition=Q(is_default=True),
                name="one_default_conversation",
            ),
            models.CheckConstraint(
                condition=Q(
                    last_event_seq__gte=0,
                    last_ui_event_seq__gte=0,
                    last_message_seq__gte=0,
                ),
                name="conversation_seq_nonnegative",
            ),
        ]


class AgentStatus(models.TextChoices):
    STOPPED = "stopped"
    PROVISIONING = "provisioning"
    RECOVERING = "recovering"
    READY = "ready"
    BUSY = "busy"
    STOPPING = "stopping"
    RECOVERY_FAILED = "recovery_failed"
    ERROR = "error"


class AgentDesiredState(models.TextChoices):
    STOPPED = "stopped"
    RUNNING = "running"


class AgentProductStatus(models.TextChoices):
    IDLE = "idle"
    WORKING = "working"
    WAITING_FOR_INPUT = "waiting_for_input"
    UNAVAILABLE = "unavailable"


class Agent(models.Model):
    Status = AgentStatus
    DesiredState = AgentDesiredState
    ProductStatus = AgentProductStatus

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.PROTECT, related_name="agents"
    )
    name = models.CharField(max_length=100)
    # User-authored instructions injected into the agent's context.
    description = models.TextField(blank=True, default="")
    # Server-controlled; never accepted from the web.
    model = models.CharField(max_length=100, null=True, blank=True)
    desired_state = models.CharField(
        max_length=16, choices=DesiredState.choices, default=DesiredState.STOPPED
    )
    status = models.CharField(
        max_length=32, choices=Status.choices, default=Status.STOPPED
    )
    # Incremented for every runtime instance; fences stale runtimes.
    generation = models.BigIntegerField(default=0)
    # Bumped when anything a runtime is started with changes (name,
    # instructions, MCP bindings). Runtimes pick it up the next time they start.
    config_version = models.BigIntegerField(default=0)
    last_active_at = models.DateTimeField(null=True, blank=True)
    # Deleted agents keep their history but are hidden and never run again.
    deleted_at = models.DateTimeField(null=True, blank=True)
    product_status = models.CharField(
        max_length=32, choices=ProductStatus.choices, default=ProductStatus.IDLE
    )
    product_revision = models.BigIntegerField(default=1)
    last_command_seq = models.BigIntegerField(default=0)
    last_error_code = models.CharField(max_length=64, null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent"
        indexes = [
            models.Index(
                fields=["conversation", "created_at", "id"],
                name="agent_conversation_idx",
            )
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["id", "conversation"], name="agent_id_conversation_uniq"
            ),
            _choices_check("status", AgentStatus, "agent_status_valid"),
            _choices_check(
                "desired_state", AgentDesiredState, "agent_desired_state_valid"
            ),
            _choices_check(
                "product_status", AgentProductStatus, "agent_product_status_valid"
            ),
            models.CheckConstraint(
                condition=Q(
                    product_revision__gte=1,
                    last_command_seq__gte=0,
                    generation__gte=0,
                    config_version__gte=0,
                ),
                name="agent_counters_valid",
            ),
        ]


class AgentCommandKind(models.TextChoices):
    TURN = "turn"
    # Compacts the thread's context; a turn without user input.
    COMPACT = "compact"


class AgentCommandStatus(models.TextChoices):
    QUEUED = "queued"
    DISPATCHING = "dispatching"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


class AgentCommand(models.Model):
    Kind = AgentCommandKind
    Status = AgentCommandStatus

    # Statuses that hold the per-agent execution slot.
    ACTIVE_STATUSES = (
        Status.DISPATCHING,
        Status.RUNNING,
        Status.WAITING_APPROVAL,
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    agent = models.ForeignKey(Agent, on_delete=models.PROTECT, related_name="commands")
    agent_sequence = models.BigIntegerField()
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.TURN)
    status = models.CharField(
        max_length=32, choices=Status.choices, default=Status.QUEUED
    )
    input = models.JSONField(default=dict)
    codex_turn_id = models.CharField(max_length=100, null=True, blank=True)
    runtime_instance = models.ForeignKey(
        "RuntimeInstance",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="commands",
    )
    dispatch_generation = models.BigIntegerField(null=True, blank=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)
    interrupt_requested_at = models.DateTimeField(null=True, blank=True)
    interrupt_sent_at = models.DateTimeField(null=True, blank=True)
    attempt_count = models.IntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=64, null=True, blank=True)

    class Meta:
        db_table = "agent_command"
        indexes = [
            models.Index(
                fields=["status", "created_at"],
                name="agent_command_queue_idx",
            )
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["agent", "agent_sequence"], name="agent_command_sequence_uniq"
            ),
            # Target of the composite foreign key from message.
            models.UniqueConstraint(
                fields=["id", "agent"], name="agent_command_id_agent_uniq"
            ),
            models.UniqueConstraint(
                fields=["agent"],
                condition=Q(status__in=["dispatching", "running", "waiting_approval"]),
                name="one_active_execution_per_agent",
            ),
            _choices_check("kind", AgentCommandKind, "agent_command_kind_valid"),
            _choices_check("status", AgentCommandStatus, "agent_command_status_valid"),
            models.CheckConstraint(
                condition=Q(agent_sequence__gte=1, attempt_count__gte=0),
                name="agent_command_counters_valid",
            ),
        ]


class MessageRole(models.TextChoices):
    USER = "user"
    ASSISTANT = "assistant"


class MessageStatus(models.TextChoices):
    QUEUED = "queued"
    RESPONDING = "responding"
    WAITING_FOR_INPUT = "waiting_for_input"
    STOPPING = "stopping"
    COMPLETED = "completed"
    STOPPED = "stopped"
    FAILED = "failed"


class Message(models.Model):
    Role = MessageRole
    Status = MessageStatus

    ACTIVE_STATUSES = (
        Status.QUEUED,
        Status.RESPONDING,
        Status.WAITING_FOR_INPUT,
        Status.STOPPING,
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.PROTECT, related_name="messages"
    )
    agent = models.ForeignKey(Agent, on_delete=models.PROTECT, related_name="+")
    command = models.ForeignKey(
        AgentCommand, on_delete=models.PROTECT, related_name="messages"
    )
    reply_to = models.ForeignKey(
        "self", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    seq = models.BigIntegerField()
    role = models.CharField(max_length=16, choices=Role.choices)
    # Product display blocks; see chat.schemas.Block.
    content = models.JSONField(default=list)
    status = models.CharField(max_length=32, choices=Status.choices)
    failure = models.JSONField(null=True, blank=True)
    revision = models.BigIntegerField(default=1)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "message"
        indexes = [
            models.Index(
                fields=["conversation", "role", "status"],
                name="message_active_idx",
            )
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "seq"], name="message_conversation_seq_uniq"
            ),
            models.UniqueConstraint(
                fields=["command", "role"], name="message_one_per_role_per_command"
            ),
            # Target of the composite foreign key from reply_to.
            models.UniqueConstraint(
                fields=["id", "agent", "command"], name="message_id_agent_command_uniq"
            ),
            _choices_check("role", MessageRole, "message_role_valid"),
            _choices_check("status", MessageStatus, "message_status_valid"),
            models.CheckConstraint(
                condition=(
                    Q(role="user", status="completed", reply_to__isnull=True)
                    | Q(role="assistant", reply_to__isnull=False)
                ),
                name="message_role_shape_valid",
            ),
            models.CheckConstraint(
                condition=Q(seq__gte=1, revision__gte=1),
                name="message_counters_valid",
            ),
        ]


class InteractionKind(models.TextChoices):
    CHOICE = "choice"


class InteractionStatus(models.TextChoices):
    PENDING = "pending"
    SUBMITTED = "submitted"
    RESOLVED = "resolved"
    EXPIRED = "expired"


class Interaction(models.Model):
    Kind = InteractionKind
    Status = InteractionStatus

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.PROTECT, related_name="+"
    )
    agent = models.ForeignKey(Agent, on_delete=models.PROTECT, related_name="+")
    message = models.ForeignKey(
        Message, on_delete=models.PROTECT, related_name="interactions"
    )
    # Set when the interaction projects a runtime approval.
    approval = models.OneToOneField(
        "Approval",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="interaction",
    )
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.CHOICE)
    prompt = models.CharField(max_length=500)
    # [{"value": str, "label": str}]
    options = models.JSONField(default=list)
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.PENDING
    )
    revision = models.BigIntegerField(default=1)
    answer = models.JSONField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "interaction"
        indexes = [
            models.Index(fields=["conversation", "status"], name="interaction_open_idx")
        ]
        constraints = [
            _choices_check("kind", InteractionKind, "interaction_kind_valid"),
            _choices_check("status", InteractionStatus, "interaction_status_valid"),
            models.CheckConstraint(
                condition=Q(revision__gte=1), name="interaction_revision_valid"
            ),
        ]


class UiEventType(models.TextChoices):
    AGENT_UPDATED = "agent.updated"
    AGENT_DELETED = "agent.deleted"
    MESSAGE_UPDATED = "message.updated"
    INTERACTION_UPDATED = "interaction.updated"


class UiEvent(models.Model):
    Type = UiEventType

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.PROTECT, related_name="+"
    )
    seq = models.BigIntegerField()
    type = models.CharField(max_length=32, choices=Type.choices)
    # Already-projected public payload; never raw runtime data.
    payload = models.JSONField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "ui_event"
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "seq"], name="ui_event_conversation_seq_uniq"
            ),
            _choices_check("type", UiEventType, "ui_event_type_valid"),
        ]


class ApiIdempotency(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    method = models.CharField(max_length=10)
    canonical_path = models.CharField(max_length=500)
    key = models.CharField(max_length=255)
    request_hash = models.CharField(max_length=64)
    response_status = models.IntegerField()
    response_body = models.JSONField()
    resource_id = models.CharField(max_length=64, null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "api_idempotency"
        constraints = [
            models.UniqueConstraint(
                fields=["method", "canonical_path", "key"],
                name="api_idempotency_key_uniq",
            )
        ]


# --- Runtime internals (RFC §5) ---------------------------------------------


class SessionStatus(models.TextChoices):
    NEW = "new"
    RECOVERING = "recovering"
    READY = "ready"
    RECOVERY_FAILED = "recovery_failed"


class AgentSession(models.Model):
    """The agent's single persistent Codex thread."""

    Status = SessionStatus

    agent = models.OneToOneField(
        Agent, primary_key=True, on_delete=models.CASCADE, related_name="session"
    )
    thread_id = models.CharField(max_length=100, null=True, blank=True, unique=True)
    status = models.CharField(
        max_length=32, choices=SessionStatus.choices, default=SessionStatus.NEW
    )
    sdk_version = models.CharField(max_length=50, blank=True)
    runtime_version = models.CharField(max_length=100, blank=True)
    last_turn_id = models.CharField(max_length=100, null=True, blank=True)
    last_resume_at = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=100, null=True, blank=True)

    class Meta:
        db_table = "agent_session"
        constraints = [
            _choices_check("status", SessionStatus, "agent_session_status_valid")
        ]


class RuntimeStatus(models.TextChoices):
    PROVISIONING = "provisioning"
    RECOVERING = "recovering"
    READY = "ready"
    BUSY = "busy"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


class RuntimeInstance(models.Model):
    Status = RuntimeStatus

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    agent = models.ForeignKey(Agent, on_delete=models.PROTECT, related_name="runtimes")
    generation = models.BigIntegerField()
    container_id = models.CharField(max_length=100, null=True, blank=True, unique=True)
    host_id = models.CharField(max_length=100)
    image_digest = models.CharField(max_length=200, blank=True)
    # Internal address of the runtime's control endpoint.
    endpoint = models.CharField(max_length=200, blank=True)
    status = models.CharField(
        max_length=16, choices=RuntimeStatus.choices, default=RuntimeStatus.PROVISIONING
    )
    error_code = models.CharField(max_length=64, null=True, blank=True)
    controller_id = models.CharField(max_length=100)
    lease_expires_at = models.DateTimeField()
    last_heartbeat_at = models.DateTimeField(null=True, blank=True)
    # Immutable configuration this instance was started with.
    config_version = models.BigIntegerField(default=0)
    mcp_snapshot = models.JSONField(default=list)
    mcp_status = models.JSONField(default=dict)
    last_source_seq = models.BigIntegerField(default=0)
    end_reason = models.CharField(max_length=64, null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "runtime_instance"
        constraints = [
            models.UniqueConstraint(
                fields=["agent", "generation"], name="runtime_agent_generation_uniq"
            ),
            models.UniqueConstraint(
                fields=["agent"],
                condition=Q(ended_at__isnull=True),
                name="one_live_runtime_per_agent",
            ),
            models.UniqueConstraint(
                fields=["id", "agent"], name="runtime_id_agent_uniq"
            ),
            _choices_check("status", RuntimeStatus, "runtime_status_valid"),
            models.CheckConstraint(
                condition=Q(generation__gte=1, last_source_seq__gte=0),
                name="runtime_counters_valid",
            ),
        ]


class AgentEvent(models.Model):
    """Internal event log imported from runtime outboxes."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.PROTECT, related_name="+"
    )
    agent = models.ForeignKey(Agent, on_delete=models.PROTECT, related_name="+")
    command = models.ForeignKey(
        AgentCommand, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    runtime_instance = models.ForeignKey(
        RuntimeInstance,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="events",
    )
    source_event_id = models.CharField(max_length=100, null=True, blank=True)
    source_seq = models.BigIntegerField(null=True, blank=True)
    seq = models.BigIntegerField()
    type = models.CharField(max_length=64)
    schema_version = models.IntegerField(default=1)
    payload = models.JSONField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "agent_event"
        indexes = [models.Index(fields=["agent", "seq"], name="agent_event_agent_idx")]
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "seq"], name="agent_event_conversation_seq_uniq"
            ),
            models.UniqueConstraint(
                fields=["runtime_instance", "source_event_id"],
                condition=Q(source_event_id__isnull=False),
                name="agent_event_source_id_uniq",
            ),
            models.UniqueConstraint(
                fields=["runtime_instance", "source_seq"],
                condition=Q(source_seq__isnull=False),
                name="agent_event_source_seq_uniq",
            ),
        ]


class ApprovalStatus(models.TextChoices):
    PENDING = "pending"
    DECIDED = "decided"
    APPLIED = "applied"
    EXPIRED = "expired"


class Approval(models.Model):
    Status = ApprovalStatus

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    agent = models.ForeignKey(Agent, on_delete=models.PROTECT, related_name="+")
    command = models.ForeignKey(
        AgentCommand, on_delete=models.PROTECT, related_name="approvals"
    )
    runtime_instance = models.ForeignKey(
        RuntimeInstance, on_delete=models.PROTECT, related_name="approvals"
    )
    generation = models.BigIntegerField()
    # The runtime's id for the SDK request; meaningless to another generation.
    sdk_request_id = models.CharField(max_length=100)
    kind = models.CharField(max_length=32)
    summary = models.JSONField(default=dict)
    status = models.CharField(
        max_length=32, choices=ApprovalStatus.choices, default=ApprovalStatus.PENDING
    )
    decision = models.CharField(max_length=16, null=True, blank=True)
    delivery_attempted_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "approval"
        indexes = [
            models.Index(fields=["agent", "status"], name="approval_agent_status_idx")
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["runtime_instance", "sdk_request_id"],
                name="approval_sdk_request_uniq",
            ),
            models.UniqueConstraint(
                fields=["id", "agent"], name="approval_id_agent_uniq"
            ),
            _choices_check("status", ApprovalStatus, "approval_status_valid"),
        ]


class McpModuleRevision(models.Model):
    """Immutable, deployment-registered MCP module definition."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    module_key = models.SlugField(max_length=64)
    revision = models.CharField(max_length=32)
    transport = models.CharField(max_length=16, default="stdio")
    # Only writable by trusted deployment tooling, never by API callers.
    launch_spec = models.JSONField()
    config_schema = models.JSONField(default=dict)
    enabled = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "mcp_module_revision"
        constraints = [
            models.UniqueConstraint(
                fields=["module_key", "revision"], name="mcp_module_revision_uniq"
            ),
            models.UniqueConstraint(
                fields=["id", "module_key"], name="mcp_module_id_key_uniq"
            ),
            models.CheckConstraint(
                condition=Q(transport__in=["stdio"]), name="mcp_module_transport_valid"
            ),
        ]


class AgentMcpBinding(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    agent = models.ForeignKey(
        Agent, on_delete=models.CASCADE, related_name="mcp_bindings"
    )
    module_revision = models.ForeignKey(
        McpModuleRevision, on_delete=models.PROTECT, related_name="bindings"
    )
    # Denormalized for the per-agent uniqueness constraint.
    module_key = models.SlugField(max_length=64)
    enabled = models.BooleanField(default=True)
    required = models.BooleanField(default=False)
    allowed_tools = models.JSONField(default=list)
    config = models.JSONField(default=dict)
    # e.g. "env:TASKS_API_TOKEN"; secret values are never stored here.
    secret_ref = models.CharField(max_length=200, null=True, blank=True)

    class Meta:
        db_table = "agent_mcp_binding"
        constraints = [
            models.UniqueConstraint(
                fields=["agent", "module_key"], name="agent_mcp_binding_key_uniq"
            )
        ]
