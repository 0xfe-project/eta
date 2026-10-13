package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// DraftTaskInput is a proposal, never an assignment or a task on the board.
type DraftTaskInput struct {
	Title      string `json:"title" minLength:"1" maxLength:"200"`
	Goal       string `json:"goal" maxLength:"10000"`
	Decided    string `json:"decided" maxLength:"10000"`
	Acceptance string `json:"acceptance" maxLength:"10000"`
	Source     string `json:"source,omitempty" maxLength:"1000" jsonschema:"Relevant message range as plain text, e.g. 第12–18条. Defaults to the message that woke you through the present."`
}

func (s *Service) DraftTask(ctx context.Context, tx pgx.Tx, groupID, agentID string, in DraftTaskInput) (*Message, error) {
	g, err := findGroup(ctx, tx, groupID)
	if err != nil {
		return nil, err
	}
	if err = LockConversation(ctx, tx, g.ConversationID); err != nil {
		return nil, err
	}
	c, err := CurrentCommand(ctx, tx, groupID, agentID)
	if err != nil {
		return nil, err
	}
	if g.Archived || strings.TrimSpace(in.Title) == "" || len([]rune(in.Title)) > 200 || strings.TrimSpace(in.Goal) == "" || strings.TrimSpace(in.Acceptance) == "" {
		return nil, apierr.New(422, "INVALID_DRAFT", "草稿需要标题、目标和验收标准。")
	}
	if strings.TrimSpace(in.Source) == "" {
		var first, last int64
		if err = tx.QueryRow(ctx, `SELECT seq,(SELECT max(seq) FROM message WHERE group_id=$2) FROM message WHERE id=$1`, c.RootMessageID, groupID).Scan(&first, &last); err != nil {
			return nil, err
		}
		in.Source = fmt.Sprintf("第 %d–%d 条", first, last)
	}
	desc := "## 目标\n\n" + in.Goal + "\n\n## 已决定\n\n" + in.Decided + "\n\n## 验收标准\n\n" + in.Acceptance + fmt.Sprintf("\n\n来源：群《%s》%s。", g.Name, in.Source)
	if len([]rune(desc)) > 20000 {
		return nil, apierr.New(422, "INVALID_DRAFT", "草稿正文不能超过 20000 字。")
	}
	m, err := insertMessage(ctx, tx, g, pg.NewID(), &agentID, nil, &c.RootMessageID, "assistant", "task_draft", []Block{}, map[string]any{"title": strings.TrimSpace(in.Title), "description": desc})
	if err != nil {
		return nil, err
	}
	if err = touchGroup(ctx, tx, groupID); err != nil {
		return nil, err
	}
	out := m.public()
	return &out, nil
}

// TaskDraft locks the conversation so repeated confirmations create exactly one task.
func TaskDraft(ctx context.Context, tx pgx.Tx, groupID, messageID string) (*Message, error) {
	g, err := findGroup(ctx, tx, groupID)
	if err != nil {
		return nil, err
	}
	if err = LockConversation(ctx, tx, g.ConversationID); err != nil {
		return nil, err
	}
	m, err := pg.One[messageRow](ctx, tx, `SELECT * FROM message WHERE id=$1 AND group_id=$2 AND kind IN ('task_draft','task_card')`, messageID, groupID)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, apierr.NotFound()
	}
	if g.Archived {
		return nil, apierr.New(409, "GROUP_ARCHIVED", "群已归档。")
	}
	out := m.public()
	return &out, nil
}

// ConfirmTaskDraft turns the original proposal into the group's one live task card.
func ConfirmTaskDraft(ctx context.Context, tx pgx.Tx, messageID, taskID string) error {
	if _, err := tx.Exec(ctx, `UPDATE message SET kind='task_card',agent_id=NULL,data=jsonb_build_object('task_id',$2::text) WHERE id=$1`, messageID, taskID); err != nil {
		return err
	}
	return SyncTaskCard(ctx, tx, taskID)
}

// SyncTaskCard projects task facts into one message in each context where it was linked.
// Task changes call it in the same transaction; it neither wakes members nor copies logs.
func SyncTaskCard(ctx context.Context, tx pgx.Tx, taskID string) error {
	var groupID *string
	var data []byte
	err := tx.QueryRow(ctx, `SELECT t.group_id,jsonb_build_object(
        'task_id',t.id,'number',t.number,'title',t.title,'status',t.status,'group_id',t.group_id,
        'assignee',t.assignee,'computer_name',c.name,'provider',t.provider,
        'run_status',(SELECT status FROM task_run WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1),
        'comments',(SELECT count(*) FROM task_activity WHERE task_id=t.id AND kind='comment'),
        'summary',COALESCE((SELECT body FROM task_activity WHERE task_id=t.id AND kind='comment' AND actor='remote' ORDER BY created_at DESC,id DESC LIMIT 1),(SELECT body FROM task_activity WHERE task_id=t.id AND kind='comment' ORDER BY created_at DESC,id DESC LIMIT 1),''),
        'deliverables',COALESCE((SELECT jsonb_agg(x.data ORDER BY x.created_at) FROM (SELECT DISTINCT ON (data->>'url') data,created_at FROM task_activity WHERE task_id=t.id AND kind='deliverable' ORDER BY data->>'url',created_at DESC,id DESC) x),'[]'::jsonb),
        'artifacts',COALESCE((SELECT jsonb_agg(x.data ORDER BY x.created_at) FROM (SELECT DISTINCT ON (data->>'artifact_id') data,created_at FROM task_activity WHERE task_id=t.id AND kind='artifact' ORDER BY data->>'artifact_id',created_at DESC,id DESC) x),'[]'::jsonb)
        ) FROM task t LEFT JOIN computer c ON c.id=t.computer_id WHERE t.id=$1`, taskID).Scan(&groupID, &data)
	if err != nil {
		return err
	}
	rows, err := pg.All[messageRow](ctx, tx, `SELECT * FROM message WHERE kind='task_card' AND data->>'task_id'=$1 ORDER BY group_id`, taskID)
	if err != nil {
		return err
	}
	seen := false
	for _, m := range rows {
		if groupID != nil && m.GroupID == *groupID {
			seen = true
		}
		if err = LockConversation(ctx, tx, m.ConversationID); err != nil {
			return err
		}
		if err = json.Unmarshal(data, &m.Data); err != nil {
			return err
		}
		if err = saveMessage(ctx, tx, m); err != nil {
			return err
		}
		if err = touchGroup(ctx, tx, m.GroupID); err != nil {
			return err
		}
	}
	if groupID != nil && !seen {
		g, err := findGroup(ctx, tx, *groupID)
		if err != nil {
			return err
		}
		if err = LockConversation(ctx, tx, g.ConversationID); err != nil {
			return err
		}
		var card map[string]any
		if err = json.Unmarshal(data, &card); err != nil {
			return err
		}
		if _, err = insertMessage(ctx, tx, g, pg.NewID(), nil, nil, nil, RoleAssistant, "task_card", []Block{}, card); err != nil {
			return err
		}
		return touchGroup(ctx, tx, *groupID)
	}
	return nil
}

// TaskReplyNotice confirms delivery without copying the task's comment timeline.
func TaskReplyNotice(ctx context.Context, tx pgx.Tx, groupID, taskID string, number int64) error {
	g, err := findGroup(ctx, tx, groupID)
	if err != nil {
		return err
	}
	if g.Archived {
		return apierr.New(409, "GROUP_ARCHIVED", "群已归档。")
	}
	if err = LockConversation(ctx, tx, g.ConversationID); err != nil {
		return err
	}
	if _, err = insertMessage(ctx, tx, g, "", nil, nil, nil, RoleAssistant, "system", []Block{textBlock(fmt.Sprintf("已转给 #%d 的执行者。", number))}, map[string]any{"task_id": taskID}); err != nil {
		return err
	}
	return touchGroup(ctx, tx, groupID)
}

// Deleted tasks leave their historical card, but it no longer opens a missing task.
func DeleteTaskCards(ctx context.Context, tx pgx.Tx, taskID string) error {
	rows, err := pg.All[messageRow](ctx, tx, `SELECT * FROM message WHERE kind='task_card' AND data->>'task_id'=$1`, taskID)
	if err != nil {
		return err
	}
	for _, m := range rows {
		if err = LockConversation(ctx, tx, m.ConversationID); err != nil {
			return err
		}
		m.Data["deleted"] = true
		if err = saveMessage(ctx, tx, m); err != nil {
			return err
		}
		if err = touchGroup(ctx, tx, m.GroupID); err != nil {
			return err
		}
	}
	return nil
}
