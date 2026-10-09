package chat

import (
	"context"
	"slices"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/snapshots"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/jsontime"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// An agent's snapshots (docs/architecture/chat-runtime.md#快照): its home
// after each of its last turns. Going back to one undoes the turns after it,
// in the workspace and in the Codex thread alike; the conversation's
// messages stay. A copy of an agent starts from its newest.

// AgentSnapshot is one of an agent's snapshots.
type AgentSnapshot struct {
	ID      string        `json:"id"`
	Kind    string        `json:"kind" enum:"turn,restore,copy,legacy" doc:"turn: after a turn; restore: an earlier one brought back; copy: another agent's, for this copy of it; legacy: from before snapshots were kept."`
	SavedAt jsontime.Time `json:"saved_at"`
	Size    int64         `json:"size"`
	// The user's message of the turn it follows.
	Message *string `json:"message" nullable:"true" doc:"The user's message of the turn it follows (turn)."`
	// The snapshot it brought back.
	RestoredFrom *string `json:"restored_from" nullable:"true" doc:"The snapshot it brought back (restore)."`
	Current      bool    `json:"current" doc:"The newest: where the agent's next runtime starts."`
}

// Snapshots is the agent's snapshots, newest first, with the messages of the
// turns they follow.
func (s *Service) Snapshots(ctx context.Context, db pg.DB, store snapshots.Store, agentID string) ([]AgentSnapshot, error) {
	id, ok := pg.ParseID(agentID)
	if !ok {
		return nil, apierr.NotFound()
	}
	if exists, err := pg.Exists(ctx, db, "SELECT 1 FROM agent WHERE id = $1 AND deleted_at IS NULL", id); err != nil || !exists {
		if err == nil {
			err = apierr.NotFound()
		}
		return nil, err
	}
	list, err := store.List(ctx, id)
	if err != nil {
		return nil, err
	}
	var commands []string
	for _, snapshot := range list {
		if id, ok := pg.ParseID(snapshot.Ref); ok && snapshot.Kind == snapshots.KindTurn {
			commands = append(commands, id)
		}
	}
	rows, err := pg.All[messageRow](ctx, db, `SELECT * FROM message WHERE agent_id = $1 AND role = 'user'
		AND command_id = ANY($2)`, id, commands)
	if err != nil {
		return nil, err
	}
	texts := map[string]string{}
	for _, m := range rows {
		var text strings.Builder
		for _, block := range m.Content {
			if block.Type == "text" {
				text.WriteString(block.Text)
			}
		}
		texts[m.CommandID] = truncate(text.String(), 200)
	}
	out := make([]AgentSnapshot, len(list))
	for i, snapshot := range list {
		out[i] = AgentSnapshot{
			ID: snapshot.ID, Kind: snapshot.Kind, SavedAt: jsontime.From(snapshot.SavedAt), Size: snapshot.Size,
			Current: i == 0,
		}
		switch snapshot.Kind {
		case snapshots.KindTurn:
			if text, ok := texts[snapshot.Ref]; ok {
				out[i].Message = &text
			}
		case snapshots.KindRestore:
			ref := snapshot.Ref
			out[i].RestoredFrom = &ref
		}
	}
	return out, nil
}

// PrepareRestore checks that the agent can go back to an earlier snapshot:
// nothing at work, so that no turn ends after it on the home it leaves.
// The caller holds the transaction across the restore and Restored.
func (s *Service) PrepareRestore(ctx context.Context, tx pgx.Tx, agentID string) error {
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return err
	}
	agent, err := liveAgent(ctx, tx, conversationID, agentID)
	if err != nil {
		return err
	}
	busy, err := pg.Exists(ctx, tx, `SELECT 1 FROM message WHERE agent_id = $1 AND role = 'assistant'
		AND status = ANY($2)`, agent.ID, activeMessageStatuses)
	if err != nil {
		return err
	}
	// A finished turn whose snapshot is still uploading counts as work.
	uploading, err := pg.Exists(ctx, tx, `SELECT 1 FROM runtime_instance r WHERE r.agent_id = $1 AND r.ended_at IS NULL
		AND (SELECT type FROM agent_event e WHERE e.runtime_instance_id = r.id AND e.source_seq IS NOT NULL
			AND e.type IN ('turn.completed', 'snapshot.saved', 'snapshot.failed')
			ORDER BY e.source_seq DESC LIMIT 1) = 'turn.completed'`, agent.ID)
	if err != nil {
		return err
	}
	if busy || uploading {
		return apierr.New(409, "AGENT_BUSY", "智能体正在工作，等它结束（或停止它）再回到之前的快照。")
	}
	return nil
}

// Restored records that the agent went back to an earlier snapshot: its
// runtime is replaced (the next one starts from it), and an agent that
// could not recover is available again.
func (s *Service) Restored(ctx context.Context, tx pgx.Tx, agentID string) error {
	now := pg.Now()
	if _, err := tx.Exec(ctx, `UPDATE agent SET config_version = config_version + 1, updated_at = $2,
		status = CASE WHEN status IN ('error', 'recovery_failed') THEN 'stopped' ELSE status END,
		last_error_code = CASE WHEN status IN ('error', 'recovery_failed') THEN NULL ELSE last_error_code END
		WHERE id = $1`, agentID, now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_session SET status = 'ready', last_error = NULL
		WHERE agent_id = $1 AND status = 'recovery_failed'`, agentID); err != nil {
		return err
	}
	return RefreshAgentStatus(ctx, tx, agentID)
}

// DuplicateAgent adds a copy of the agent as newID: its name, instructions,
// model and plugins, and, when its newest snapshot was copied, its thread
// (the copy resumes it from that snapshot, then goes its own way). Its
// messages stay with the original.
func (s *Service) DuplicateAgent(ctx context.Context, tx pgx.Tx, sourceID, newID string, snapshotCopied bool) (*Agent, error) {
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return nil, err
	}
	source, err := liveAgent(ctx, tx, conversationID, sourceID)
	if err != nil {
		return nil, err
	}
	name := []rune(source.Name + " 副本")
	if len(name) > 100 {
		name = name[:100]
	}
	agent, err := insertAgent(ctx, tx, conversationID, newID, string(name), source.Description, source.Model,
		slices.Clone(source.Plugins))
	if err != nil {
		return nil, err
	}
	if snapshotCopied {
		if _, err := tx.Exec(ctx, `INSERT INTO agent_session (agent_id, thread_id, status, sdk_version, runtime_version)
			SELECT $2, thread_id, 'ready', sdk_version, runtime_version FROM agent_session
			WHERE agent_id = $1 AND thread_id IS NOT NULL`, source.ID, newID); err != nil {
			return nil, err
		}
	}
	return agent, nil
}
