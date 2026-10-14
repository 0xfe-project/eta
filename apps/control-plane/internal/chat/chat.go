// Package chat turns product intents (create an agent, send, stop, answer)
// into internal records, and runtime events into product state: agent status,
// messages, interactions and the ui_event stream the browser follows.
package chat

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

const (
	HistoryPageSize    = 50
	MaxHistoryPageSize = 100
	// MaxQueuedPerAgent commands wait at most; a full queue refuses more.
	MaxQueuedPerAgent = 20
)

type Service struct {
	Models  llm.Catalog
	Bundles *bundles.Catalog
	Cursors Cursors
	// Where attachments are; nil when no S3 is configured: messages carry
	// text only.
	Store Store
}

// --- reads --------------------------------------------------------------------

func (s *Service) Snapshot(ctx context.Context, db pg.DB) (*Snapshot, error) {
	snapshot := &Snapshot{Groups: []Group{}, Agents: []Agent{}, ActiveReplies: []Message{}, Interactions: []Interaction{}}
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
	snapshot.Groups, err = s.Groups(ctx, db)
	if err != nil {
		return nil, err
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

// History is one group's messages, newest page first; each page in send
// order.
func (s *Service) History(ctx context.Context, db pg.DB, groupID, before string, limit int) (*MessagePage, error) {
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
	id, ok := pg.ParseID(groupID)
	if conversationID == "" || !ok {
		return nil, apierr.NotFound()
	}
	found, err := pg.Exists(ctx, db, `SELECT 1 FROM chat_group
		WHERE id = $1 AND conversation_id = $2`, id, conversationID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, apierr.NotFound()
	}
	query := "SELECT * FROM message WHERE group_id = $1"
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

// CreateAgent adds an agent; it loads every built-in bundle when chosen is
// nil. The controller builds its image and starts it.
func (s *Service) CreateAgent(ctx context.Context, tx pgx.Tx, name, description string, model *string, chosen []string) (*Agent, error) {
	if model != nil {
		if err := llm.Validate(ctx, s.Models, *model); err != nil {
			return nil, err
		}
	}
	chosen, plugins, err := s.Bundles.Choose(ctx, tx, chosen)
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
		Model: model, Bundles: chosen, Plugins: plugins, Status: AgentStarting,
		ProductStatus: ProductIdle, ProductRevision: 1, CreatedAt: now, UpdatedAt: now,
	}
	if _, err := tx.Exec(ctx, `INSERT INTO agent (id, conversation_id, name, description, model, bundles, plugins,
		status, config_version, product_status, product_revision, last_command_seq, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'starting', 0, 'idle', 1, 0, $8, $8)`,
		agent.ID, conversationID, name, description, model, chosen, plugins, now); err != nil {
		return nil, err
	}
	if _, err := createGroup(ctx, tx, conversationID, name, "", []string{agent.ID}, true); err != nil {
		return nil, err
	}
	if err := emitAgent(ctx, tx, agent); err != nil {
		return nil, err
	}
	if err := Notify(ctx, tx, agent.ID); err != nil {
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
	Bundles     *[]string
}

func (s *Service) UpdateAgent(ctx context.Context, tx pgx.Tx, agentID string, changes AgentChanges) (*Agent, error) {
	if changes.Model != nil {
		// A network call: before taking the conversation lock.
		if err := llm.Validate(ctx, s.Models, *changes.Model); err != nil {
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
	changed := false
	chosen := agent.Bundles
	if changes.Bundles != nil {
		chosen = *changes.Bundles
	}
	chosen, plugins, err := s.Bundles.Choose(ctx, tx, chosen)
	if err != nil {
		return nil, err
	}
	changes.Bundles = &chosen
	if changes.Name != nil && *changes.Name != agent.Name {
		agent.Name, changed = *changes.Name, true
	}
	if changes.Description != nil && *changes.Description != agent.Description {
		agent.Description, changed = *changes.Description, true
	}
	if changes.Model != nil && (agent.Model == nil || *changes.Model != *agent.Model) {
		agent.Model, changed = changes.Model, true
	}
	if changes.Bundles != nil && !slices.Equal(*changes.Bundles, agent.Bundles) {
		agent.Bundles, agent.Plugins, changed = *changes.Bundles, plugins, true
	}
	if changed {
		// Runtimes receive the name, instructions, model and bundles when
		// their container starts; the controller replaces an idle one.
		agent.ConfigVersion++
		agent.ProductRevision++
		if _, err := tx.Exec(ctx, `UPDATE agent SET name = $2, description = $3, model = $4, bundles = $5, plugins = $6,
			config_version = $7, product_revision = $8, updated_at = $9 WHERE id = $1`,
			agent.ID, agent.Name, agent.Description, agent.Model, agent.Bundles, agent.Plugins,
			agent.ConfigVersion, agent.ProductRevision, pg.Now()); err != nil {
			return nil, err
		}
		if changes.Name != nil {
			if _, err := tx.Exec(ctx, `UPDATE chat_group SET name=$2 WHERE direct_agent_id=$1`, agent.ID, agent.Name); err != nil {
				return nil, err
			}
			if err := refreshAgentGroups(ctx, tx, agent.ID); err != nil {
				return nil, err
			}
		}
		if err := emitAgent(ctx, tx, agent); err != nil {
			return nil, err
		}
		if err := Notify(ctx, tx, agent.ID); err != nil {
			return nil, err
		}
	}
	public := agent.public()
	return &public, nil
}

// DeleteAgent hides the agent and stops its work; its messages stay in the
// history, its volume on the machine. The controller removes its container.
func (s *Service) DeleteAgent(ctx context.Context, tx pgx.Tx, agentID string) error {
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return err
	}
	agent, err := liveAgent(ctx, tx, conversationID, agentID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE agent SET deleted_at = $2, updated_at = $2 WHERE id = $1", agent.ID, pg.Now()); err != nil {
		return err
	}
	if err := s.stopReplies(ctx, tx, agent.ID); err != nil {
		return err
	}
	if err := Notify(ctx, tx, agent.ID); err != nil {
		return err
	}
	if err := refreshAgentGroups(ctx, tx, agent.ID); err != nil {
		return err
	}
	return emit(ctx, tx, conversationID, EventAgentDeleted, AgentDeleted{AgentID: agent.ID})
}

// RestartAgent stops the agent's work and replaces its container as soon as
// the interrupted work lets go of it; the new one resumes the thread.
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
	if err := s.stopReplies(ctx, tx, agent.ID); err != nil {
		return err
	}
	return Notify(ctx, tx, agent.ID)
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

func textBlock(text string) Block {
	return Block{ID: strings.ReplaceAll(pg.NewID(), "-", ""), Type: "text", Text: text}
}

func (s *Service) requestStop(ctx context.Context, tx pgx.Tx, r *messageRow) error {
	command, err := pg.One[CommandRecord](ctx, tx, "SELECT * FROM agent_command WHERE id = $1", *r.CommandID)
	if err != nil {
		return err
	}
	if command.Status == CommandQueued && command.DeliveredAt == nil {
		// Still waiting here: nothing ran.
		_, err := FinishCommand(ctx, tx, command, Cancelled, "")
		return err
	}
	if r.Status != MessageQueued && r.Status != MessageResponding && r.Status != MessageWaitingForInput {
		return nil // stopping already, or final
	}
	// Delivered: the controller asks the runtime to interrupt it, which
	// confirms by finishing the reply.
	if _, err := tx.Exec(ctx, "UPDATE agent_command SET interrupt_requested_at = $2 WHERE id = $1 AND interrupt_requested_at IS NULL",
		command.ID, pg.Now()); err != nil {
		return err
	}
	if err := expireOpenInteractions(ctx, tx, r.ID); err != nil {
		return err
	}
	r.Status = MessageStopping
	if err := saveMessage(ctx, tx, r); err != nil {
		return err
	}
	if err := Notify(ctx, tx, *r.AgentID); err != nil {
		return err
	}
	return RefreshAgentStatus(ctx, tx, *r.AgentID)
}

// StopReply stops the reply message: at once if it still waits, otherwise
// the runtime interrupts it.
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
		WHERE id = $1 AND conversation_id = $2 AND role = 'assistant' AND command_id IS NOT NULL`, id, conversationID)
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
// to the runtime (the controller delivers it), which confirms it with
// approval.applied.
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
	var approval *ApprovalRecord
	if interaction.ApprovalID != nil {
		if approval, err = pg.One[ApprovalRecord](ctx, tx, "SELECT * FROM approval WHERE id = $1", *interaction.ApprovalID); err != nil {
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
			if _, err := tx.Exec(ctx, "UPDATE approval SET status = 'decided', decision = $2 WHERE id = $1",
				approval.ID, decision); err != nil {
				return nil, err
			}
			if err := Notify(ctx, tx, approval.AgentID); err != nil {
				return nil, err
			}
		}
	case interaction.Status == InteractionExpired:
		return nil, expired
	case interaction.Answer != nil && interaction.Answer.Value == value:
		// The same answer again: the controller still delivers it.
	default:
		return nil, apierr.New(409, "INTERACTION_ALREADY_ANSWERED", "该交互已有其他选择。")
	}
	public := interaction.public()
	return &public, nil
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
	if conversationID != "" {
		if err := db.QueryRow(ctx, "SELECT last_ui_event_seq FROM conversation WHERE id = $1", conversationID).Scan(&latest); err != nil {
			return 0, err
		}
	}
	if seq > latest {
		return 0, apierr.New(410, "CURSOR_EXPIRED", "事件游标已失效，请重新加载。")
	}
	return seq, nil
}

// EventsAfter is up to limit events of the default conversation after seq.
func EventsAfter(ctx context.Context, db pg.DB, conversationID string, seq int64, limit int) ([]*UIEvent, error) {
	return pg.All[UIEvent](ctx, db, `SELECT seq, type, payload FROM ui_event
		WHERE conversation_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`, conversationID, seq, limit)
}
