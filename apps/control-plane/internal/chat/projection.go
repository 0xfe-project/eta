package chat

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// Runtime events are stored raw in agent_event and projected onto product
// state; only allowlisted, translated fields reach messages, interactions
// and the ui_event stream.

// MaxEventBatch events are imported in one transaction at most.
const MaxEventBatch = 100

var activityLabels = map[string]string{
	"command":     "运行命令",
	"file_change": "修改文件",
	"mcp_tool":    "调用工具",
	"tool":        "调用工具",
	"web_search":  "搜索网页",
	"agent":       "协作子智能体",
	"image":       "生成图片",
	"compaction":  "压缩上下文",
}

// RuntimeEvent is one event of a runtime boot, as it published it
// (apps/agent-runtime/src/outbox.ts).
type RuntimeEvent struct {
	BootID  string         `json:"boot_id"`
	Seq     int64          `json:"seq"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type projection struct {
	s       *Service
	tx      pgx.Tx
	agentID string
	bootID  string
	// The reply a run of item.updated events changed and flush has yet to
	// save: one revision and one ui_event for the run, not one per event.
	unsaved *messageRow
}

// flush saves the reply changed since the last flush, if any. Every event
// but the next item.updated of the same reply comes after it.
func (p *projection) flush(ctx context.Context) error {
	r := p.unsaved
	if r == nil {
		return nil
	}
	p.unsaved = nil
	if err := saveMessage(ctx, p.tx, r); err != nil {
		return err
	}
	return p.touch(ctx)
}

type handler func(p *projection, ctx context.Context, command *CommandRecord, payload map[string]any) error

var handlers = map[string]handler{
	"runtime.started":    (*projection).runtimeStarted,
	"runtime.failed":     (*projection).runtimeFailed,
	"turn.started":       (*projection).turnStarted,
	"item.updated":       (*projection).itemUpdated,
	"approval.requested": (*projection).approvalRequested,
	"approval.applied":   (*projection).approvalApplied,
	"approval.expired":   (*projection).approvalExpired,
	"turn.steered":       (*projection).turnSteered,
	"turn.completed":     (*projection).turnCompleted,
}

// ImportEvents stores and projects an ordered run of one agent's runtime
// events, all of one boot. An event stored already (redelivered) is
// skipped. It takes the conversation lock.
func (s *Service) ImportEvents(ctx context.Context, tx pgx.Tx, agentID string, events []RuntimeEvent) error {
	var conversationID string
	err := tx.QueryRow(ctx, "SELECT conversation_id FROM agent WHERE id = $1", agentID).Scan(&conversationID)
	if err == pgx.ErrNoRows {
		return nil // not an agent of this control plane
	}
	if err != nil {
		return err
	}
	if err := LockConversation(ctx, tx, conversationID); err != nil {
		return err
	}
	p := &projection{s: s, tx: tx, agentID: agentID}
	for _, event := range events {
		boot, ok := pg.ParseID(event.BootID)
		if !ok {
			continue
		}
		p.bootID = boot
		// jsonb holds no NUL characters; command output can (find -print0).
		event.Payload, _ = withoutNUL(event.Payload).(map[string]any)
		payload := event.Payload
		if payload == nil {
			payload = map[string]any{}
		}
		command, err := p.command(ctx, payload["command_id"])
		if err != nil {
			return err
		}
		var commandID *string
		if command != nil {
			commandID = &command.ID
		}
		var eventSeq int64
		if err := tx.QueryRow(ctx, `UPDATE conversation SET last_event_seq = last_event_seq + 1, updated_at = $2
			WHERE id = $1 RETURNING last_event_seq`, conversationID, pg.Now()).Scan(&eventSeq); err != nil {
			return err
		}
		stored, err := tx.Exec(ctx, `INSERT INTO agent_event (id, conversation_id, agent_id, command_id,
			boot_id, source_seq, seq, type, schema_version, payload, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10)
			ON CONFLICT (agent_id, boot_id, source_seq) DO NOTHING`,
			pg.NewID(), conversationID, agentID, commandID, boot, event.Seq,
			eventSeq, truncate(event.Type, 64), payload, pg.Now())
		if err != nil {
			return err
		}
		if stored.RowsAffected() == 0 {
			continue
		}
		if event.Type != "item.updated" {
			if err := p.flush(ctx); err != nil {
				return err
			}
		}
		if h, ok := handlers[event.Type]; ok {
			if err := h(p, ctx, command, payload); err != nil {
				return err
			}
		}
	}
	return p.flush(ctx)
}

// withoutNUL is the JSON value with NUL characters taken out of its strings.
func withoutNUL(v any) any {
	switch v := v.(type) {
	case string:
		return strings.ReplaceAll(v, "\x00", "")
	case map[string]any:
		if v == nil {
			return v
		}
		out := make(map[string]any, len(v))
		for key, value := range v {
			out[strings.ReplaceAll(key, "\x00", "")] = withoutNUL(value)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, value := range v {
			out[i] = withoutNUL(value)
		}
		return out
	}
	return v
}

// pyStr is how the runtime's values were always read: str(value).
func pyStr(v any) string {
	switch v := v.(type) {
	case nil:
		return "None"
	case string:
		return v
	case bool:
		if v {
			return "True"
		}
		return "False"
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'g', -1, 64)
	default:
		data, _ := json.Marshal(v)
		return string(data)
	}
}

// truthy is Python's truthiness of a JSON value.
func truthy(v any) bool {
	switch v := v.(type) {
	case nil:
		return false
	case string:
		return v != ""
	case bool:
		return v
	case float64:
		return v != 0
	case []any:
		return len(v) > 0
	case map[string]any:
		return len(v) > 0
	}
	return true
}

// orEmpty is str(v or "").
func orEmpty(v any) string {
	if !truthy(v) {
		return ""
	}
	return pyStr(v)
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func (p *projection) command(ctx context.Context, id any) (*CommandRecord, error) {
	s, ok := id.(string)
	if !ok || s == "" {
		return nil, nil
	}
	parsed, ok := pg.ParseID(s)
	if !ok {
		return nil, nil
	}
	return pg.One[CommandRecord](ctx, p.tx, "SELECT * FROM agent_command WHERE id = $1 AND agent_id = $2", parsed, p.agentID)
}

func (p *projection) touch(ctx context.Context) error {
	now := pg.Now()
	_, err := p.tx.Exec(ctx, "UPDATE agent SET last_active_at = $2, updated_at = $2 WHERE id = $1", p.agentID, now)
	return err
}

// stringField is payload[key] when it is a string, else nil.
func stringField(payload map[string]any, key string) *string {
	if s, ok := payload[key].(string); ok {
		return &s
	}
	return nil
}

func (p *projection) turnStarted(ctx context.Context, command *CommandRecord, payload map[string]any) error {
	if command == nil || command.terminal() {
		return nil
	}
	if command.Status == CommandQueued {
		command.Status = CommandRunning
	}
	command.CodexTurnID = stringField(payload, "turn_id")
	if _, err := p.tx.Exec(ctx, `UPDATE agent_command SET status = $2, codex_turn_id = $3,
		started_at = COALESCE(started_at, $4) WHERE id = $1`,
		command.ID, command.Status, command.CodexTurnID, pg.Now()); err != nil {
		return err
	}
	if err := p.touch(ctx); err != nil {
		return err
	}
	r, err := reply(ctx, p.tx, command.ID)
	if err != nil {
		return err
	}
	if r != nil && r.Status == MessageQueued {
		r.Status = MessageResponding
		if err := saveMessage(ctx, p.tx, r); err != nil {
			return err
		}
	}
	return RefreshAgentStatus(ctx, p.tx, p.agentID)
}

// Activity details as the runtime clipped them: name, input and output.
var activityDetailChars = map[string]int{"name": 100, "input": 1000, "output": 4000}

func (p *projection) itemUpdated(ctx context.Context, command *CommandRecord, payload map[string]any) error {
	if command == nil {
		return nil
	}
	r := p.unsaved
	if r == nil || r.CommandID != command.ID {
		// Another reply's run ends here.
		if err := p.flush(ctx); err != nil {
			return err
		}
		var err error
		r, err = reply(ctx, p.tx, command.ID)
		if err != nil || r == nil || r.terminal() {
			return err
		}
	}
	item, _ := payload["item"].(map[string]any)
	itemID := truncate(orEmpty(item["id"]), 100)
	kind, _ := item["kind"].(string)
	var block Block
	if kind == "agent_message" {
		block = Block{ID: "t-" + itemID, Type: "text", Text: orEmpty(item["text"])}
	} else if label, ok := activityLabels[kind]; ok {
		status, _ := item["status"].(string)
		if status != "running" && status != "completed" && status != "failed" {
			status = "running"
		}
		block = Block{ID: "a-" + itemID, Type: "activity", Label: label, Status: status}
		for key, limit := range activityDetailChars {
			value, _ := item[key].(string)
			value = truncate(value, limit)
			switch key {
			case "name":
				block.Name = value
			case "input":
				block.Input = value
			case "output":
				block.Output = value
			}
		}
	} else {
		return nil
	}
	found := false
	for i, existing := range r.Content {
		if existing.ID == block.ID {
			if existing == block {
				return nil
			}
			r.Content[i], found = block, true
			break
		}
	}
	if !found {
		r.Content = append(r.Content, block)
	}
	if r.Status == MessageQueued {
		r.Status = MessageResponding
	}
	p.unsaved = r
	return nil
}

func approvalPrompt(kind string, summary map[string]*string) string {
	get := func(key string) string {
		if v := summary[key]; v != nil {
			return *v
		}
		return ""
	}
	var prompt string
	switch kind {
	case "elicitation":
		// A plugin's tool asking the user to confirm (see user-attention.md).
		server := get("server")
		if server == "" {
			server = "扩展"
		}
		prompt = server + " 请求确认"
		if m := get("message"); m != "" {
			prompt += "\n" + m
		}
	case "command":
		prompt = "允许运行命令？"
		if c := get("command"); c != "" {
			prompt += "\n" + c
		}
	default:
		prompt = "允许修改工作区文件？"
	}
	if r := get("reason"); r != "" {
		prompt += "\n原因：" + r
	}
	return truncate(prompt, 500)
}

func (p *projection) approvalRequested(ctx context.Context, command *CommandRecord, payload map[string]any) error {
	if command == nil {
		return nil
	}
	kind, _ := payload["kind"].(string)
	if kind != "command" && kind != "elicitation" {
		kind = "file_change"
	}
	raw, _ := payload["summary"].(map[string]any)
	field := func(key string, limit int) *string { return optional(truncate(orEmpty(raw[key]), limit)) }
	var summary map[string]*string
	if kind == "elicitation" {
		summary = map[string]*string{"server": field("server", 100), "message": field("message", 500)}
	} else {
		summary = map[string]*string{"command": field("command", 500), "reason": field("reason", 300)}
	}
	approvalID := pg.NewID()
	now := pg.Now()
	if _, err := p.tx.Exec(ctx, `INSERT INTO approval (id, agent_id, command_id, boot_id,
		sdk_request_id, kind, summary, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
		approvalID, p.agentID, command.ID, p.bootID,
		truncate(pyStr(payload["approval_id"]), 100), kind, summary, now); err != nil {
		return err
	}
	r, err := reply(ctx, p.tx, command.ID)
	if err != nil || r == nil {
		return err
	}
	stopping := r.Status != MessageQueued && r.Status != MessageResponding
	interaction := &interactionRow{
		ID: pg.NewID(), ConversationID: r.ConversationID, AgentID: p.agentID, MessageID: r.ID,
		ApprovalID: &approvalID, Kind: "choice", Prompt: approvalPrompt(kind, summary),
		Options:  []InteractionOption{{Value: "allow", Label: "允许"}, {Value: "deny", Label: "拒绝"}},
		Status:   InteractionPending,
		Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	if stopping {
		// A stop already in flight will cancel this request.
		interaction.Status = InteractionExpired
	}
	if _, err := p.tx.Exec(ctx, `INSERT INTO interaction (id, conversation_id, agent_id, message_id, approval_id,
		kind, prompt, options, status, revision, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'choice', $6, $7, $8, 1, $9, $9)`,
		interaction.ID, interaction.ConversationID, p.agentID, r.ID, approvalID,
		interaction.Prompt, interaction.Options, interaction.Status, now); err != nil {
		return err
	}
	if err := emitInteraction(ctx, p.tx, interaction); err != nil {
		return err
	}
	if stopping {
		return nil
	}
	if command.Status == CommandRunning {
		command.Status = CommandWaitingApproval
		if _, err := p.tx.Exec(ctx, "UPDATE agent_command SET status = 'waiting_approval' WHERE id = $1", command.ID); err != nil {
			return err
		}
	}
	r.Status = MessageWaitingForInput
	if err := saveMessage(ctx, p.tx, r); err != nil {
		return err
	}
	return RefreshAgentStatus(ctx, p.tx, p.agentID)
}

// approval is the agent's latest approval with the payload's id, and its
// interaction.
func (p *projection) approval(ctx context.Context, payload map[string]any) (*ApprovalRecord, *interactionRow, error) {
	approval, err := pg.One[ApprovalRecord](ctx, p.tx, `SELECT * FROM approval WHERE agent_id = $1 AND sdk_request_id = $2
		ORDER BY created_at DESC LIMIT 1`, p.agentID, pyStr(payload["approval_id"]))
	if err != nil || approval == nil {
		return nil, nil, err
	}
	interaction, err := pg.One[interactionRow](ctx, p.tx, "SELECT * FROM interaction WHERE approval_id = $1", approval.ID)
	return approval, interaction, err
}

func (p *projection) approvalApplied(ctx context.Context, _ *CommandRecord, payload map[string]any) error {
	approval, interaction, err := p.approval(ctx, payload)
	if err != nil || approval == nil {
		return err
	}
	if _, err := p.tx.Exec(ctx, "UPDATE approval SET status = 'applied', decision = $2, resolved_at = $3 WHERE id = $1",
		approval.ID, truncate(pyStr(payload["decision"]), 16), pg.Now()); err != nil {
		return err
	}
	if interaction != nil && (interaction.Status == InteractionSubmitted || interaction.Status == InteractionPending) {
		if interaction.Status == InteractionSubmitted {
			interaction.Status = InteractionResolved
		} else {
			interaction.Status = InteractionExpired
		}
		if err := saveInteraction(ctx, p.tx, interaction); err != nil {
			return err
		}
	}
	command, err := pg.One[CommandRecord](ctx, p.tx, "SELECT * FROM agent_command WHERE id = $1", approval.CommandID)
	if err != nil {
		return err
	}
	if command.Status == CommandWaitingApproval {
		if _, err := p.tx.Exec(ctx, "UPDATE agent_command SET status = 'running' WHERE id = $1", command.ID); err != nil {
			return err
		}
	}
	r, err := reply(ctx, p.tx, command.ID)
	if err != nil {
		return err
	}
	if r != nil && r.Status == MessageWaitingForInput {
		r.Status = MessageResponding
		if err := saveMessage(ctx, p.tx, r); err != nil {
			return err
		}
	}
	return RefreshAgentStatus(ctx, p.tx, p.agentID)
}

func (p *projection) approvalExpired(ctx context.Context, _ *CommandRecord, payload map[string]any) error {
	approval, interaction, err := p.approval(ctx, payload)
	if err != nil || approval == nil || approval.Status == ApprovalApplied {
		return err
	}
	if _, err := p.tx.Exec(ctx, "UPDATE approval SET status = 'expired', resolved_at = $2 WHERE id = $1",
		approval.ID, pg.Now()); err != nil {
		return err
	}
	if interaction != nil && (interaction.Status == InteractionPending || interaction.Status == InteractionSubmitted) {
		interaction.Status = InteractionExpired
		return saveInteraction(ctx, p.tx, interaction)
	}
	return nil
}

func (p *projection) turnCompleted(ctx context.Context, command *CommandRecord, payload map[string]any) error {
	if command == nil {
		return nil
	}
	var err error
	switch payload["status"] {
	case "completed":
		_, err = FinishCommand(ctx, p.tx, command, Succeeded, "")
	case "interrupted":
		_, err = FinishCommand(ctx, p.tx, command, Interrupted, "")
	default:
		_, err = FinishCommand(ctx, p.tx, command, Failed, "TURN_FAILED")
	}
	if err != nil {
		return err
	}
	return p.touch(ctx)
}

// turnSteered: the running turn took a steer in; the rest of it answers the
// steer.
func (p *projection) turnSteered(ctx context.Context, command *CommandRecord, payload map[string]any) error {
	if command != nil {
		if _, err := FinishCommand(ctx, p.tx, command, Succeeded, ""); err != nil {
			return err
		}
	}
	steer, err := p.command(ctx, payload["steer_command_id"])
	if err != nil || steer == nil || steer.terminal() {
		return err
	}
	now := pg.Now()
	interruptAt := steer.InterruptRequestedAt
	if command != nil && command.InterruptRequestedAt != nil && interruptAt == nil {
		// Stopping the turn's first part stops all of it.
		interruptAt = &now
	}
	if _, err := p.tx.Exec(ctx, `UPDATE agent_command SET status = 'running', codex_turn_id = $2, started_at = $3,
		delivered_at = COALESCE(delivered_at, $3), boot_id = $4, interrupt_requested_at = $5 WHERE id = $1`,
		steer.ID, stringField(payload, "turn_id"), now, p.bootID, interruptAt); err != nil {
		return err
	}
	r, err := reply(ctx, p.tx, steer.ID)
	if err != nil {
		return err
	}
	if r != nil && r.Status == MessageQueued {
		r.Status = MessageResponding
		if interruptAt != nil {
			r.Status = MessageStopping
		}
		if err := saveMessage(ctx, p.tx, r); err != nil {
			return err
		}
	}
	if err := RefreshAgentStatus(ctx, p.tx, p.agentID); err != nil {
		return err
	}
	return p.touch(ctx)
}

// runtimeStarted: a new boot of the agent's runtime is ready. Whatever was
// delivered to an earlier boot died with it: it is never replayed.
func (p *projection) runtimeStarted(ctx context.Context, _ *CommandRecord, _ map[string]any) error {
	if _, err := p.tx.Exec(ctx, `UPDATE agent SET status = 'ready', boot_id = $2, last_error_code = NULL, updated_at = $3
		WHERE id = $1`, p.agentID, p.bootID, pg.Now()); err != nil {
		return err
	}
	lost, err := pg.All[CommandRecord](ctx, p.tx, `SELECT * FROM agent_command WHERE agent_id = $1
		AND (status IN ('running', 'waiting_approval') OR (status = 'queued' AND delivered_at IS NOT NULL))
		AND boot_id IS DISTINCT FROM $2 ORDER BY agent_sequence`, p.agentID, p.bootID)
	if err != nil {
		return err
	}
	for _, command := range lost {
		if err := finishLost(ctx, p.tx, command); err != nil {
			return err
		}
	}
	return RefreshAgentStatus(ctx, p.tx, p.agentID)
}

// finishLost settles a command whose runtime is gone: stopped if a stop was
// asked for, otherwise failed with an unknown outcome.
func finishLost(ctx context.Context, tx pgx.Tx, command *CommandRecord) error {
	var err error
	if command.InterruptRequestedAt != nil {
		_, err = FinishCommand(ctx, tx, command, Cancelled, "")
	} else {
		_, err = FinishCommand(ctx, tx, command, Failed, "REPLY_INTERRUPTED")
	}
	return err
}

func (p *projection) runtimeFailed(ctx context.Context, _ *CommandRecord, payload map[string]any) error {
	code := orEmpty(payload["code"])
	if code == "" {
		code = "RUNTIME_FAILED"
	}
	return MarkAgentFailed(ctx, p.tx, p.agentID, code, nil)
}

// MarkAgentFailed records an agent whose runtime cannot run (its image did
// not build, its runtime could not start) and fails what waits on it. The
// caller holds the conversation lock.
func MarkAgentFailed(ctx context.Context, tx pgx.Tx, agentID, code string, buildError *string) error {
	code = truncate(code, 64)
	if _, err := tx.Exec(ctx, `UPDATE agent SET status = 'error', last_error_code = $2, build_error = $3, updated_at = $4
		WHERE id = $1`, agentID, code, buildError, pg.Now()); err != nil {
		return err
	}
	reason := "AGENT_UNAVAILABLE"
	switch {
	case strings.HasPrefix(code, "RECOVERY"):
		reason = "AGENT_RECOVERY_FAILED"
	case strings.HasPrefix(code, "PLUGIN"):
		reason = "AGENT_EXTENSION_FAILED"
	case code == "BUILD_FAILED":
		reason = "AGENT_BUILD_FAILED"
	}
	commands, err := pg.All[CommandRecord](ctx, tx, `SELECT * FROM agent_command
		WHERE agent_id = $1 AND status IN ('queued', 'running', 'waiting_approval') ORDER BY agent_sequence`, agentID)
	if err != nil {
		return err
	}
	for _, command := range commands {
		if command.Status == CommandQueued && command.DeliveredAt == nil {
			_, err = FinishCommand(ctx, tx, command, Failed, reason)
		} else {
			err = finishLost(ctx, tx, command)
		}
		if err != nil {
			return err
		}
	}
	return RefreshAgentStatus(ctx, tx, agentID)
}
