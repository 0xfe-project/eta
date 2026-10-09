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
	Plugins     []string `json:"plugins" doc:"The plugins it runs with, in catalog order."`
	// starting: its environment is being prepared for the work waiting on it.
	Status   string `json:"status" enum:"idle,starting,working,waiting_for_input,unavailable" doc:"starting: its environment is being prepared for the work waiting on it."`
	Revision int64  `json:"revision"`
}

// Block is a part of a message: text, or an activity (a tool call, a
// command, a search...).
type Block struct {
	ID   string
	Type string
	Text string
	// Activities only.
	Label  string
	Status string
	Name   string
	Input  string
	Output string
}

type TextBlock struct {
	ID   string `json:"id"`
	Type string `json:"type" enum:"text"`
	Text string `json:"text"`
}

type ActivityBlock struct {
	ID     string `json:"id"`
	Type   string `json:"type" enum:"activity"`
	Label  string `json:"label"`
	Status string `json:"status" enum:"running,completed,failed"`
	Name   string `json:"name,omitempty" doc:"The tool's own name (MCP and dynamic tools)."`
	Input  string `json:"input,omitempty"`
	Output string `json:"output,omitempty"`
}

func (b Block) MarshalJSON() ([]byte, error) {
	if b.Type == "text" {
		return json.Marshal(TextBlock{ID: b.ID, Type: b.Type, Text: b.Text})
	}
	return json.Marshal(ActivityBlock{
		ID: b.ID, Type: b.Type, Label: b.Label, Status: b.Status,
		Name: b.Name, Input: b.Input, Output: b.Output,
	})
}

func (b *Block) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID     string  `json:"id"`
		Type   string  `json:"type"`
		Text   string  `json:"text"`
		Label  string  `json:"label"`
		Status string  `json:"status"`
		Name   *string `json:"name"`
		Input  *string `json:"input"`
		Output *string `json:"output"`
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
		ID: raw.ID, Type: raw.Type, Text: raw.Text, Label: raw.Label, Status: raw.Status,
		Name: deref(raw.Name), Input: deref(raw.Input), Output: deref(raw.Output),
	}
	return nil
}

func (Block) Schema(r huma.Registry) *huma.Schema {
	text := r.Schema(reflect.TypeFor[TextBlock](), true, "")
	activity := r.Schema(reflect.TypeFor[ActivityBlock](), true, "")
	return &huma.Schema{
		OneOf: []*huma.Schema{text, activity},
		Discriminator: &huma.Discriminator{
			PropertyName: "type",
			Mapping:      map[string]string{"text": text.Ref, "activity": activity.Ref},
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
	// A steer that joined the running turn; false when it waits like any
	// message.
	Steered bool `json:"steered" doc:"A steer that joined the running turn; false when it waits like any message."`
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
	plugins := a.Plugins
	if plugins == nil {
		plugins = []string{}
	}
	return Agent{
		ID: a.ID, Name: a.Name, Description: a.Description, Model: a.Model,
		Plugins: plugins, Status: a.ProductStatus, Revision: a.ProductRevision,
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
