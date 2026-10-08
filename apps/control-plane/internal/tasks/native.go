package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
)

// A remote agent through the relay, in each runtime's native terms. Native
// ids survive connector restarts, unlike the relay's opaque references, so
// they are what a session keeps.

// Each connector the daemon sets up has one instance, named after its kind.
func instanceFor(runtime string) string { return runtime }

// native is a session's native agent.
type native struct {
	// Paseo
	AgentID string `json:"agent_id,omitempty"`
	// Herdr
	Session     string `json:"session,omitempty"`
	Name        string `json:"name,omitempty"`
	PaneID      string `json:"pane_id,omitempty"`
	WorkspaceID string `json:"workspace_id,omitempty"`
}

// agentState is a native agent as observed now.
type agentState struct {
	// idle, working, blocked, error or gone.
	Activity string
	// The last user input it received, when the runtime knows (Paseo).
	LastInput time.Time
	// When it last finished a turn, when the runtime knows (Paseo).
	FinishedAt time.Time
	Error      string
}

// LogEntry is one item of a remote agent's transcript.
type LogEntry struct {
	Kind    string `json:"kind" enum:"user,assistant,tool,reasoning,terminal,other"`
	Text    string `json:"text"`
	Tool    string `json:"tool,omitempty"`
	Command string `json:"command,omitempty"`
	Status  string `json:"status,omitempty"`
	At      string `json:"at,omitempty"`
}

// errUnknown is a write whose outcome the relay could not confirm.
var errUnknown = errors.New("relay could not confirm the outcome")

type agents struct {
	relay relay.Relay
}

func (a agents) call(ctx context.Context, s *sessionRow, method string, params any, out any) error {
	outcome, err := a.relay.Call(ctx, s.DeviceID, s.InstanceID, method, params)
	if err != nil {
		return err
	}
	if outcome.Execution == "unknown" {
		return errUnknown
	}
	if out != nil && len(outcome.Result) > 0 {
		return json.Unmarshal(outcome.Result, out)
	}
	return nil
}

// create starts a native agent in the session's workspace, without a prompt.
func (a agents) create(ctx context.Context, s *sessionRow, title string) (native, error) {
	switch s.Runtime {
	case "paseo":
		var out struct {
			Agent struct {
				ID string `json:"id"`
			} `json:"agent"`
		}
		err := a.call(ctx, s, "paseo.agents.create", map[string]any{
			"provider": s.Provider, "cwd": s.Workspace, "title": title,
		}, &out)
		if err == nil && out.Agent.ID == "" {
			err = errors.New("Paseo returned no agent")
		}
		return native{AgentID: out.Agent.ID}, err
	case "herdr":
		sess, err := a.herdrSession(ctx, s, "")
		if err != nil {
			return native{}, err
		}
		var ws struct {
			Result struct {
				Workspace struct {
					WorkspaceID string `json:"workspace_id"`
				} `json:"workspace"`
				RootPane struct {
					PaneID string `json:"pane_id"`
				} `json:"root_pane"`
			} `json:"result"`
		}
		if err := a.call(ctx, s, "workspace.create", map[string]any{
			"session": sess.Name, "backendGeneration": sess.Generation, "cwd": s.Workspace, "label": title,
		}, &ws); err != nil {
			return native{}, err
		}
		if ws.Result.RootPane.PaneID == "" {
			return native{}, errors.New("Herdr returned no pane")
		}
		n := native{Session: sess.Name, Name: herdrName(s.ID), PaneID: ws.Result.RootPane.PaneID, WorkspaceID: ws.Result.Workspace.WorkspaceID}
		if err := a.call(ctx, s, "agent.start", map[string]any{
			"session": sess.Name, "backendGeneration": sess.Generation, "name": n.Name, "paneId": n.PaneID, "kind": s.Provider,
		}, nil); err != nil {
			return native{}, err
		}
		// Starting is asynchronous: the agent takes input once its launch
		// settles.
		for range 30 {
			agent, err := a.herdrAgent(ctx, s, n)
			if err == nil && agent != nil && !agent.LaunchPending {
				return n, nil
			}
			select {
			case <-ctx.Done():
				return n, ctx.Err()
			case <-time.After(2 * time.Second):
			}
		}
		return n, errors.New("Herdr 里的智能体没有启动起来（可能停在一个需要确认的界面，看看那台电脑上的 Herdr）")
	}
	return native{}, fmt.Errorf("unknown runtime %q", s.Runtime)
}

// herdrName is the agent's name in Herdr, unique per session.
func herdrName(sessionID string) string {
	return "axp-" + strings.ReplaceAll(sessionID, "-", "")[:12]
}

type herdrSession struct {
	Name       string
	Generation string
}

// herdrSession is the named Herdr session (the first one when name is
// empty) with its current generation, which changes when Herdr restarts.
func (a agents) herdrSession(ctx context.Context, s *sessionRow, name string) (*herdrSession, error) {
	var out struct {
		Items []struct {
			Session           string `json:"session"`
			BackendGeneration string `json:"backendGeneration"`
			Available         *bool  `json:"available"`
		} `json:"items"`
	}
	if err := a.call(ctx, s, "session.list", map[string]any{}, &out); err != nil {
		return nil, err
	}
	for _, item := range out.Items {
		if (name == "" || item.Session == name) && item.BackendGeneration != "" && (item.Available == nil || *item.Available) {
			return &herdrSession{item.Session, item.BackendGeneration}, nil
		}
	}
	return nil, errors.New("Herdr 没有在这台电脑上运行")
}

func (a agents) herdrTarget(ctx context.Context, s *sessionRow, n native) (map[string]any, error) {
	sess, err := a.herdrSession(ctx, s, n.Session)
	if err != nil {
		return nil, err
	}
	return map[string]any{"session": sess.Name, "backendGeneration": sess.Generation, "name": n.Name}, nil
}

// send hands the agent input. It returns errUnknown when delivery could not
// be confirmed; the caller checks the native state instead of resending.
func (a agents) send(ctx context.Context, s *sessionRow, n native, text string) error {
	switch s.Runtime {
	case "paseo":
		return a.call(ctx, s, "paseo.agents.send", map[string]any{"agentId": n.AgentID, "text": text}, nil)
	case "herdr":
		target, err := a.herdrTarget(ctx, s, n)
		if err != nil {
			return err
		}
		target["text"] = text
		return a.call(ctx, s, "agent.prompt", target, nil)
	}
	return fmt.Errorf("unknown runtime %q", s.Runtime)
}

func (a agents) interrupt(ctx context.Context, s *sessionRow, n native) error {
	switch s.Runtime {
	case "paseo":
		return a.call(ctx, s, "paseo.agents.cancel", map[string]any{"agentId": n.AgentID}, nil)
	case "herdr":
		target, err := a.herdrTarget(ctx, s, n)
		if err != nil {
			return err
		}
		target["keys"] = []string{"esc"}
		return a.call(ctx, s, "agent.send-keys", target, nil)
	}
	return fmt.Errorf("unknown runtime %q", s.Runtime)
}

func parseTime(s *string) time.Time {
	if s == nil {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339Nano, *s)
	return t
}

func (a agents) state(ctx context.Context, s *sessionRow, n native) (*agentState, error) {
	switch s.Runtime {
	case "paseo":
		var agent struct {
			Status             string  `json:"status"`
			LastUserMessageAt  *string `json:"lastUserMessageAt"`
			AttentionReason    *string `json:"attentionReason"`
			AttentionTimestamp *string `json:"attentionTimestamp"`
			ArchivedAt         *string `json:"archivedAt"`
			LastError          *string `json:"lastError"`
		}
		if err := a.call(ctx, s, "paseo.agents.get", map[string]any{"agentId": n.AgentID}, &agent); err != nil {
			var fault *relay.Fault
			if errors.As(err, &fault) && fault.Code == "not_found" {
				return &agentState{Activity: "gone"}, nil
			}
			return nil, err
		}
		if agent.ArchivedAt != nil || agent.Status == "closed" {
			return &agentState{Activity: "gone"}, nil
		}
		st := &agentState{LastInput: parseTime(agent.LastUserMessageAt)}
		if agent.AttentionReason != nil && (*agent.AttentionReason == "finished" || *agent.AttentionReason == "error") {
			st.FinishedAt = parseTime(agent.AttentionTimestamp)
		}
		switch agent.Status {
		case "idle":
			st.Activity = "idle"
		case "error":
			st.Activity, st.Error = "error", "Paseo 报告智能体出错"
			if agent.LastError != nil {
				st.Error = *agent.LastError
			}
		default:
			st.Activity = "working"
		}
		return st, nil
	case "herdr":
		agent, err := a.herdrAgent(ctx, s, n)
		if err != nil {
			var fault *relay.Fault
			if errors.As(err, &fault) && fault.Code == "not_found" {
				return &agentState{Activity: "gone"}, nil
			}
			return nil, err
		}
		if agent == nil {
			return &agentState{Activity: "gone"}, nil
		}
		switch agent.Status {
		case "idle", "done":
			return &agentState{Activity: "idle"}, nil
		case "blocked":
			return &agentState{Activity: "blocked"}, nil
		}
		return &agentState{Activity: "working"}, nil
	}
	return nil, fmt.Errorf("unknown runtime %q", s.Runtime)
}

// log is the agent's recent transcript, oldest first.
func (a agents) log(ctx context.Context, s *sessionRow, n native) ([]LogEntry, error) {
	switch s.Runtime {
	case "paseo":
		var out struct {
			Entries []struct {
				Timestamp string `json:"timestamp"`
				Item      struct {
					Type   string `json:"type"`
					Text   string `json:"text"`
					Name   string `json:"name"`
					Status string `json:"status"`
					Detail struct {
						Command string `json:"command"`
						Output  string `json:"output"`
					} `json:"detail"`
				} `json:"item"`
			} `json:"entries"`
		}
		if err := a.call(ctx, s, "paseo.agents.history", map[string]any{"agentId": n.AgentID, "limit": 50}, &out); err != nil {
			return nil, err
		}
		entries := []LogEntry{}
		for _, e := range out.Entries {
			entry := LogEntry{Text: e.Item.Text, At: e.Timestamp}
			switch e.Item.Type {
			case "user_message":
				entry.Kind = "user"
			case "assistant_message":
				entry.Kind = "assistant"
			case "reasoning":
				entry.Kind = "reasoning"
			case "tool_call":
				entry.Kind, entry.Tool, entry.Command, entry.Status, entry.Text = "tool", e.Item.Name, e.Item.Detail.Command, e.Item.Status, e.Item.Detail.Output
			default:
				entry.Kind = "other"
				if entry.Text == "" {
					entry.Text = e.Item.Type
				}
			}
			entries = append(entries, entry)
		}
		return entries, nil
	case "herdr":
		target, err := a.herdrTarget(ctx, s, n)
		if err != nil {
			return nil, err
		}
		target["lines"], target["source"] = 300, "recent"
		var out struct {
			Output string `json:"output"`
		}
		if err := a.call(ctx, s, "agent.read", target, &out); err != nil {
			return nil, err
		}
		return []LogEntry{{Kind: "terminal", Text: out.Output}}, nil
	}
	return nil, fmt.Errorf("unknown runtime %q", s.Runtime)
}

type herdrAgent struct {
	Status        string `json:"agent_status"`
	LaunchPending bool   `json:"launch_pending"`
}

// herdrAgent is the session's agent as Herdr sees it now.
func (a agents) herdrAgent(ctx context.Context, s *sessionRow, n native) (*herdrAgent, error) {
	target, err := a.herdrTarget(ctx, s, n)
	if err != nil {
		return nil, err
	}
	var out struct {
		Result struct {
			Agent *herdrAgent `json:"agent"`
		} `json:"result"`
	}
	if err := a.call(ctx, s, "agent.get", target, &out); err != nil {
		return nil, err
	}
	return out.Result.Agent, nil
}
