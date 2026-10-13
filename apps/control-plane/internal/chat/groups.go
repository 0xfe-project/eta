package chat

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/jsontime"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

type Group struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Kind          string         `json:"kind" enum:"group,direct"`
	Goal          string         `json:"goal"`
	Decided       string         `json:"decided"`
	Archived      bool           `json:"archived"`
	ReadSeq       int64          `json:"read_seq"`
	LastSeq       int64          `json:"last_seq"`
	Unread        int            `json:"unread"`
	Preview       string         `json:"preview"`
	Revision      int64          `json:"revision"`
	LastMessageAt *jsontime.Time `json:"last_message_at" nullable:"true"`
	UpdatedAt     jsontime.Time  `json:"updated_at"`
	Participants  []Participant  `json:"participants"`
}

type Participant struct {
	AgentID string `json:"agent_id" db:"agent_id"`
	Member  bool   `json:"member" db:"member"`
	Name    string `json:"name" db:"name"`
	Status  string `json:"status" db:"status"`
}

type groupRow struct {
	ID             string    `db:"id"`
	ConversationID string    `db:"conversation_id"`
	Name           string    `db:"name"`
	Kind           string    `db:"kind"`
	DirectAgentID  *string   `db:"direct_agent_id"`
	Goal           string    `db:"goal"`
	Decided        string    `db:"decided"`
	Archived       bool      `db:"archived"`
	ReadSeq        int64     `db:"read_seq"`
	Revision       int64     `db:"revision"`
	CreatedAt      time.Time `db:"created_at"`
	UpdatedAt      time.Time `db:"updated_at"`
}

func findGroup(ctx context.Context, db pg.DB, id string) (*groupRow, error) {
	parsed, ok := pg.ParseID(id)
	if !ok {
		return nil, apierr.NotFound()
	}
	g, err := pg.One[groupRow](ctx, db, "SELECT * FROM chat_group WHERE id = $1", parsed)
	if err != nil {
		return nil, err
	}
	if g == nil {
		return nil, apierr.NotFound()
	}
	return g, nil
}

func GetGroup(ctx context.Context, db pg.DB, id string) (*Group, error) {
	g, err := findGroup(ctx, db, id)
	if err != nil {
		return nil, err
	}
	out := &Group{ID: g.ID, Name: g.Name, Kind: g.Kind, Goal: g.Goal, Decided: g.Decided, Archived: g.Archived, ReadSeq: g.ReadSeq, Revision: g.Revision, UpdatedAt: jsontime.From(g.UpdatedAt), Participants: []Participant{}}
	participants, err := pg.All[Participant](ctx, db, `SELECT p.agent_id, p.member, a.name, a.product_status AS status
        FROM group_participant p JOIN agent a ON a.id = p.agent_id WHERE p.group_id = $1 AND p.removed_at IS NULL AND a.deleted_at IS NULL ORDER BY p.joined_at, p.agent_id`, g.ID)
	if err != nil {
		return nil, err
	}
	for _, p := range participants {
		out.Participants = append(out.Participants, *p)
	}
	var lastMessageAt *time.Time
	if err := db.QueryRow(ctx, `SELECT COALESCE(max(seq),0), count(*) FILTER (WHERE seq > $2 AND role <> 'user'), max(created_at) FROM message WHERE group_id = $1`, g.ID, g.ReadSeq).Scan(&out.LastSeq, &out.Unread, &lastMessageAt); err != nil {
		return nil, err
	}
	out.LastMessageAt = jsontime.Ptr(lastMessageAt)
	var content []Block
	err = db.QueryRow(ctx, `SELECT content FROM message WHERE group_id = $1 AND content <> '[]'::jsonb ORDER BY seq DESC LIMIT 1`, g.ID).Scan(&content)
	if err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	for _, b := range content {
		if b.Type == "text" {
			out.Preview = truncate(b.Text, 100)
			break
		}
	}
	return out, nil
}

func (s *Service) Groups(ctx context.Context, db pg.DB) ([]Group, error) {
	rows, err := pg.All[groupRow](ctx, db, `SELECT * FROM chat_group ORDER BY updated_at DESC, id`)
	if err != nil {
		return nil, err
	}
	out := []Group{}
	for _, r := range rows {
		g, err := GetGroup(ctx, db, r.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, *g)
	}
	return out, nil
}

func emitGroup(ctx context.Context, tx pgx.Tx, id string) error {
	g, err := GetGroup(ctx, tx, id)
	if err != nil {
		return err
	}
	var conversationID string
	if err := tx.QueryRow(ctx, "SELECT conversation_id FROM chat_group WHERE id = $1", id).Scan(&conversationID); err != nil {
		return err
	}
	return emit(ctx, tx, conversationID, EventGroupUpdated, GroupUpdated{*g})
}

// Agent names and removals also change participants in every group they belong to.
func refreshAgentGroups(ctx context.Context, tx pgx.Tx, agentID string) error {
	rows, err := pg.All[groupRow](ctx, tx, `UPDATE chat_group SET revision=revision+1 WHERE id IN (SELECT group_id FROM group_participant WHERE agent_id=$1) RETURNING *`, agentID)
	if err != nil {
		return err
	}
	for _, g := range rows {
		if err = emitGroup(ctx, tx, g.ID); err != nil {
			return err
		}
	}
	return nil
}

func touchGroup(ctx context.Context, tx pgx.Tx, id string) error {
	if _, err := tx.Exec(ctx, "UPDATE chat_group SET revision = revision + 1, updated_at = $2 WHERE id = $1", id, pg.Now()); err != nil {
		return err
	}
	return emitGroup(ctx, tx, id)
}

func createGroup(ctx context.Context, tx pgx.Tx, conversationID, name, goal string, agents []string, direct bool) (*groupRow, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 100 || len(agents) == 0 || len(agents) > 50 {
		return nil, apierr.Invalid()
	}
	g := &groupRow{ID: pg.NewID(), ConversationID: conversationID, Name: name, Goal: goal, Kind: "group", Revision: 1, CreatedAt: pg.Now(), UpdatedAt: pg.Now()}
	if direct {
		g.Kind = "direct"
		g.DirectAgentID = &agents[0]
	}
	if _, err := tx.Exec(ctx, `INSERT INTO chat_group (id,conversation_id,name,kind,direct_agent_id,goal,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, g.ID, conversationID, name, g.Kind, g.DirectAgentID, goal, g.CreatedAt); err != nil {
		return nil, err
	}
	for _, id := range agents {
		a, err := liveAgent(ctx, tx, conversationID, id)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO group_participant (group_id,agent_id,member,joined_at) VALUES ($1,$2,true,$3) ON CONFLICT DO NOTHING`, g.ID, a.ID, pg.Now()); err != nil {
			return nil, err
		}
	}
	return g, emitGroup(ctx, tx, g.ID)
}

func (s *Service) CreateGroup(ctx context.Context, tx pgx.Tx, name, goal string, agents []string) (*Group, error) {
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return nil, err
	}
	g, err := createGroup(ctx, tx, conversationID, name, goal, agents, false)
	if err != nil {
		return nil, err
	}
	return GetGroup(ctx, tx, g.ID)
}

type GroupChanges struct {
	Name     *string `json:"name,omitempty" nullable:"true" minLength:"1" maxLength:"100"`
	Goal     *string `json:"goal,omitempty" nullable:"true" maxLength:"10000"`
	Decided  *string `json:"decided,omitempty" nullable:"true" maxLength:"30000"`
	Archived *bool   `json:"archived,omitempty" nullable:"true"`
}

func (s *Service) UpdateGroup(ctx context.Context, tx pgx.Tx, id string, changes GroupChanges) (*Group, error) {
	if _, err := lockedDefault(ctx, tx); err != nil {
		return nil, err
	}
	g, err := findGroup(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if changes.Name != nil {
		if g.Kind == "direct" {
			return nil, apierr.Invalid()
		}
		g.Name = strings.TrimSpace(*changes.Name)
		if g.Name == "" {
			return nil, apierr.Invalid()
		}
	}
	if changes.Goal != nil {
		g.Goal = *changes.Goal
	}
	if changes.Decided != nil {
		g.Decided = *changes.Decided
	}
	if changes.Archived != nil {
		g.Archived = *changes.Archived
	}
	if _, err := tx.Exec(ctx, `UPDATE chat_group SET name=$2,goal=$3,decided=$4,archived=$5 WHERE id=$1`, g.ID, g.Name, g.Goal, g.Decided, g.Archived); err != nil {
		return nil, err
	}
	if changes.Goal != nil || changes.Decided != nil {
		if _, err := insertMessage(ctx, tx, g, "", nil, nil, nil, RoleAssistant, "system", []Block{textBlock("群简报已更新")}, nil); err != nil {
			return nil, err
		}
	}
	if err := touchGroup(ctx, tx, g.ID); err != nil {
		return nil, err
	}
	return GetGroup(ctx, tx, g.ID)
}

func (s *Service) SetMember(ctx context.Context, tx pgx.Tx, id, agentID string, member bool) (*Group, error) {
	conversationID, err := lockedDefault(ctx, tx)
	if err != nil {
		return nil, err
	}
	g, err := findGroup(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if g.Kind == "direct" {
		return nil, apierr.New(409, "DIRECT_GROUP", "私聊成员不能修改，请新建群。")
	}
	a, err := liveAgent(ctx, tx, conversationID, agentID)
	if err != nil {
		return nil, err
	}
	if !member {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM group_participant p JOIN agent a ON a.id=p.agent_id WHERE group_id=$1 AND member AND agent_id<>$2 AND a.deleted_at IS NULL`, id, agentID).Scan(&count); err != nil {
			return nil, err
		}
		if count == 0 {
			return nil, apierr.New(409, "LAST_MEMBER", "群里至少保留一个智能体。")
		}
		replies, err := pg.All[messageRow](ctx, tx, `SELECT * FROM message WHERE group_id=$1 AND agent_id=$2 AND role='assistant' AND status=ANY($3)`, id, agentID, activeMessageStatuses)
		if err != nil {
			return nil, err
		}
		for _, r := range replies {
			if err := s.requestStop(ctx, tx, r); err != nil {
				return nil, err
			}
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO group_participant (group_id,agent_id,member,joined_at,removed_at,thread_status) VALUES ($1,$2,$3,$4,CASE WHEN $3 THEN NULL ELSE $4::timestamptz END,CASE WHEN $3 THEN 'new' ELSE 'archived' END)
        ON CONFLICT (group_id,agent_id) DO UPDATE SET member=$3,removed_at=CASE WHEN $3 THEN NULL ELSE $4::timestamptz END, thread_status=CASE WHEN $3 THEN CASE WHEN group_participant.codex_thread_id IS NULL THEN 'new' ELSE 'ready' END ELSE 'archived' END`, id, agentID, member, pg.Now()); err != nil {
		return nil, err
	}
	action := "离开了群"
	if member {
		action = "加入了群"
	}
	if _, err := insertMessage(ctx, tx, g, "", nil, nil, nil, RoleAssistant, "system", []Block{textBlock(a.Name + action)}, nil); err != nil {
		return nil, err
	}
	if err := touchGroup(ctx, tx, id); err != nil {
		return nil, err
	}
	return GetGroup(ctx, tx, id)
}

func (s *Service) ReadGroupTo(ctx context.Context, tx pgx.Tx, id string, seq int64) (*Group, error) {
	if _, err := lockedDefault(ctx, tx); err != nil {
		return nil, err
	}
	if _, err := findGroup(ctx, tx, id); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE chat_group SET read_seq=GREATEST(read_seq,LEAST($2,(SELECT COALESCE(max(seq),0) FROM message WHERE group_id=$1))), revision=revision+1 WHERE id=$1`, id, seq); err != nil {
		return nil, err
	}
	if err := emitGroup(ctx, tx, id); err != nil {
		return nil, err
	}
	return GetGroup(ctx, tx, id)
}

func (s *Service) StopGroup(ctx context.Context, tx pgx.Tx, id string) error {
	if _, err := lockedDefault(ctx, tx); err != nil {
		return err
	}
	if _, err := findGroup(ctx, tx, id); err != nil {
		return err
	}
	replies, err := pg.All[messageRow](ctx, tx, `SELECT * FROM message WHERE group_id=$1 AND role='assistant' AND status=ANY($2) ORDER BY seq`, id, activeMessageStatuses)
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

func insertMessage(ctx context.Context, tx pgx.Tx, g *groupRow, id string, author, command, replyTo *string, role, kind string, blocks []Block, data map[string]any) (*messageRow, error) {
	if id == "" {
		id = pg.NewID()
	}
	if blocks == nil {
		blocks = []Block{}
	}
	if data == nil {
		data = map[string]any{}
	}
	m := &messageRow{ID: id, ConversationID: g.ConversationID, GroupID: g.ID, AgentID: author, CommandID: command, ReplyToID: replyTo, Role: role, Kind: kind, Data: data, Content: blocks, Status: MessageCompleted, Revision: 1, CreatedAt: pg.Now(), UpdatedAt: pg.Now()}
	if command != nil {
		m.Status = MessageQueued
	}
	if err := tx.QueryRow(ctx, `UPDATE conversation SET last_message_seq=last_message_seq+1 WHERE id=$1 RETURNING last_message_seq`, g.ConversationID).Scan(&m.Seq); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO message (id,conversation_id,group_id,agent_id,command_id,reply_to_id,seq,role,kind,data,content,status,revision,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$13)`, m.ID, m.ConversationID, g.ID, author, command, replyTo, m.Seq, role, kind, data, blocks, m.Status, m.CreatedAt); err != nil {
		return nil, err
	}
	if err := emit(ctx, tx, g.ConversationID, EventMessageUpdated, MessageUpdated{m.public()}); err != nil {
		return nil, err
	}
	return m, nil
}

func (s *Service) queueReply(ctx context.Context, tx pgx.Tx, g *groupRow, agentID, rootID, replyTo, kind string, input map[string]any) (*messageRow, error) {
	a, err := liveAgent(ctx, tx, g.ConversationID, agentID)
	if err != nil {
		return nil, err
	}
	if err := llm.EnsureUsable(ctx, s.Models, a.Model); err != nil {
		return nil, err
	}
	var waiting int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_command WHERE agent_id=$1 AND status='queued'`, agentID).Scan(&waiting); err != nil {
		return nil, err
	}
	if waiting >= MaxQueuedPerAgent {
		return nil, apierr.New(429, "QUEUE_FULL", "该智能体待处理的消息过多，请稍后再发送。")
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE agent SET last_command_seq=last_command_seq+1 WHERE id=$1 RETURNING last_command_seq`, agentID).Scan(&seq); err != nil {
		return nil, err
	}
	commandID := pg.NewID()
	if _, err := tx.Exec(ctx, `INSERT INTO agent_command (id,agent_id,group_id,root_message_id,agent_sequence,kind,status,input,created_at) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8)`, commandID, agentID, g.ID, rootID, seq, kind, input, pg.Now()); err != nil {
		return nil, err
	}
	r, err := insertMessage(ctx, tx, g, "", &agentID, &commandID, &replyTo, RoleAssistant, "message", nil, nil)
	if err != nil {
		return nil, err
	}
	if err := RefreshAgentStatus(ctx, tx, agentID); err != nil {
		return nil, err
	}
	return r, Notify(ctx, tx, agentID)
}

// A user message is stored once; targets allocate their reply slots in mention order.
func (s *Service) SendMessage(ctx context.Context, tx pgx.Tx, groupID, messageID string, targets []string, parts []Part, steer bool) (*Sent, error) {
	return s.enqueue(ctx, tx, groupID, messageID, targets, parts, steer, KindTurn)
}

func (s *Service) Compact(ctx context.Context, tx pgx.Tx, groupID string, targets []string) (*Sent, error) {
	return s.enqueue(ctx, tx, groupID, "", targets, []Part{{Type: "text", Text: "/compact"}}, false, KindCompact)
}

func (s *Service) enqueue(ctx context.Context, tx pgx.Tx, groupID, messageID string, targets []string, parts []Part, steer bool, kind string) (*Sent, error) {
	if messageID != "" {
		if id, ok := pg.ParseID(messageID); ok {
			messageID = id
		} else {
			return nil, apierr.Invalid()
		}
	}
	if _, err := lockedDefault(ctx, tx); err != nil {
		return nil, err
	}
	g, err := findGroup(ctx, tx, groupID)
	if err != nil {
		return nil, err
	}
	if g.Archived {
		return nil, apierr.New(409, "GROUP_ARCHIVED", "请先取消归档，再继续对话。")
	}
	members, err := pg.All[struct {
		ID string `db:"agent_id"`
	}](ctx, tx, `SELECT p.agent_id FROM group_participant p JOIN agent a ON a.id=p.agent_id WHERE p.group_id=$1 AND p.member AND a.deleted_at IS NULL ORDER BY p.joined_at,p.agent_id`, g.ID)
	if err != nil {
		return nil, err
	}
	if len(members) == 0 {
		return nil, apierr.NotFound()
	}
	if len(targets) == 0 && len(members) == 1 {
		targets = []string{members[0].ID}
	}
	chosen := []string{}
	for _, id := range targets {
		if !slices.ContainsFunc(members, func(m *struct {
			ID string `db:"agent_id"`
		}) bool {
			return m.ID == id
		}) {
			return nil, apierr.New(422, "NOT_A_MEMBER", "只能点名群成员；请先邀请。")
		}
		if !slices.Contains(chosen, id) {
			chosen = append(chosen, id)
		}
	}
	blocks, inputs, text, err := content(ctx, tx, g.ID, parts)
	if err != nil {
		return nil, err
	}
	m, err := insertMessage(ctx, tx, g, messageID, nil, nil, nil, RoleUser, "message", blocks, map[string]any{"mentions": chosen})
	if err != nil {
		return nil, err
	}
	result := &Sent{Message: m.public(), Replies: []Message{}}
	for _, id := range chosen {
		r, err := s.queueReply(ctx, tx, g, id, m.ID, m.ID, kind, map[string]any{"text": text, "parts": inputs, "steer": steer})
		if err != nil {
			var product *apierr.Error
			if len(chosen) == 1 || !errors.As(err, &product) || !(strings.HasPrefix(product.Code, "MODEL_") || product.Code == "QUEUE_FULL") {
				return nil, err
			}
			r, err = insertMessage(ctx, tx, g, "", &id, nil, &m.ID, RoleAssistant, "message", []Block{}, nil)
			if err != nil {
				return nil, err
			}
			r.Status = MessageFailed
			r.Failure = &Failure{Code: product.Code, Message: product.Message}
			if err = saveMessage(ctx, tx, r); err != nil {
				return nil, err
			}
		}
		result.Replies = append(result.Replies, r.public())
	}
	return result, touchGroup(ctx, tx, g.ID)
}

// RuntimeInput adds just a group header. History is fetched explicitly by the groups skill.
func RuntimeInput(ctx context.Context, db pg.DB, c *CommandRecord) (map[string]any, error) {
	g, err := findGroup(ctx, db, c.GroupID)
	if err != nil {
		return nil, err
	}
	var threadID *string
	var seen int64
	if err := db.QueryRow(ctx, `SELECT codex_thread_id,seen_seq FROM group_participant WHERE group_id=$1 AND agent_id=$2`, c.GroupID, c.AgentID).Scan(&threadID, &seen); err != nil {
		return nil, err
	}
	group, err := GetGroup(ctx, db, g.ID)
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, p := range group.Participants {
		if p.Member {
			names = append(names, p.Name)
		}
	}
	var unread int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM message WHERE group_id=$1 AND seq>$2`, g.ID, seen).Scan(&unread); err != nil {
		return nil, err
	}
	caller := "用户"
	if name, ok := c.Input["caller"].(string); ok {
		caller = name
	}
	header := fmt.Sprintf("[群：%s；成员：%s；点名者：%s；自上次参与后有 %d 条消息。需要前情时用 group_info / read_group / search_group。]\n", g.Name, strings.Join(names, "、"), caller, unread)
	parts := []any{map[string]any{"type": "text", "text": header}}
	if raw, ok := c.Parts().([]any); ok {
		parts = append(parts, raw...)
	} else {
		parts = append(parts, map[string]any{"type": "text", "text": c.Text()})
	}
	return map[string]any{"command_id": c.ID, "thread_key": g.ID, "codex_thread_id": threadID, "text": header + c.Text(), "parts": parts, "kind": c.Kind}, nil
}

// ActiveCommand is the agent's single execution slot, shared by auth and tools.
func ActiveCommand(ctx context.Context, db pg.DB, agentID string) (*CommandRecord, error) {
	return pg.One[CommandRecord](ctx, db, `SELECT c.* FROM agent_command c JOIN group_participant p ON p.group_id=c.group_id AND p.agent_id=c.agent_id WHERE c.agent_id=$1 AND c.status IN ('running','waiting_approval') AND p.removed_at IS NULL ORDER BY c.agent_sequence LIMIT 1`, agentID)
}

// CurrentCommand validates the gateway's context against the active execution slot.
func CurrentCommand(ctx context.Context, db pg.DB, groupID, agentID string) (*CommandRecord, error) {
	if _, ok := pg.ParseID(groupID); !ok {
		return nil, apierr.New(403, "NO_GROUP", "当前没有群对话。")
	}
	if _, ok := pg.ParseID(agentID); !ok {
		return nil, apierr.NotFound()
	}
	c, err := ActiveCommand(ctx, db, agentID)
	if err != nil {
		return nil, err
	}
	if c == nil || c.GroupID != groupID {
		return nil, apierr.New(403, "NO_GROUP", "当前没有群对话。")
	}
	if c.InterruptRequestedAt != nil {
		return nil, apierr.New(409, "COMMAND_STOPPED", "用户已停止这次对话。")
	}
	return c, nil
}

type MentionResult struct {
	Sent      bool   `json:"sent"`
	Remaining int    `json:"remaining"`
	Message   string `json:"message"`
}

func (s *Service) Mention(ctx context.Context, tx pgx.Tx, groupID, agentID, target, text string) (*MentionResult, error) {
	if _, err := lockedDefault(ctx, tx); err != nil {
		return nil, err
	}
	c, err := CurrentCommand(ctx, tx, groupID, agentID)
	if err != nil {
		return nil, err
	}
	g, err := findGroup(ctx, tx, groupID)
	if err != nil {
		return nil, err
	}
	if g.Archived {
		return nil, apierr.New(409, "GROUP_ARCHIVED", "群已归档。")
	}
	if strings.TrimSpace(text) == "" || len([]rune(text)) > MaxMessageText {
		return nil, apierr.Invalid()
	}
	// Accept an id or an exact, unambiguous name; never fuzzy-match a recipient.
	if _, ok := pg.ParseID(target); !ok {
		found, err := pg.All[AgentRecord](ctx, tx, `SELECT * FROM agent WHERE name=$1 AND deleted_at IS NULL`, target)
		if err != nil {
			return nil, err
		}
		if len(found) != 1 {
			return nil, apierr.New(422, "AMBIGUOUS_AGENT", "请使用智能体的准确名称或 id。")
		}
		target = found[0].ID
	}
	if target == agentID {
		return nil, apierr.New(422, "SELF_MENTION", "不能点名自己。")
	}
	a, err := liveAgent(ctx, tx, g.ConversationID, target)
	if err != nil {
		return nil, err
	}
	root, err := pg.One[messageRow](ctx, tx, `SELECT * FROM message WHERE id=$1 FOR UPDATE`, c.RootMessageID)
	if err != nil {
		return nil, err
	}
	var mentions int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM message WHERE reply_to_id=$1 AND kind='mention'`, root.ID).Scan(&mentions); err != nil {
		return nil, err
	}
	if mentions >= 5 {
		return &MentionResult{Message: "已达到 5 次唤醒上限；请用户审阅后再继续。"}, nil
	}
	var member bool
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT member FROM group_participant WHERE group_id=$1 AND agent_id=$2 AND removed_at IS NULL),false)`, groupID, target).Scan(&member); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO group_participant (group_id,agent_id,member,joined_at) VALUES ($1,$2,false,$3) ON CONFLICT (group_id,agent_id) DO UPDATE SET removed_at=NULL,thread_status=CASE WHEN group_participant.codex_thread_id IS NULL THEN 'new' ELSE 'ready' END`, groupID, target, pg.Now()); err != nil {
		return nil, err
	}
	sender, err := liveAgent(ctx, tx, g.ConversationID, agentID)
	if err != nil {
		return nil, err
	}
	m, err := insertMessage(ctx, tx, g, "", &agentID, nil, &root.ID, RoleAssistant, "mention", []Block{textBlock(text)}, map[string]any{"target_agent_id": target, "from": sender.Name, "to": a.Name})
	if err != nil {
		return nil, err
	}
	if _, err := s.queueReply(ctx, tx, g, target, root.ID, m.ID, KindTurn, map[string]any{"text": text, "caller": sender.Name}); err != nil {
		return nil, err
	}
	if !member {
		if _, err := insertMessage(ctx, tx, g, "", nil, nil, &root.ID, RoleAssistant, "system", []Block{textBlock(a.Name + " 和这里的讨论有关，可以拉进群。")}, map[string]any{"invite_agent_id": target}); err != nil {
			return nil, err
		}
	}
	mentions++
	if mentions == 5 {
		if _, err := insertMessage(ctx, tx, g, "", nil, nil, &root.ID, RoleAssistant, "system", []Block{textBlock("智能体已经往来唤醒 5 次了，请你看一下。")}, map[string]any{"mention_limit": true}); err != nil {
			return nil, err
		}
	}
	if err := touchGroup(ctx, tx, groupID); err != nil {
		return nil, err
	}
	return &MentionResult{Sent: true, Remaining: 5 - mentions, Message: "已通知，回复会留在当前群。不要等待或回叫；下次被唤醒时用 read_group 查看。"}, nil
}

// GroupMessages reads only this context. Guests have access during their invited turn.
func (s *Service) GroupMessages(ctx context.Context, db pg.DB, groupID, agentID string, after, before int64, limit int, query string) ([]Message, error) {
	if _, err := CurrentCommand(ctx, db, groupID, agentID); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 30
	}
	if limit > 100 {
		limit = 100
	}
	if after == 0 && before == 0 && query == "" {
		if err := db.QueryRow(ctx, `SELECT seen_seq FROM group_participant WHERE group_id=$1 AND agent_id=$2`, groupID, agentID).Scan(&after); err != nil {
			return nil, err
		}
	}
	rows, err := pg.All[messageRow](ctx, db, `SELECT * FROM message WHERE group_id=$1 AND ($2::bigint=0 OR seq>$2) AND ($3::bigint=0 OR seq<$3)
        AND NOT EXISTS (SELECT 1 FROM unnest($5::text[]) word WHERE (content::text || ' ' || data::text) NOT ILIKE '%' || replace(replace(replace(word,'\','\\'),'%','\%'),'_','\_') || '%') ORDER BY seq DESC LIMIT $4`, groupID, after, before, limit, strings.Fields(query))
	if err != nil {
		return nil, err
	}
	slices.Reverse(rows)
	out := []Message{}
	for _, r := range rows {
		out = append(out, r.public())
	}
	return out, nil
}
