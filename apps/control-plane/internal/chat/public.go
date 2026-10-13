package chat

import (
	"encoding/json"
	"reflect"

	"github.com/akarachen/axp/packages/service-go/jsontime"
	"github.com/danielgtaylor/huma/v2"
)

// Public shapes: every response and SSE payload is one of these allowlists.
// Internal identifiers such as command, thread or runtime ids must never be
// added here.

type Agent struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Instructions injected into the agent's context.
	Description string   `json:"description" doc:"Instructions injected into the agent's context."`
	Model       *string  `json:"model" doc:"Model id from the LLM gateway catalog; null until one is chosen."`
	Bundles     []string `json:"bundles" doc:"The bundles it is built from, in catalog order (GET /api/v1/bundles)."`
	// starting: its environment is being prepared for the work waiting on it.
	Status string `json:"status" enum:"idle,starting,working,waiting_for_input,unavailable" doc:"starting: its environment is being prepared for the work waiting on it."`
	// Why its image could not be built: the end of the build's output.
	BuildError *string `json:"build_error" doc:"Why its image could not be built: the end of the build's output."`
	Revision   int64   `json:"revision"`
}

// Block is a part of a message: text, a file the user attached, or an
// activity (a tool call, a command, a search...).
type Block struct {
	ID   string
	Type string
	Text string
	// Attachments only.
	Attachment *Attachment
	// Activities only.
	Label  string
	Status string
	Name   string
	Input  string
	Output string
	// The one thing it made or touched; the zero ActivityRef when it names none.
	Ref ActivityRef
	// The places it made or opened on remote computers (the agenvo plugin).
	Operations []ActivityOperation
}

// ActivityRef is the one thing an activity made or touched, as its tool
// named it (apps/agent-runtime/src/items.ts): a task or a routine in AXP, a
// pull request on GitHub, an issue drafted for the user to file there, or
// an artifact's version.
// The transcript links to it.
type ActivityRef struct {
	Kind   string `json:"kind" enum:"task,routine,pull_request,issue_draft,artifact"`
	ID     string `json:"id,omitempty" doc:"The task's, routine's or artifact's id."`
	Number int64  `json:"number,omitempty" doc:"The task's or pull request's number, or the artifact's version."`
	Title  string `json:"title"`
	Status string `json:"status,omitempty" doc:"The task's status as the tool left it."`
	URL    string `json:"url,omitempty" doc:"The pull request, or GitHub's new-issue page prefilled with the draft."`
	Body   string `json:"body,omitempty" doc:"A draft's body, when its URL is too long to carry it."`
}

// ActivityOperation is a workspace or worktree an agenvo script made or
// opened on a remote computer, as the control plane recorded its native call
// (tasks.Operation). Nothing links to it: AXP has no page for those places.
type ActivityOperation struct {
	Action   string `json:"action" enum:"create_workspace,create_worktree,open_worktree,add_project"`
	Status   string `json:"status" enum:"completed,accepted,failed,unknown" doc:"accepted: the runtime took it but had not made it yet. unknown: it may or may not have happened."`
	Runtime  string `json:"runtime" enum:"paseo,herdr"`
	Computer string `json:"computer,omitempty" doc:"The AXP computer's name."`
	ID       string `json:"id,omitempty" doc:"The runtime's own workspace id."`
	Name     string `json:"name,omitempty"`
	Project  string `json:"project,omitempty"`
	Path     string `json:"path,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Base     string `json:"base,omitempty"`
	Error    string `json:"error,omitempty" doc:"Why it failed or is unknown, as the runtime said."`
}

type TextBlock struct {
	ID   string `json:"id"`
	Type string `json:"type" enum:"text"`
	Text string `json:"text"`
}

type AttachmentBlock struct {
	ID         string     `json:"id"`
	Type       string     `json:"type" enum:"attachment"`
	Attachment Attachment `json:"attachment"`
}

type ActivityBlock struct {
	ID     string       `json:"id"`
	Type   string       `json:"type" enum:"activity"`
	Label  string       `json:"label"`
	Status string       `json:"status" enum:"running,completed,failed"`
	Name   string       `json:"name,omitempty" doc:"The tool's own name (MCP and dynamic tools)."`
	Input  string       `json:"input,omitempty"`
	Output string       `json:"output,omitempty"`
	Ref    *ActivityRef `json:"ref,omitempty"`
	// Old blocks and other tools have none.
	Operations []ActivityOperation `json:"operations,omitempty"`
}

func (b Block) MarshalJSON() ([]byte, error) {
	if b.Type == "text" {
		return json.Marshal(TextBlock{ID: b.ID, Type: b.Type, Text: b.Text})
	}
	if b.Type == "attachment" && b.Attachment != nil {
		return json.Marshal(AttachmentBlock{ID: b.ID, Type: b.Type, Attachment: *b.Attachment})
	}
	activity := ActivityBlock{
		ID: b.ID, Type: b.Type, Label: b.Label, Status: b.Status,
		Name: b.Name, Input: b.Input, Output: b.Output, Operations: b.Operations,
	}
	if b.Ref.Kind != "" {
		activity.Ref = &b.Ref
	}
	return json.Marshal(activity)
}

func (b *Block) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID         string              `json:"id"`
		Type       string              `json:"type"`
		Text       string              `json:"text"`
		Attachment *Attachment         `json:"attachment"`
		Label      string              `json:"label"`
		Status     string              `json:"status"`
		Name       *string             `json:"name"`
		Input      *string             `json:"input"`
		Output     *string             `json:"output"`
		Ref        *ActivityRef        `json:"ref"`
		Operations []ActivityOperation `json:"operations"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	deref := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	*b = Block{
		ID: raw.ID, Type: raw.Type, Text: raw.Text, Attachment: raw.Attachment, Label: raw.Label, Status: raw.Status,
		Name: deref(raw.Name), Input: deref(raw.Input), Output: deref(raw.Output),
		Operations: raw.Operations,
	}
	if raw.Ref != nil {
		b.Ref = *raw.Ref
	}
	return nil
}

func (Block) Schema(r huma.Registry) *huma.Schema {
	text := r.Schema(reflect.TypeFor[TextBlock](), true, "")
	attachment := r.Schema(reflect.TypeFor[AttachmentBlock](), true, "")
	activity := r.Schema(reflect.TypeFor[ActivityBlock](), true, "")
	return &huma.Schema{
		OneOf: []*huma.Schema{text, attachment, activity},
		Discriminator: &huma.Discriminator{
			PropertyName: "type",
			Mapping:      map[string]string{"text": text.Ref, "attachment": attachment.Ref, "activity": activity.Ref},
		},
	}
}

// Failure is why a reply failed, for people.
type Failure struct {
	_       struct{} `nullable:"true"`
	Code    string   `json:"code"`
	Message string   `json:"message"`
}

type Message struct {
	ID        string        `json:"id"`
	AgentID   string        `json:"agent_id"`
	Role      string        `json:"role" enum:"user,assistant"`
	ReplyToID *string       `json:"reply_to_id"`
	Status    string        `json:"status" enum:"queued,responding,waiting_for_input,stopping,completed,stopped,failed"`
	Revision  int64         `json:"revision"`
	Blocks    []Block       `json:"blocks"`
	Failure   *Failure      `json:"failure"`
	CreatedAt jsontime.Time `json:"created_at"`
}

type InteractionOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type Interaction struct {
	ID        string              `json:"id"`
	AgentID   string              `json:"agent_id"`
	MessageID string              `json:"message_id"`
	Kind      string              `json:"kind" enum:"choice"`
	Prompt    string              `json:"prompt"`
	Options   []InteractionOption `json:"options"`
	Status    string              `json:"status" enum:"pending,submitted,resolved,expired"`
	Revision  int64               `json:"revision"`
	// The option the user chose; null until answered.
	Answer    *string       `json:"answer" nullable:"true" doc:"The option the user chose; null until answered."`
	CreatedAt jsontime.Time `json:"created_at"`
	UpdatedAt jsontime.Time `json:"updated_at"`
}

// InteractionList is the latest interactions, newest first, whatever their
// status: the confirmations the user has had, like notifications.
type InteractionList struct {
	Interactions []Interaction `json:"interactions"`
}

// Snapshot is the chat as of EventCursor: every agent, the replies still in
// progress and the interactions still open. The rest arrives over the stream.
type Snapshot struct {
	Agents        []Agent       `json:"agents"`
	ActiveReplies []Message     `json:"active_replies"`
	Interactions  []Interaction `json:"interactions"`
	EventCursor   string        `json:"event_cursor"`
}

// MessagePage is one page of an agent's history, in send order.
type MessagePage struct {
	Items      []Message `json:"items"`
	NextCursor *string   `json:"next_cursor" doc:"The next (older) page; null on the first message."`
}

// Sent is a user message and the reply that will answer it.
type Sent struct {
	Message Message `json:"message"`
	Reply   Message `json:"reply"`
}

// Stream events' payloads.

type AgentUpdated struct {
	Agent Agent `json:"agent"`
}

type AgentDeleted struct {
	AgentID string `json:"agent_id"`
}

type MessageUpdated struct {
	Message Message `json:"message"`
}

type InteractionUpdated struct {
	Interaction Interaction `json:"interaction"`
}

func (a *AgentRecord) public() Agent {
	bundles := a.Bundles
	if bundles == nil {
		bundles = []string{}
	}
	return Agent{
		ID: a.ID, Name: a.Name, Description: a.Description, Model: a.Model,
		Bundles: bundles, Status: a.ProductStatus, BuildError: a.BuildError, Revision: a.ProductRevision,
	}
}

func (m *messageRow) public() Message {
	blocks := m.Content
	if blocks == nil {
		blocks = []Block{}
	}
	return Message{
		ID: m.ID, AgentID: m.AgentID, Role: m.Role, ReplyToID: m.ReplyToID,
		Status: m.Status, Revision: m.Revision, Blocks: blocks, Failure: m.Failure,
		CreatedAt: jsontime.From(m.CreatedAt),
	}
}

func (i *interactionRow) public() Interaction {
	options := i.Options
	if options == nil {
		options = []InteractionOption{}
	}
	var chosen *string
	if i.Answer != nil {
		chosen = &i.Answer.Value
	}
	return Interaction{
		ID: i.ID, AgentID: i.AgentID, MessageID: i.MessageID, Kind: i.Kind,
		Prompt: i.Prompt, Options: options, Status: i.Status, Revision: i.Revision,
		Answer: chosen, CreatedAt: jsontime.From(i.CreatedAt), UpdatedAt: jsontime.From(i.UpdatedAt),
	}
}
