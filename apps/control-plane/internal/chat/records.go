package chat

import (
	"time"
)

// Records are rows as they are stored; they never reach the browser.

const (
	// The agent's runtime: starting until the current container's runtime
	// reports itself started; error when it cannot run.
	AgentStarting = "starting"
	AgentReady    = "ready"
	AgentError    = "error"

	ProductIdle            = "idle"
	ProductStarting        = "starting"
	ProductWorking         = "working"
	ProductWaitingForInput = "waiting_for_input"
	ProductUnavailable     = "unavailable"
)

type AgentRecord struct {
	ID             string  `db:"id"`
	ConversationID string  `db:"conversation_id"`
	Name           string  `db:"name"`
	Description    string  `db:"description"`
	Model          *string `db:"model"`
	// The bundles it loads, in catalog order, and the plugins they add.
	Bundles []string `db:"bundles"`
	Plugins []string `db:"plugins"`
	Status  string   `db:"status"`
	// The runtime boot that reported itself last (runtime.started).
	BootID *string `db:"boot_id"`
	// Bumped when anything a runtime is started with changes (name, model,
	// instructions, bundles) and on restart: the controller replaces the
	// container once the agent is between turns.
	ConfigVersion   int64      `db:"config_version"`
	LastActiveAt    *time.Time `db:"last_active_at"`
	DeletedAt       *time.Time `db:"deleted_at"`
	ProductStatus   string     `db:"product_status"`
	ProductRevision int64      `db:"product_revision"`
	LastCommandSeq  int64      `db:"last_command_seq"`
	LastErrorCode   *string    `db:"last_error_code"`
	// The end of a failed image build's output.
	BuildError *string   `db:"build_error"`
	CreatedAt  time.Time `db:"created_at"`
	UpdatedAt  time.Time `db:"updated_at"`
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

// CommandRecord is a turn asked of the agent. A queued one waits here until
// the controller delivers it to the agent's runtime: as a prompt (it then
// runs) or as a steer the running turn took (it stays queued until the turn
// hands over to it).
type CommandRecord struct {
	ID            string         `db:"id"`
	AgentID       string         `db:"agent_id"`
	AgentSequence int64          `db:"agent_sequence"`
	Kind          string         `db:"kind"`
	Status        string         `db:"status"`
	Input         map[string]any `db:"input"`
	CodexTurnID   *string        `db:"codex_turn_id"`
	// When the controller handed it to the runtime boot BootID.
	DeliveredAt          *time.Time `db:"delivered_at"`
	BootID               *string    `db:"boot_id"`
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

// Steer reports whether the command asks to join the running turn.
func (c *CommandRecord) Steer() bool { return c.Input["steer"] == true }

// Text is the command's input.
func (c *CommandRecord) Text() string {
	text, _ := c.Input["text"].(string)
	return text
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
	ApprovalApplied = "applied"
	ApprovalExpired = "expired"
)

// ApprovalRecord is a request a runtime boot made for the user's decision.
type ApprovalRecord struct {
	ID        string `db:"id"`
	AgentID   string `db:"agent_id"`
	CommandID string `db:"command_id"`
	// The boot that asked; its id for the request is SDKRequestID.
	BootID       *string        `db:"boot_id"`
	SDKRequestID string         `db:"sdk_request_id"`
	Kind         string         `db:"kind"`
	Summary      map[string]any `db:"summary"`
	Status       string         `db:"status"`
	Decision     *string        `db:"decision"`
	ExpiresAt    *time.Time     `db:"expires_at"`
	CreatedAt    time.Time      `db:"created_at"`
	ResolvedAt   *time.Time     `db:"resolved_at"`
}
