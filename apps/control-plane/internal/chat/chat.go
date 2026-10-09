// Package chat turns product intents (create an agent, send, stop, answer)
// into internal records, and runtime events into product state: agent status,
// messages, interactions and the ui_event stream the browser follows.
package chat

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/apps/control-plane/internal/queue"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

const (
	HistoryPageSize    = 50
	MaxHistoryPageSize = 100
)

type Service struct {
	Queue   queue.Queue
	Models  llm.Catalog
	Plugins *plugins.Catalog
	Cursors Cursors
}

// --- reads --------------------------------------------------------------------

func (s *Service) Snapshot(ctx context.Context, db pg.DB) (*Snapshot, error) {
	snapshot := &Snapshot{Agents: []Agent{}, ActiveReplies: []Message{}, Interactions: []Interaction{}}
	conversationID, err := DefaultConversationID(ctx, db)
	if err != nil {
		return nil, err
	}
	if conversationID == "" {
		snapshot.EventCursor = s.Cursors.Event(0)
		return snapshot, nil
	}
	// The cursor before the objects: anything committed in between is
	// replayed over the stream and dropped by revision in the browser.
	var seq int64
	if err := db.QueryRow(ctx, "SELECT last_ui_event_seq FROM conversation WHERE id = $1", conversationID).Scan(&seq); err != nil {
		return nil, err
	}
	agents, err := pg.All[AgentRecord](ctx, db, `SELECT * FROM agent
		WHERE conversation_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, conversationID)
	if err != nil {
		return nil, err
	}
	for _, a := range agents {
		snapshot.Agents = append(snapshot.Agents, a.public())
	}
	active, err := pg.All[messageRow](ctx, db, `SELECT * FROM message
		WHERE conversation_id = $1 AND role = 'assistant' AND status = ANY($2) ORDER BY seq`,
		conversationID, activeMessageStatuses)
	if err != nil {
		return nil, err
	}
	for _, m := range active {
		snapshot.ActiveReplies = append(snapshot.ActiveReplies, m.public())
	}
	interactions, err := pg.All[interactionRow](ctx, db, `SELECT * FROM interaction
		WHERE conversation_id = $1 AND status IN ('pending', 'submitted') ORDER BY created_at, id`, conversationID)
	if err != nil {
		return nil, err
	}
	for _, i := range interactions {
		snapshot.Interactions = append(snapshot.Interactions, i.public())
	}
	snapshot.EventCursor = s.Cursors.Event(seq)
	return snapshot, nil
}

// Interactions is the latest interactions of every agent, newest first.
func (s *Service) Interactions(ctx context.Context, db pg.DB, limit int) (*InteractionList, error) {
	list := &InteractionList{Interactions: []Interaction{}}
	conversationID, err := DefaultConversationID(ctx, db)
	if err != nil || conversationID == "" {
		return list, err
	}
	rows, err := pg.All[interactionRow](ctx, db, `SELECT * FROM interaction
		WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, conversationID, limit)
	if err != nil {
		return nil, err
	}
	for _, i := range rows {
		list.Interactions = append(list.Interactions, i.public())
	}
	return list, nil
}

// History is one agent's messages, newest page first; each page in send
// order.
func (s *Service) History(ctx context.Context, db pg.DB, agentID, before string, limit int) (*MessagePage, error) {
	beforeSeq := int64(-1)
	if before != "" {
		seq, err := s.Cursors.DecodeHistory(before)
		if err != nil {
			return nil, err
		}
		beforeSeq = seq
	}
	conversationID, err := DefaultConversationID(ctx, db)
	if err != nil {
		return nil, err
	}
	id, ok := pg.ParseID(agentID)
	if conversationID == "" || !ok {
		return nil, apierr.NotFound()
	}
	found, err := pg.Exists(ctx, db, `SELECT 1 FROM agent
		WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL`, id, conversationID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, apierr.NotFound()
	}
	query := "SELECT * FROM message WHERE agent_id = $1"
	args := []any{id, limit + 1}
	if beforeSeq >= 0 {
		query += " AND seq < $3"
		args = append(args, beforeSeq)
	}
	page, err := pg.All[messageRow](ctx, db, query+" ORDER BY seq DESC LIMIT $2", args...)
	if err != nil {
		return nil, err
	}
	hasMore := len(page) > limit
	if hasMore {
		page = page[:limit]
	}
	slices.Reverse(page)
	result := &MessagePage{Items: []Message{}}
	for _, m := range page {
		result.Items = append(result.Items, m.public())
	}
	if hasMore {
		cursor := s.Cursors.History(page[0].Seq)
		result.NextCursor = &cursor
	}
	return result, nil
}

// --- writes (in the caller's transaction) -----------------------------------------

func liveAgent(ctx context.Context, tx pgx.Tx, conversationID, agentID string) (*AgentRecord, error) {
	id, ok := pg.ParseID(agentID)
	if !ok {
		return nil, apierr.NotFound()
	}
	agent, err := pg.One[AgentRecord](ctx, tx, `SELECT * FROM agent
		WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL`, id, conversationID)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, apierr.NotFound()
	}
	return agent, nil
}

// CreateAgent adds an agent; every plugin when plugins is nil.
func (s *Service) CreateAgent(ctx context.Context, tx pgx.Tx, name, description string, model *string, chosen []string) (*Agent, error) {
	if model != nil {
		if err := llm.Validate(ctx, s.Models, *model); err != nil {
			return nil, err
		}
	}
	chosen, err := s.Plugins.Choose(chosen)
	if err != nil {
		return nil, err
	}
	conversationID, err := ensureDefaultConversation(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err := LockConversation(ctx, tx, conversationID); err != nil {
		return nil, err
	}
	now := pg.Now()
	agent := &AgentRecord{
		ID: pg.NewID(), ConversationID: conversationID, Name: name, Description: description,
		Model: model, Plugins: chosen, DesiredState: DesiredStopped, Status: AgentStopped,
		ProductStatus: ProductIdle, ProductRevision: 1, CreatedAt: now, UpdatedAt: now,
	}
	if _, err := tx.Exec(ctx, `INSERT INTO agent (id, conversation_id, name, description, model, plugins,
		desired_state, status, generation, config_version, product_status, product_revision,
		last_command_seq, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'stopped', 'stopped', 0, 0, 'idle', 1, 0, $7, $7)`,
		agent.ID, conversationID, name, description, model, chosen, now); err != nil {
		return nil, err
	}
	if err := emitAgent(ctx, tx, agent); err != nil {
		return nil, err
	}
	public := agent.public()
	return &public, nil
}

// AgentChanges are the fields an update sets; nil ones stay.
type AgentChanges struct {
	Name        *string
	Description *string
	Model       *string
	Plugins     *[]string
}

func (s *Service) UpdateAgent(ctx context.Context, tx pgx.Tx, agentID string, changes AgentChanges) (*Agent, error) {
	if changes.Model != nil {
		// A network call: before taking the conversation lock.
		if err := llm.Validate(ctx, s.Models, *changes.Model); err != nil {
			return nil, err
		}
	}
	if changes.Plugins != nil {
		chosen, err := s.Plugins.Choose(*changes.Plugins)
		if err != nil {
			return nil, err
		}
		changes.Plugins = &chosen
	}
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return nil, err
	}
	agent, err := liveAgent(ctx, tx, conversationID, agentID)
	if err != nil {
		return nil, err
	}
	changed := false
	if changes.Name != nil && *changes.Name != agent.Name {
		agent.Name, changed = *changes.Name, true
	}
	if changes.Description != nil && *changes.Description != agent.Description {
		agent.Description, changed = *changes.Description, true
	}
	if changes.Model != nil && (agent.Model == nil || *changes.Model != *agent.Model) {
		agent.Model, changed = changes.Model, true
	}
	if changes.Plugins != nil && !slices.Equal(*changes.Plugins, agent.Plugins) {
		agent.Plugins, changed = *changes.Plugins, true
	}
	if changed {
		// Runtimes receive the name, instructions, model and plugins at start;
		// the controller restarts an idle runtime so the next turn uses them.
		agent.ConfigVersion++
		agent.ProductRevision++
		if _, err := tx.Exec(ctx, `UPDATE agent SET name = $2, description = $3, model = $4, plugins = $5,
			config_version = $6, product_revision = $7, updated_at = $8 WHERE id = $1`,
			agent.ID, agent.Name, agent.Description, agent.Model, agent.Plugins,
			agent.ConfigVersion, agent.ProductRevision, pg.Now()); err != nil {
			return nil, err
		}
		if err := emitAgent(ctx, tx, agent); err != nil {
			return nil, err
		}
	}
	public := agent.public()
	return &public, nil
}

// DeleteAgent hides the agent and stops its work; its messages stay in the
// history.
func (s *Service) DeleteAgent(ctx context.Context, tx pgx.Tx, agentID string) error {
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return err
	}
	agent, err := liveAgent(ctx, tx, conversationID, agentID)
	if err != nil {
		return err
	}
	now := pg.Now()
	if _, err := tx.Exec(ctx, `UPDATE agent SET deleted_at = $2, desired_state = 'stopped', updated_at = $2
		WHERE id = $1`, agent.ID, now); err != nil {
		return err
	}
	// Queued work is taken off the queue; running work is interrupted by the
	// runtime, and the controller then stops it.
	if err := s.stopReplies(ctx, tx, agent.ID); err != nil {
		return err
	}
	return emit(ctx, tx, conversationID, EventAgentDeleted, AgentDeleted{AgentID: agent.ID})
}

// RestartAgent stops the agent's work and its runtime; the next message
// starts afresh. The runtime is marked outdated, so the controller replaces
// it as soon as the interrupted work lets go of it, and the new one resumes
// the thread.
func (s *Service) RestartAgent(ctx context.Context, tx pgx.Tx, agentID string) error {
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return err
	}
	agent, err := liveAgent(ctx, tx, conversationID, agentID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent SET config_version = config_version + 1, updated_at = $2
		WHERE id = $1`, agent.ID, pg.Now()); err != nil {
		return err
	}
	return s.stopReplies(ctx, tx, agent.ID)
}

func (s *Service) stopReplies(ctx context.Context, tx pgx.Tx, agentID string) error {
	replies, err := pg.All[messageRow](ctx, tx, `SELECT * FROM message
		WHERE agent_id = $1 AND role = 'assistant' AND status = ANY($2) ORDER BY seq`, agentID, activeMessageStatuses)
	if err != nil {
		return err
	}
	for _, r := range replies {
		if err := s.requestStop(ctx, tx, r); err != nil {
			return err
		}
	}
	return nil
}

// SendMessage queues a turn. A steer joins the agent's running turn instead;
// with no running turn (or one that refuses it) it waits like any turn.
// messageID is the client's id for the message, or "" for a new one.
func (s *Service) SendMessage(ctx context.Context, tx pgx.Tx, agentID, messageID, text string, steer bool) (*Sent, error) {
	input := map[string]any{"text": text}
	if steer {
		input["steer"] = true
	}
	return s.enqueue(ctx, tx, agentID, messageID, text, input, KindTurn)
}

// Compact queues a compaction of the agent's context, shown as /compact.
func (s *Service) Compact(ctx context.Context, tx pgx.Tx, agentID string) (*Sent, error) {
	return s.enqueue(ctx, tx, agentID, "", "/compact", map[string]any{}, KindCompact)
}

func textBlock(text string) Block {
	return Block{ID: strings.ReplaceAll(pg.NewID(), "-", ""), Type: "text", Text: text}
}

func (s *Service) enqueue(ctx context.Context, tx pgx.Tx, agentID, messageID, text string, input map[string]any, kind string) (*Sent, error) {
	if messageID == "" {
		messageID = pg.NewID()
	} else if id, ok := pg.ParseID(messageID); ok {
		messageID = id
	} else {
		return nil, apierr.Invalid()
	}
	// A network call: before taking the conversation lock.
	if id, ok := pg.ParseID(agentID); ok {
		var model *string
		err := tx.QueryRow(ctx, "SELECT model FROM agent WHERE id = $1 AND deleted_at IS NULL", id).Scan(&model)
		if err == nil {
			if err := llm.EnsureUsable(ctx, s.Models, model); err != nil {
				return nil, err
			}
		} else if err != pgx.ErrNoRows {
			return nil, err
		}
	}
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return nil, err
	}
	agent, err := liveAgent(ctx, tx, conversationID, agentID)
	if err != nil {
		return nil, err
	}
	now := pg.Now()
	command := &CommandRecord{ID: pg.NewID(), AgentID: agent.ID, Kind: kind, Status: CommandQueued, Input: input, CreatedAt: now}
	if err := tx.QueryRow(ctx, `UPDATE agent SET last_command_seq = last_command_seq + 1
		WHERE id = $1 RETURNING last_command_seq`, agent.ID).Scan(&command.AgentSequence); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO agent_command (id, agent_id, agent_sequence, kind, status, input, created_at)
		VALUES ($1, $2, $3, $4, 'queued', $5, $6)`,
		command.ID, agent.ID, command.AgentSequence, kind, input, now); err != nil {
		return nil, err
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE conversation SET last_message_seq = last_message_seq + 2, updated_at = $2
		WHERE id = $1 RETURNING last_message_seq`, conversationID, now).Scan(&seq); err != nil {
		return nil, err
	}
	message := &messageRow{
		ID: messageID, ConversationID: conversationID, AgentID: agent.ID, CommandID: command.ID,
		Seq: seq - 1, Role: RoleUser, Status: MessageCompleted, Content: []Block{textBlock(text)},
		Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	answer := &messageRow{
		ID: pg.NewID(), ConversationID: conversationID, AgentID: agent.ID, CommandID: command.ID,
		ReplyToID: &message.ID, Seq: seq, Role: RoleAssistant, Status: MessageQueued, Content: []Block{},
		Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	for _, m := range []*messageRow{message, answer} {
		if _, err := tx.Exec(ctx, `INSERT INTO message (id, conversation_id, agent_id, command_id, reply_to_id,
			seq, role, content, status, revision, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10)`,
			m.ID, m.ConversationID, m.AgentID, m.CommandID, m.ReplyToID, m.Seq, m.Role, m.Content, m.Status, now); err != nil {
			return nil, err
		}
	}
	for _, m := range []*messageRow{message, answer} {
		if err := emit(ctx, tx, conversationID, EventMessageUpdated, MessageUpdated{m.public()}); err != nil {
			return nil, err
		}
	}
	if err := RefreshAgentStatus(ctx, tx, agent.ID); err != nil {
		return nil, err
	}
	// Still under the conversation lock, so commands enter the queue in order,
	// and before commit: a failure rolls everything back. The runtime's
	// events wait on the same lock, so they see these rows.
	steered := input["steer"] == true && s.steer(ctx, command, text)
	if !steered {
		queueSeq, err := s.Queue.Enqueue(ctx, agent.ID, map[string]any{
			"command_id":     command.ID,
			"kind":           command.Kind,
			"agent_sequence": command.AgentSequence,
			"payload":        command.Input,
		})
		if errors.Is(err, queue.ErrFull) {
			return nil, apierr.New(429, "QUEUE_FULL", "该智能体待处理的消息过多，请稍后再发送。")
		}
		if err != nil {
			slog.ErrorContext(ctx, "Agent queue unavailable", "error", err)
			return nil, apierr.QueueUnavailable()
		}
		if _, err := tx.Exec(ctx, "UPDATE agent_command SET queue_seq = $2 WHERE id = $1", command.ID, queueSeq); err != nil {
			return nil, err
		}
	}
	return &Sent{Message: message.public(), Reply: answer.public(), Steered: steered}, nil
}

// steer hands a steer to the agent's running turn; false if it does not
// take it.
func (s *Service) steer(ctx context.Context, command *CommandRecord, text string) bool {
	answer, err := s.Queue.Ask(ctx, command.AgentID, map[string]any{
		"type":           "steer",
		"command_id":     command.ID,
		"agent_sequence": command.AgentSequence,
		"text":           text,
	})
	if err != nil {
		slog.ErrorContext(ctx, "Could not reach the agent's runtime", "agent", command.AgentID, "error", err)
		return false
	}
	return answer != nil && answer["accepted"] == true
}

// tell sends the agent's runtime a control message. Repeating the request
// (stop, answer) sends it again, so a lost one is only logged.
func (s *Service) tell(ctx context.Context, agentID string, body map[string]any) {
	if err := s.Queue.Tell(ctx, agentID, body); err != nil {
		slog.ErrorContext(ctx, "Could not send a control message", "type", body["type"], "agent", agentID, "error", err)
	}
}

func (s *Service) interrupt(ctx context.Context, command *CommandRecord) {
	s.tell(ctx, command.AgentID, map[string]any{"type": "interrupt", "command_id": command.ID})
}

func (s *Service) requestStop(ctx context.Context, tx pgx.Tx, r *messageRow) error {
	command, err := pg.One[CommandRecord](ctx, tx, "SELECT * FROM agent_command WHERE id = $1", r.CommandID)
	if err != nil {
		return err
	}
	if command.Status == CommandQueued {
		withdrawn := false
		if command.QueueSeq != nil { // nil: a steer in the running turn
			withdrawn, err = s.Queue.Withdraw(ctx, *command.QueueSeq)
			if err != nil {
				slog.ErrorContext(ctx, "Agent queue unavailable", "error", err)
				return apierr.QueueUnavailable()
			}
		}
		if withdrawn {
			// Taken off the queue before any runtime took it.
			_, err := FinishCommand(ctx, tx, command, Cancelled, "")
			return err
		}
	}
	switch r.Status {
	case MessageQueued, MessageResponding, MessageWaitingForInput:
		// Ask the runtime to interrupt; it confirms by finalizing the reply.
		if command.InterruptRequestedAt == nil {
			if _, err := tx.Exec(ctx, "UPDATE agent_command SET interrupt_requested_at = $2 WHERE id = $1",
				command.ID, pg.Now()); err != nil {
				return err
			}
		}
		s.interrupt(ctx, command)
		if err := expireOpenInteractions(ctx, tx, r.ID); err != nil {
			return err
		}
		r.Status = MessageStopping
		if err := saveMessage(ctx, tx, r); err != nil {
			return err
		}
		return RefreshAgentStatus(ctx, tx, r.AgentID)
	case MessageStopping:
		// Still stopping: ask again.
		s.interrupt(ctx, command)
	}
	// Final: stopping again changes nothing.
	return nil
}

// StopReply stops the reply message: off the queue if it still waits there,
// otherwise the runtime interrupts it.
func (s *Service) StopReply(ctx context.Context, tx pgx.Tx, messageID string) (*Message, error) {
	id, ok := pg.ParseID(messageID)
	if !ok {
		return nil, apierr.NotFound()
	}
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return nil, err
	}
	r, err := pg.One[messageRow](ctx, tx, `SELECT * FROM message
		WHERE id = $1 AND conversation_id = $2 AND role = 'assistant'`, id, conversationID)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, apierr.NotFound()
	}
	if err := s.requestStop(ctx, tx, r); err != nil {
		return nil, err
	}
	r, err = pg.One[messageRow](ctx, tx, "SELECT * FROM message WHERE id = $1", id)
	if err != nil {
		return nil, err
	}
	public := r.public()
	return &public, nil
}

// AnswerInteraction submits the user's choice; an approval's decision goes
// to the runtime, which confirms it with approval.applied.
func (s *Service) AnswerInteraction(ctx context.Context, tx pgx.Tx, interactionID, value string) (*Interaction, error) {
	id, ok := pg.ParseID(interactionID)
	if !ok {
		return nil, apierr.NotFound()
	}
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return nil, err
	}
	interaction, err := pg.One[interactionRow](ctx, tx, `SELECT * FROM interaction
		WHERE id = $1 AND conversation_id = $2`, id, conversationID)
	if err != nil {
		return nil, err
	}
	if interaction == nil {
		return nil, apierr.NotFound()
	}
	if !slices.ContainsFunc(interaction.Options, func(o InteractionOption) bool { return o.Value == value }) {
		return nil, apierr.New(422, "INVALID_CHOICE", "所选项无效。")
	}
	expired := apierr.New(409, "INTERACTION_EXPIRED", "该交互已失效。")
	var approval *approvalRow
	if interaction.ApprovalID != nil {
		if approval, err = pg.One[approvalRow](ctx, tx, "SELECT * FROM approval WHERE id = $1", *interaction.ApprovalID); err != nil {
			return nil, err
		}
	}
	switch {
	case interaction.Status == InteractionPending:
		if interaction.ExpiresAt != nil && !interaction.ExpiresAt.After(time.Now()) {
			return nil, expired
		}
		interaction.Status = InteractionSubmitted
		interaction.Answer = &answer{Value: value}
		if err := saveInteraction(ctx, tx, interaction); err != nil {
			return nil, err
		}
		if approval != nil && approval.Status == ApprovalPending {
			decision := "decline"
			if value == "allow" {
				decision = "accept"
			}
			approval.Decision = &decision
			if _, err := tx.Exec(ctx, "UPDATE approval SET status = 'decided', decision = $2 WHERE id = $1",
				approval.ID, decision); err != nil {
				return nil, err
			}
			s.sendDecision(ctx, approval)
		}
	case interaction.Status == InteractionExpired:
		return nil, expired
	case interaction.Answer != nil && interaction.Answer.Value == value:
		if approval != nil && approval.Status == ApprovalDecided {
			// Not applied yet: send it again.
			s.sendDecision(ctx, approval)
		}
	default:
		return nil, apierr.New(409, "INTERACTION_ALREADY_ANSWERED", "该交互已有其他选择。")
	}
	public := interaction.public()
	return &public, nil
}

func (s *Service) sendDecision(ctx context.Context, approval *approvalRow) {
	s.tell(ctx, approval.AgentID, map[string]any{
		"type":        "decision",
		"approval_id": approval.SDKRequestID,
		"decision":    *approval.Decision,
	})
}

// --- the stream ---------------------------------------------------------------------

// UIEvent is a product event as stored: already a public payload.
type UIEvent struct {
	Seq     int64  `db:"seq"`
	Type    string `db:"type"`
	Payload []byte `db:"payload"`
}

// StreamStart is the ui_event sequence the cursor resumes after.
func (s *Service) StreamStart(ctx context.Context, db pg.DB, cursor string) (int64, error) {
	seq, err := s.Cursors.DecodeEvent(cursor)
	if err != nil {
		return 0, err
	}
	conversationID, err := DefaultConversationID(ctx, db)
	if err != nil {
		return 0, err
	}
	var latest int64
	var oldest *int64
	if conversationID != "" {
		if err := db.QueryRow(ctx, `SELECT last_ui_event_seq, (SELECT min(seq) FROM ui_event WHERE conversation_id = $1)
			FROM conversation WHERE id = $1`, conversationID).Scan(&latest, &oldest); err != nil {
			return 0, err
		}
	}
	// Ahead of the conversation (another database), behind what is kept, or
	// so far behind that a fresh snapshot is cheaper than the replay: the
	// browser loads the snapshot and follows from its cursor.
	pruned := seq < latest && (oldest == nil || *oldest > seq+1)
	if seq > latest || pruned || latest-seq > ReplayLimit {
		return 0, apierr.New(410, "CURSOR_EXPIRED", "事件游标已失效，请重新加载。")
	}
	return seq, nil
}

// EventsAfter is up to limit events of the default conversation after seq.
func EventsAfter(ctx context.Context, db pg.DB, conversationID string, seq int64, limit int) ([]*UIEvent, error) {
	return pg.All[UIEvent](ctx, db, `SELECT seq, type, payload FROM ui_event
		WHERE conversation_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`, conversationID, seq, limit)
}
