package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
	"github.com/jackc/pgx/v5"
)

// Runtime outbox events are stored raw in agent_event and projected onto
// product state; only allowlisted, translated fields reach messages,
// interactions and the ui_event stream.

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

// RuntimeEvent is one event of a runtime's outbox.
type RuntimeEvent struct {
	SourceSeq     int64          `json:"source_seq"`
	SourceEventID string         `json:"source_event_id" maxLength:"100"`
	Type          string         `json:"type" maxLength:"64"`
	Payload       map[string]any `json:"payload"`
}

type projection struct {
	s        *Service
	tx       pgx.Tx
	agentID  string
	instance *RuntimeRecord
}

type handler func(p *projection, ctx context.Context, command *CommandRecord, payload map[string]any) error

var handlers = map[string]handler{
	"turn.started":            (*projection).turnStarted,
	"item.updated":            (*projection).itemUpdated,
	"approval.requested":      (*projection).approvalRequested,
	"approval.applied":        (*projection).approvalApplied,
	"turn.completed":          (*projection).turnCompleted,
	"turn.steered":            (*projection).turnSteered,
	"command.outcome_unknown": (*projection).outcomeUnknown,
	"snapshot.saved":          (*projection).snapshotSaved,
	"snapshot.failed":         (*projection).snapshotFailed,
	"runtime.failed":          (*projection).runtimeFailed,
}

// ImportEvents stores and projects an ordered batch from the instance and
// returns the acked source sequence. It takes the conversation lock.
func (s *Service) ImportEvents(ctx context.Context, tx pgx.Tx, instanceID string, events []RuntimeEvent) (int64, error) {
	if len(events) > MaxEventBatch {
		return 0, apierr.New(400, "BATCH_TOO_LARGE", "事件批次过大。")
	}
	var conversationID string
	if err := tx.QueryRow(ctx, `SELECT a.conversation_id FROM runtime_instance r
		JOIN agent a ON a.id = r.agent_id WHERE r.id = $1`, instanceID).Scan(&conversationID); err != nil {
		return 0, err
	}
	if err := LockConversation(ctx, tx, conversationID); err != nil {
		return 0, err
	}
	instance, err := One[RuntimeRecord](ctx, tx, "SELECT * FROM runtime_instance WHERE id = $1 FOR UPDATE", instanceID)
	if err != nil {
		return 0, err
	}
	p := &projection{s: s, tx: tx, agentID: instance.AgentID, instance: instance}
	for _, event := range events {
		seq := event.SourceSeq
		if seq <= instance.LastSourceSeq {
			var existingID string
			var existingPayload []byte
			err := tx.QueryRow(ctx, `SELECT source_event_id, payload FROM agent_event
				WHERE runtime_instance_id = $1 AND source_seq = $2`, instance.ID, seq).Scan(&existingID, &existingPayload)
			if err != nil && err != pgx.ErrNoRows {
				return 0, err
			}
			if err == pgx.ErrNoRows || existingID != event.SourceEventID || !samePayload(existingPayload, event.Payload) {
				return 0, apierr.New(409, "EVENT_CONFLICT", "事件与已记录内容冲突。")
			}
			continue
		}
		if seq != instance.LastSourceSeq+1 {
			e := apierr.New(409, "EVENT_GAP", "事件序号不连续。")
			e.Extra = map[string]any{"next_expected_source_seq": instance.LastSourceSeq + 1}
			return 0, e
		}
		payload := event.Payload
		if payload == nil {
			payload = map[string]any{}
		}
		command, err := p.command(ctx, payload["command_id"])
		if err != nil {
			return 0, err
		}
		var eventSeq int64
		if err := tx.QueryRow(ctx, `UPDATE conversation SET last_event_seq = last_event_seq + 1, updated_at = $2
			WHERE id = $1 RETURNING last_event_seq`, conversationID, Now()).Scan(&eventSeq); err != nil {
			return 0, err
		}
		var commandID *string
		if command != nil {
			commandID = &command.ID
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_event (id, conversation_id, agent_id, command_id,
			runtime_instance_id, source_event_id, source_seq, seq, type, schema_version, payload, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11)`,
			NewID(), conversationID, instance.AgentID, commandID, instance.ID, event.SourceEventID, seq,
			eventSeq, truncate(event.Type, 64), payload, Now()); err != nil {
			return 0, err
		}
		instance.LastSourceSeq = seq
		if h, ok := handlers[event.Type]; ok {
			if err := h(p, ctx, command, payload); err != nil {
				return 0, err
			}
		}
	}
	if _, err := tx.Exec(ctx, "UPDATE runtime_instance SET last_source_seq = $2, status = $3, error_code = $4 WHERE id = $1",
		instance.ID, instance.LastSourceSeq, instance.Status, instance.ErrorCode); err != nil {
		return 0, err
	}
	return instance.LastSourceSeq, nil
}

func samePayload(stored []byte, payload map[string]any) bool {
	var a, b any
	if json.Unmarshal(stored, &a) != nil {
		return false
	}
	data, _ := json.Marshal(payload)
	_ = json.Unmarshal(data, &b)
	return reflect.DeepEqual(a, b)
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

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (p *projection) command(ctx context.Context, id any) (*CommandRecord, error) {
	s, ok := id.(string)
	if !ok || s == "" {
		return nil, nil
	}
	parsed, ok := ParseID(s)
	if !ok {
		return nil, nil
	}
	return One[CommandRecord](ctx, p.tx, "SELECT * FROM agent_command WHERE id = $1 AND agent_id = $2", parsed, p.agentID)
}

func (p *projection) touch(ctx context.Context) error {
	now := Now()
	_, err := p.tx.Exec(ctx, "UPDATE agent SET last_active_at = $2, updated_at = $2 WHERE id = $1", p.agentID, now)
	return err
}

func (p *projection) setLastTurn(ctx context.Context, turnID *string) error {
	_, err := p.tx.Exec(ctx, "UPDATE agent_session SET last_turn_id = $2 WHERE agent_id = $1", p.agentID, turnID)
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
	if _, err := p.tx.Exec(ctx, `UPDATE agent_command SET status = $2, runtime_instance_id = $3, codex_turn_id = $4,
		started_at = COALESCE(started_at, $5) WHERE id = $1`,
		command.ID, command.Status, p.instance.ID, command.CodexTurnID, Now()); err != nil {
		return err
	}
	if err := p.setLastTurn(ctx, command.CodexTurnID); err != nil {
		return err
	}
	if _, err := p.tx.Exec(ctx, "UPDATE agent SET status = 'busy', updated_at = $2 WHERE id = $1 AND status <> 'busy'",
		p.agentID, Now()); err != nil {
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
	r, err := reply(ctx, p.tx, command.ID)
	if err != nil || r == nil || r.terminal() {
		return err
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
	if err := saveMessage(ctx, p.tx, r); err != nil {
		return err
	}
	return p.touch(ctx)
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
	approvalID := NewID()
	now := Now()
	if _, err := p.tx.Exec(ctx, `INSERT INTO approval (id, agent_id, command_id, runtime_instance_id, generation,
		sdk_request_id, kind, summary, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
		approvalID, p.agentID, command.ID, p.instance.ID, p.instance.Generation,
		truncate(pyStr(payload["approval_id"]), 100), kind, summary, now); err != nil {
		return err
	}
	r, err := reply(ctx, p.tx, command.ID)
	if err != nil || r == nil {
		return err
	}
	stopping := r.Status != MessageQueued && r.Status != MessageResponding
	interaction := &interactionRow{
		ID: NewID(), ConversationID: r.ConversationID, AgentID: p.agentID, MessageID: r.ID,
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
func (p *projection) approval(ctx context.Context, payload map[string]any) (*approvalRow, *interactionRow, error) {
	approval, err := One[approvalRow](ctx, p.tx, `SELECT * FROM approval WHERE agent_id = $1 AND sdk_request_id = $2
		ORDER BY created_at DESC LIMIT 1`, p.agentID, pyStr(payload["approval_id"]))
	if err != nil || approval == nil {
		return nil, nil, err
	}
	interaction, err := One[interactionRow](ctx, p.tx, "SELECT * FROM interaction WHERE approval_id = $1", approval.ID)
	return approval, interaction, err
}

func (p *projection) approvalApplied(ctx context.Context, _ *CommandRecord, payload map[string]any) error {
	approval, interaction, err := p.approval(ctx, payload)
	if err != nil || approval == nil {
		return err
	}
	if _, err := p.tx.Exec(ctx, "UPDATE approval SET status = 'applied', decision = $2, resolved_at = $3 WHERE id = $1",
		approval.ID, truncate(pyStr(payload["decision"]), 16), Now()); err != nil {
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
	command, err := One[CommandRecord](ctx, p.tx, "SELECT * FROM agent_command WHERE id = $1", approval.CommandID)
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
	if turnID := stringField(payload, "turn_id"); turnID != nil && *turnID != "" {
		if err := p.setLastTurn(ctx, turnID); err != nil {
			return err
		}
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
	now := Now()
	interruptAt := steer.InterruptRequestedAt
	if command != nil && command.InterruptRequestedAt != nil && interruptAt == nil {
		// Stopping the turn's first part stops all of it.
		interruptAt = &now
	}
	if _, err := p.tx.Exec(ctx, `UPDATE agent_command SET status = 'running', runtime_instance_id = $2,
		codex_turn_id = $3, started_at = $4, interrupt_requested_at = $5 WHERE id = $1`,
		steer.ID, p.instance.ID, stringField(payload, "turn_id"), now, interruptAt); err != nil {
		return err
	}
	if err := SetAgentStatus(ctx, p.tx, p.agentID, AgentBusy); err != nil {
		return err
	}
	r, err := reply(ctx, p.tx, steer.ID)
	if err != nil {
		return err
	}
	if r != nil && r.Status == MessageQueued {
		r.Status = MessageResponding
		if err := saveMessage(ctx, p.tx, r); err != nil {
			return err
		}
	}
	if err := RefreshAgentStatus(ctx, p.tx, p.agentID); err != nil {
		return err
	}
	return p.touch(ctx)
}

// outcomeUnknown: the runtime could not prove the turn did not run; it is
// never replayed.
func (p *projection) outcomeUnknown(ctx context.Context, command *CommandRecord, _ map[string]any) error {
	if command == nil {
		return nil
	}
	_, err := FinishCommand(ctx, p.tx, command, Failed, "REPLY_INTERRUPTED")
	return err
}

func (p *projection) snapshotSaved(ctx context.Context, _ *CommandRecord, _ map[string]any) error {
	_, err := p.tx.Exec(ctx, `UPDATE agent_session SET last_error = NULL
		WHERE agent_id = $1 AND last_error LIKE 'SNAPSHOT%'`, p.agentID)
	return err
}

// snapshotFailed: work since the last good snapshot would be lost with the
// container.
func (p *projection) snapshotFailed(ctx context.Context, _ *CommandRecord, payload map[string]any) error {
	reason := orEmpty(payload["reason"])
	if reason == "" {
		reason = "SNAPSHOT_FAILED"
	}
	_, err := p.tx.Exec(ctx, "UPDATE agent_session SET last_error = $2 WHERE agent_id = $1", p.agentID, truncate(reason, 100))
	return err
}

func (p *projection) runtimeFailed(ctx context.Context, _ *CommandRecord, payload map[string]any) error {
	code := orEmpty(payload["code"])
	if code == "" {
		code = "RUNTIME_FAILED"
	}
	return p.s.MarkRuntimeFailed(ctx, p.tx, p.instance, code)
}

// MarkRuntimeFailed records a runtime that cannot become ready and fails
// what waits on it. The caller holds the conversation lock.
func (s *Service) MarkRuntimeFailed(ctx context.Context, tx pgx.Tx, instance *RuntimeRecord, code string) error {
	instance.Status = RuntimeFailed
	errorCode := truncate(code, 64)
	instance.ErrorCode = &errorCode
	if _, err := tx.Exec(ctx, "UPDATE runtime_instance SET status = 'failed', error_code = $2 WHERE id = $1",
		instance.ID, errorCode); err != nil {
		return err
	}
	recovery := strings.HasPrefix(code, "RECOVERY")
	status := AgentError
	if recovery {
		status = AgentRecoveryFailed
	}
	if _, err := tx.Exec(ctx, "UPDATE agent SET status = $2, last_error_code = $3, updated_at = $4 WHERE id = $1",
		instance.AgentID, status, errorCode, Now()); err != nil {
		return err
	}
	if recovery {
		if _, err := tx.Exec(ctx, "UPDATE agent_session SET status = 'recovery_failed', last_error = $2 WHERE agent_id = $1",
			instance.AgentID, truncate(code, 100)); err != nil {
			return err
		}
	}
	reason := "AGENT_UNAVAILABLE"
	switch {
	case recovery:
		reason = "AGENT_RECOVERY_FAILED"
	case strings.HasPrefix(code, "PLUGIN"):
		reason = "AGENT_EXTENSION_FAILED"
	case code == "START_TIMEOUT":
		reason = "START_TIMEOUT"
	}
	// Nothing waiting runs: the next runtime starts with an empty queue.
	if err := s.Queue.Drop(ctx, instance.AgentID); err != nil {
		return fmt.Errorf("drop the agent's queue: %w", err)
	}
	waiting, err := All[CommandRecord](ctx, tx, `SELECT * FROM agent_command
		WHERE agent_id = $1 AND status = 'queued' ORDER BY agent_sequence`, instance.AgentID)
	if err != nil {
		return err
	}
	for _, command := range waiting {
		if _, err := FinishCommand(ctx, tx, command, Failed, reason); err != nil {
			return err
		}
	}
	return RefreshAgentStatus(ctx, tx, instance.AgentID)
}
