package chat

import (
	"context"
	"errors"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Records are rows as they are stored; they never reach the browser.

const (
	AgentStopped        = "stopped"
	AgentProvisioning   = "provisioning"
	AgentRecovering     = "recovering"
	AgentReady          = "ready"
	AgentBusy           = "busy"
	AgentRecoveryFailed = "recovery_failed"
	AgentError          = "error"

	DesiredStopped = "stopped"
	DesiredRunning = "running"

	ProductIdle            = "idle"
	ProductWorking         = "working"
	ProductWaitingForInput = "waiting_for_input"
	ProductUnavailable     = "unavailable"
)

type AgentRecord struct {
	ID             string   `db:"id"`
	ConversationID string   `db:"conversation_id"`
	Name           string   `db:"name"`
	Description    string   `db:"description"`
	Model          *string  `db:"model"`
	Plugins        []string `db:"plugins"`
	DesiredState   string   `db:"desired_state"`
	Status         string   `db:"status"`
	// Incremented for every runtime instance; fences stale runtimes.
	Generation int64 `db:"generation"`
	// Bumped when anything a runtime is started with changes (name, model,
	// instructions, plugins). Runtimes pick it up the next time they start.
	ConfigVersion   int64      `db:"config_version"`
	LastActiveAt    *time.Time `db:"last_active_at"`
	DeletedAt       *time.Time `db:"deleted_at"`
	ProductStatus   string     `db:"product_status"`
	ProductRevision int64      `db:"product_revision"`
	LastCommandSeq  int64      `db:"last_command_seq"`
	LastErrorCode   *string    `db:"last_error_code"`
	CreatedAt       time.Time  `db:"created_at"`
	UpdatedAt       time.Time  `db:"updated_at"`
}

const (
	KindTurn = "turn"
	// KindCompact compacts the thread's context; a turn without user input.
	KindCompact = "compact"

	CommandQueued          = "queued"
	CommandRunning         = "running"
	CommandWaitingApproval = "waiting_approval"
	CommandSucceeded       = "succeeded"
	CommandFailed          = "failed"
	CommandCancelled       = "cancelled"
	CommandInterrupted     = "interrupted"
)

// ActiveCommandStatuses hold the agent's single execution slot.
var ActiveCommandStatuses = []string{CommandRunning, CommandWaitingApproval}

var terminalCommandStatuses = []string{CommandSucceeded, CommandFailed, CommandCancelled, CommandInterrupted}

type CommandRecord struct {
	ID            string         `db:"id"`
	AgentID       string         `db:"agent_id"`
	AgentSequence int64          `db:"agent_sequence"`
	Kind          string         `db:"kind"`
	Status        string         `db:"status"`
	Input         map[string]any `db:"input"`
	CodexTurnID   *string        `db:"codex_turn_id"`
	RuntimeID     *string        `db:"runtime_instance_id"`
	// Its message in the agent queue, to take it back. Nil for a steer the
	// running turn took instead.
	QueueSeq             *int64     `db:"queue_seq"`
	InterruptRequestedAt *time.Time `db:"interrupt_requested_at"`
	CreatedAt            time.Time  `db:"created_at"`
	StartedAt            *time.Time `db:"started_at"`
	FinishedAt           *time.Time `db:"finished_at"`
	ErrorCode            *string    `db:"error_code"`
}

func (c *CommandRecord) terminal() bool {
	for _, s := range terminalCommandStatuses {
		if c.Status == s {
			return true
		}
	}
	return false
}

const (
	RoleUser      = "user"
	RoleAssistant = "assistant"

	MessageQueued          = "queued"
	MessageResponding      = "responding"
	MessageWaitingForInput = "waiting_for_input"
	MessageStopping        = "stopping"
	MessageCompleted       = "completed"
	MessageStopped         = "stopped"
	MessageFailed          = "failed"
)

var activeMessageStatuses = []string{MessageQueued, MessageResponding, MessageWaitingForInput, MessageStopping}

type messageRow struct {
	ID             string    `db:"id"`
	ConversationID string    `db:"conversation_id"`
	AgentID        string    `db:"agent_id"`
	CommandID      string    `db:"command_id"`
	ReplyToID      *string   `db:"reply_to_id"`
	Seq            int64     `db:"seq"`
	Role           string    `db:"role"`
	Content        []Block   `db:"content"`
	Status         string    `db:"status"`
	Failure        *Failure  `db:"failure"`
	Revision       int64     `db:"revision"`
	CreatedAt      time.Time `db:"created_at"`
	UpdatedAt      time.Time `db:"updated_at"`
}

func (m *messageRow) terminal() bool {
	return m.Status == MessageCompleted || m.Status == MessageStopped || m.Status == MessageFailed
}

const (
	InteractionPending   = "pending"
	InteractionSubmitted = "submitted"
	InteractionResolved  = "resolved"
	InteractionExpired   = "expired"
)

type answer struct {
	Value string `json:"value"`
}

type interactionRow struct {
	ID             string              `db:"id"`
	ConversationID string              `db:"conversation_id"`
	AgentID        string              `db:"agent_id"`
	MessageID      string              `db:"message_id"`
	ApprovalID     *string             `db:"approval_id"`
	Kind           string              `db:"kind"`
	Prompt         string              `db:"prompt"`
	Options        []InteractionOption `db:"options"`
	Status         string              `db:"status"`
	Revision       int64               `db:"revision"`
	Answer         *answer             `db:"answer"`
	ExpiresAt      *time.Time          `db:"expires_at"`
	CreatedAt      time.Time           `db:"created_at"`
	UpdatedAt      time.Time           `db:"updated_at"`
}

const (
	ApprovalPending = "pending"
	ApprovalDecided = "decided"
)

type approvalRow struct {
	ID         string `db:"id"`
	AgentID    string `db:"agent_id"`
	CommandID  string `db:"command_id"`
	RuntimeID  string `db:"runtime_instance_id"`
	Generation int64  `db:"generation"`
	// The runtime's id for the SDK request; meaningless to another generation.
	SDKRequestID string         `db:"sdk_request_id"`
	Kind         string         `db:"kind"`
	Summary      map[string]any `db:"summary"`
	Status       string         `db:"status"`
	Decision     *string        `db:"decision"`
	ExpiresAt    *time.Time     `db:"expires_at"`
	CreatedAt    time.Time      `db:"created_at"`
	ResolvedAt   *time.Time     `db:"resolved_at"`
}

// SessionRecord is the agent's single persistent Codex thread.
type SessionRecord struct {
	AgentID        string     `db:"agent_id"`
	ThreadID       *string    `db:"thread_id"`
	Status         string     `db:"status"`
	SDKVersion     string     `db:"sdk_version"`
	RuntimeVersion string     `db:"runtime_version"`
	LastTurnID     *string    `db:"last_turn_id"`
	LastResumeAt   *time.Time `db:"last_resume_at"`
	LastError      *string    `db:"last_error"`
}

const (
	RuntimeProvisioning = "provisioning"
	RuntimeRecovering   = "recovering"
	RuntimeReady        = "ready"
	RuntimeBusy         = "busy"
	RuntimeStopped      = "stopped"
	RuntimeFailed       = "failed"
)

// RuntimeRecord is one runtime instance (container) of an agent.
type RuntimeRecord struct {
	ID              string     `db:"id"`
	AgentID         string     `db:"agent_id"`
	Generation      int64      `db:"generation"`
	ContainerID     *string    `db:"container_id"`
	HostID          string     `db:"host_id"`
	ImageDigest     string     `db:"image_digest"`
	Status          string     `db:"status"`
	ErrorCode       *string    `db:"error_code"`
	ControllerID    string     `db:"controller_id"`
	LeaseExpiresAt  time.Time  `db:"lease_expires_at"`
	LastHeartbeatAt *time.Time `db:"last_heartbeat_at"`
	// Immutable configuration this instance was started with.
	ConfigVersion int64      `db:"config_version"`
	LastSourceSeq int64      `db:"last_source_seq"`
	EndReason     *string    `db:"end_reason"`
	EndedAt       *time.Time `db:"ended_at"`
	CreatedAt     time.Time  `db:"created_at"`
}

// --- queries ----------------------------------------------------------------

// One is the row sql selects, or nil.
func One[T any](ctx context.Context, db store.DB, sql string, args ...any) (*T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	row, err := pgx.CollectOneRow(rows, pgx.RowToAddrOfStructByName[T])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

// All is the rows sql selects.
func All[T any](ctx context.Context, db store.DB, sql string, args ...any) ([]*T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToAddrOfStructByName[T])
}

// Exists reports whether sql selects a row.
func Exists(ctx context.Context, db store.DB, sql string, args ...any) (bool, error) {
	var exists bool
	err := db.QueryRow(ctx, "SELECT EXISTS ("+sql+")", args...).Scan(&exists)
	return exists, err
}

// ParseID is id as a canonical UUID, or false.
func ParseID(id string) (string, bool) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", false
	}
	return parsed.String(), true
}

func NewID() string { return uuid.NewString() }

// Now is the current time, at the database's precision.
func Now() time.Time { return time.Now().UTC().Truncate(time.Microsecond) }
