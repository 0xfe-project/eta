package chat

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// Product state kept in step with the internal records: agent status,
// messages, interactions and the ui_event stream.
//
// Locking rule: every write transaction locks the conversation row first.
// That row allocates message and event sequences, which serializes event
// commits per conversation and avoids lock-order deadlocks between the API,
// the internal API and the controller.

// LockConversation locks the conversation row for the rest of tx.
func LockConversation(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, "SELECT 1 FROM conversation WHERE id = $1 FOR UPDATE", id)
	return err
}

// DefaultConversationID is the conversation every agent is in, or "" before
// the first agent.
func DefaultConversationID(ctx context.Context, db pg.DB) (string, error) {
	var id string
	err := db.QueryRow(ctx, "SELECT id FROM conversation WHERE is_default").Scan(&id)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return id, err
}

func ensureDefaultConversation(ctx context.Context, tx pgx.Tx) (string, error) {
	id, err := DefaultConversationID(ctx, tx)
	if err != nil || id != "" {
		return id, err
	}
	// A request creating it concurrently wins; this one waits for it and
	// reads its row.
	now := pg.Now()
	if _, err := tx.Exec(ctx, `INSERT INTO conversation
		(id, is_default, title, last_event_seq, last_ui_event_seq, last_message_seq, created_at, updated_at)
		VALUES ($1, true, '', 0, 0, 0, $2, $2)
		ON CONFLICT (is_default) WHERE is_default DO NOTHING`, pg.NewID(), now); err != nil {
		return "", err
	}
	return DefaultConversationID(ctx, tx)
}

func lockedDefault(ctx context.Context, tx pgx.Tx) (string, error) {
	id, err := DefaultConversationID(ctx, tx)
	if err != nil {
		return "", err
	}
	if id == "" {
		return "", apierr.NotFound()
	}
	return id, LockConversation(ctx, tx, id)
}

// --- events (callers hold the conversation lock) ------------------------------

const (
	EventAgentUpdated       = "agent.updated"
	EventAgentDeleted       = "agent.deleted"
	EventMessageUpdated     = "message.updated"
	EventInteractionUpdated = "interaction.updated"
)

func emit(ctx context.Context, tx pgx.Tx, conversationID, kind string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	now := pg.Now()
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE conversation
		SET last_ui_event_seq = last_ui_event_seq + 1, updated_at = $2
		WHERE id = $1 RETURNING last_ui_event_seq`, conversationID, now).Scan(&seq); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO ui_event (id, conversation_id, seq, type, payload, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`, pg.NewID(), conversationID, seq, kind, data, now)
	return err
}

func emitAgent(ctx context.Context, tx pgx.Tx, a *AgentRecord) error {
	return emit(ctx, tx, a.ConversationID, EventAgentUpdated, AgentUpdated{a.public()})
}

func emitInteraction(ctx context.Context, tx pgx.Tx, i *interactionRow) error {
	return emit(ctx, tx, i.ConversationID, EventInteractionUpdated, InteractionUpdated{i.public()})
}

// saveMessage writes the message's status, blocks and failure as a new
// revision and publishes it.
func saveMessage(ctx context.Context, tx pgx.Tx, m *messageRow) error {
	m.Revision++
	m.UpdatedAt = pg.Now()
	content := m.Content
	if content == nil {
		content = []Block{}
	}
	if _, err := tx.Exec(ctx, `UPDATE message SET status = $2, content = $3, failure = $4,
		revision = $5, updated_at = $6 WHERE id = $1`,
		m.ID, m.Status, content, m.Failure, m.Revision, m.UpdatedAt); err != nil {
		return err
	}
	return emit(ctx, tx, m.ConversationID, EventMessageUpdated, MessageUpdated{m.public()})
}

// saveInteraction writes the interaction's status and answer as a new
// revision and publishes it.
func saveInteraction(ctx context.Context, tx pgx.Tx, i *interactionRow) error {
	i.Revision++
	i.UpdatedAt = pg.Now()
	if _, err := tx.Exec(ctx, `UPDATE interaction SET status = $2, answer = $3, revision = $4,
		updated_at = $5 WHERE id = $1`, i.ID, i.Status, i.Answer, i.Revision, i.UpdatedAt); err != nil {
		return err
	}
	return emitInteraction(ctx, tx, i)
}

func loadAgent(ctx context.Context, db pg.DB, id string) (*AgentRecord, error) {
	return pg.One[AgentRecord](ctx, db, "SELECT * FROM agent WHERE id = $1", id)
}

// SetAgentStatus changes the agent's internal status.
func SetAgentStatus(ctx context.Context, tx pgx.Tx, agentID, status string) error {
	_, err := tx.Exec(ctx, "UPDATE agent SET status = $2, updated_at = $3 WHERE id = $1", agentID, status, pg.Now())
	return err
}

// RefreshAgentStatus recomputes the agent's product status from internal
// state and publishes a change.
func RefreshAgentStatus(ctx context.Context, tx pgx.Tx, agentID string) error {
	agent, err := loadAgent(ctx, tx, agentID)
	if err != nil {
		return err
	}
	status := ProductIdle
	if agent.Status == AgentRecoveryFailed || agent.Status == AgentError {
		status = ProductUnavailable
	} else {
		rows, err := tx.Query(ctx, `SELECT DISTINCT status FROM message
			WHERE agent_id = $1 AND role = 'assistant' AND status = ANY($2)`, agentID, activeMessageStatuses)
		if err != nil {
			return err
		}
		active, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		if slices.Contains(active, MessageWaitingForInput) {
			status = ProductWaitingForInput
		} else if len(active) > 0 {
			status = ProductWorking
		}
	}
	if status == agent.ProductStatus {
		return nil
	}
	agent.ProductStatus = status
	agent.ProductRevision++
	if _, err := tx.Exec(ctx, `UPDATE agent SET product_status = $2, product_revision = $3, updated_at = $4
		WHERE id = $1`, agentID, status, agent.ProductRevision, pg.Now()); err != nil {
		return err
	}
	return emitAgent(ctx, tx, agent)
}

func expireOpenInteractions(ctx context.Context, tx pgx.Tx, messageID string) error {
	open, err := pg.All[interactionRow](ctx, tx, `SELECT * FROM interaction
		WHERE message_id = $1 AND status IN ('pending', 'submitted') ORDER BY created_at, id`, messageID)
	if err != nil {
		return err
	}
	for _, i := range open {
		i.Status = InteractionExpired
		if err := saveInteraction(ctx, tx, i); err != nil {
			return err
		}
	}
	return nil
}

// failures are product-facing failure reasons. Internal causes stay in the
// control plane.
var failures = map[string]string{
	"TURN_FAILED":            "智能体执行失败，请稍后再试。",
	"REPLY_INTERRUPTED":      "执行中断，无法确认结果，未自动重试。",
	"AGENT_UNAVAILABLE":      "智能体环境暂时不可用，请稍后再试。",
	"AGENT_RECOVERY_FAILED":  "智能体会话无法恢复，此消息未执行。",
	"AGENT_EXTENSION_FAILED": "智能体扩展启动失败，此消息未执行。",
	"START_TIMEOUT":          "智能体环境准备超时，此消息未执行。",
}

// Outcomes of a command.
const (
	Succeeded   = "succeeded"
	Failed      = "failed"
	Interrupted = "interrupted"
	Cancelled   = "cancelled"
)

var outcomes = map[string][2]string{
	Succeeded:   {CommandSucceeded, MessageCompleted},
	Failed:      {CommandFailed, MessageFailed},
	Interrupted: {CommandInterrupted, MessageStopped},
	Cancelled:   {CommandCancelled, MessageStopped},
}

func reply(ctx context.Context, db pg.DB, commandID string) (*messageRow, error) {
	return pg.One[messageRow](ctx, db, "SELECT * FROM message WHERE command_id = $1 AND role = 'assistant'", commandID)
}

// FinishCommand settles a command and its reply; false when it was already
// final. failureCode is for failed outcomes ("" is TURN_FAILED).
func FinishCommand(ctx context.Context, tx pgx.Tx, command *CommandRecord, outcome, failureCode string) (bool, error) {
	if command.terminal() {
		return false, nil
	}
	now := pg.Now()
	statuses := outcomes[outcome]
	command.Status = statuses[0]
	command.FinishedAt = &now
	command.ErrorCode = nil
	if failureCode != "" {
		command.ErrorCode = &failureCode
	}
	if _, err := tx.Exec(ctx, "UPDATE agent_command SET status = $2, finished_at = $3, error_code = $4 WHERE id = $1",
		command.ID, command.Status, now, command.ErrorCode); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE approval SET status = 'expired', resolved_at = $2
		WHERE command_id = $1 AND status IN ('pending', 'decided')`, command.ID, now); err != nil {
		return false, err
	}
	r, err := reply(ctx, tx, command.ID)
	if err != nil {
		return false, err
	}
	if r != nil && !r.terminal() {
		if err := expireOpenInteractions(ctx, tx, r.ID); err != nil {
			return false, err
		}
		settled := "failed"
		if outcome == Succeeded {
			settled = "completed"
		}
		for i, block := range r.Content {
			if block.Type == "activity" && block.Status == "running" {
				r.Content[i].Status = settled
			}
		}
		r.Status = statuses[1]
		if outcome == Failed {
			code := failureCode
			if code == "" {
				code = "TURN_FAILED"
			}
			r.Failure = &Failure{Code: code, Message: failures[code]}
		}
		if err := saveMessage(ctx, tx, r); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(ctx, "UPDATE agent SET status = 'ready', updated_at = $2 WHERE id = $1 AND status = 'busy'",
		command.AgentID, now); err != nil {
		return false, err
	}
	return true, RefreshAgentStatus(ctx, tx, command.AgentID)
}
