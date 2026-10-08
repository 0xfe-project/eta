package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
)

// The chat API: the complete list of endpoints the web client may call for
// agents and their messages.

type AgentCreateIn struct {
	Name string `json:"name" minLength:"1" maxLength:"100"`
	// Instructions injected into the agent's context; kept verbatim.
	Description string `json:"description,omitempty" maxLength:"10000" doc:"Instructions injected into the agent's context; kept verbatim."`
	// A model id from the LLM gateway's catalog (GET /api/llm/v1/models).
	Model *string `json:"model,omitempty" nullable:"true" minLength:"1" maxLength:"100" doc:"A model id from the LLM gateway's catalog (GET /api/llm/v1/models)."`
	// Names from GET /plugins; every plugin when left out.
	Plugins []string `json:"plugins,omitempty" nullable:"true" maxItems:"50" doc:"Names from GET /api/v1/plugins; every plugin when left out."`
}

// AgentUpdateIn is a partial update: only fields that are sent change.
type AgentUpdateIn struct {
	Name        *string   `json:"name,omitempty" nullable:"true" minLength:"1" maxLength:"100"`
	Description *string   `json:"description,omitempty" nullable:"true" maxLength:"10000"`
	Model       *string   `json:"model,omitempty" nullable:"true" minLength:"1" maxLength:"100"`
	Plugins     *[]string `json:"plugins,omitempty" nullable:"true" maxItems:"50"`
}

type MessageCreateIn struct {
	AgentID string `json:"agent_id" minLength:"1" maxLength:"64"`
	// Kept verbatim so code indentation survives.
	Text string `json:"text" minLength:"1" maxLength:"10000" doc:"Kept verbatim so code indentation survives."`
	// "queue" waits for the agent's current turn; "steer" joins it.
	Mode string `json:"mode,omitempty" enum:"queue,steer" default:"queue" doc:"\"queue\" waits for the agent's current turn; \"steer\" joins it."`
}

type InteractionAnswerIn struct {
	Value string `json:"value" minLength:"1" maxLength:"100"`
}

func invalid() error { return apierr.New(422, "VALIDATION_ERROR", "请求参数无效。") }

// cleanName trims a name, which must not be blank.
func cleanName(name *string) error {
	if name == nil {
		return nil
	}
	*name = strings.TrimSpace(*name)
	if *name == "" {
		return invalid()
	}
	return nil
}

type AgentPath struct {
	AgentID string `path:"agent_id"`
}

var chatErrors = []int{400, 404, 409, 410, 422, 429}

func op(id, method, path, summary string, status int, tags ...string) huma.Operation {
	return huma.Operation{
		OperationID: id, Method: method, Path: path, Summary: summary,
		DefaultStatus: status, Tags: tags, Errors: chatErrors,
	}
}

func inTx[T any](ctx context.Context, d *Deps, fn func(pgx.Tx) (T, error)) (T, error) {
	var out T
	err := store.InTx(ctx, d.DB, func(tx pgx.Tx) error {
		var err error
		out, err = fn(tx)
		return err
	})
	return out, err
}

type body[T any] struct{ Body T }

func registerChat(api huma.API, d *Deps) {
	s := d.Chat

	huma.Register(api, op("getChat", http.MethodGet, "/api/v1/chat",
		"The chat as of an event cursor; follow it with the stream", 200, "chat"),
		func(ctx context.Context, _ *struct{}) (*body[chat.Snapshot], error) {
			snapshot, err := s.Snapshot(ctx, d.DB)
			if err != nil {
				return nil, err
			}
			return &body[chat.Snapshot]{*snapshot}, nil
		})

	huma.Register(api, op("listMessages", http.MethodGet, "/api/v1/agents/{agent_id}/messages",
		"One agent's history, newest page first", 200, "chat"),
		func(ctx context.Context, in *struct {
			AgentPath
			Before string `query:"before" doc:"next_cursor of the previous page."`
			Limit  int    `query:"limit" default:"50" minimum:"1" maximum:"100"`
		}) (*body[chat.MessagePage], error) {
			page, err := s.History(ctx, d.DB, in.AgentID, in.Before, in.Limit)
			if err != nil {
				return nil, err
			}
			return &body[chat.MessagePage]{*page}, nil
		})

	huma.Register(api, op("listPlugins", http.MethodGet, "/api/v1/plugins",
		"The runtime image's plugins agents choose from", 200, "chat"),
		func(context.Context, *struct{}) (*body[[]plugins.Plugin], error) {
			return &body[[]plugins.Plugin]{s.Plugins.All()}, nil
		})

	huma.Register(api, op("createAgent", http.MethodPost, "/api/v1/agents", "Create an agent", 201, "chat"),
		func(ctx context.Context, in *struct{ Body AgentCreateIn }) (*body[chat.Agent], error) {
			if err := cleanName(&in.Body.Name); err != nil {
				return nil, err
			}
			agent, err := inTx(ctx, d, func(tx pgx.Tx) (*chat.Agent, error) {
				return s.CreateAgent(ctx, tx, in.Body.Name, in.Body.Description, in.Body.Model, in.Body.Plugins)
			})
			if err != nil {
				return nil, err
			}
			return &body[chat.Agent]{*agent}, nil
		})

	huma.Register(api, op("updateAgent", http.MethodPatch, "/api/v1/agents/{agent_id}",
		"Change an agent; only the fields sent change", 200, "chat"),
		func(ctx context.Context, in *struct {
			AgentPath
			Body AgentUpdateIn
		}) (*body[chat.Agent], error) {
			if err := cleanName(in.Body.Name); err != nil {
				return nil, err
			}
			agent, err := inTx(ctx, d, func(tx pgx.Tx) (*chat.Agent, error) {
				return s.UpdateAgent(ctx, tx, in.AgentID, chat.AgentChanges{
					Name: in.Body.Name, Description: in.Body.Description, Model: in.Body.Model, Plugins: in.Body.Plugins,
				})
			})
			if err != nil {
				return nil, err
			}
			return &body[chat.Agent]{*agent}, nil
		})

	huma.Register(api, op("deleteAgent", http.MethodDelete, "/api/v1/agents/{agent_id}",
		"Delete an agent; its messages stay in the history", 204, "chat"),
		func(ctx context.Context, in *AgentPath) (*struct{}, error) {
			_, err := inTx(ctx, d, func(tx pgx.Tx) (struct{}, error) {
				return struct{}{}, s.DeleteAgent(ctx, tx, in.AgentID)
			})
			return nil, err
		})

	huma.Register(api, op("restartAgent", http.MethodPost, "/api/v1/agents/{agent_id}/restart",
		"Stop the agent's work and its runtime; the next message starts a fresh one", 204, "chat"),
		func(ctx context.Context, in *AgentPath) (*struct{}, error) {
			_, err := inTx(ctx, d, func(tx pgx.Tx) (struct{}, error) {
				return struct{}{}, s.RestartAgent(ctx, tx, in.AgentID)
			})
			return nil, err
		})

	huma.Register(api, op("sendMessage", http.MethodPost, "/api/v1/chat/messages",
		"Send a message to an agent; returns it and the reply that will answer it", 202, "chat"),
		func(ctx context.Context, in *struct{ Body MessageCreateIn }) (*body[chat.Sent], error) {
			if strings.TrimSpace(in.Body.Text) == "" {
				return nil, invalid()
			}
			if in.Body.Mode == "" {
				in.Body.Mode = "queue"
			}
			sent, err := inTx(ctx, d, func(tx pgx.Tx) (*chat.Sent, error) {
				return s.SendMessage(ctx, tx, in.Body.AgentID, in.Body.Text, in.Body.Mode == "steer")
			})
			if err != nil {
				return nil, err
			}
			return &body[chat.Sent]{*sent}, nil
		})

	huma.Register(api, op("compactAgent", http.MethodPost, "/api/v1/agents/{agent_id}/compact",
		"Compact the agent's context, shown as /compact", 202, "chat"),
		func(ctx context.Context, in *AgentPath) (*body[chat.Sent], error) {
			sent, err := inTx(ctx, d, func(tx pgx.Tx) (*chat.Sent, error) {
				return s.Compact(ctx, tx, in.AgentID)
			})
			if err != nil {
				return nil, err
			}
			return &body[chat.Sent]{*sent}, nil
		})

	huma.Register(api, op("stopMessage", http.MethodPost, "/api/v1/chat/messages/{message_id}/stop",
		"Stop a reply; repeating it is harmless", 200, "chat"),
		func(ctx context.Context, in *struct {
			MessageID string `path:"message_id"`
		}) (*body[chat.Message], error) {
			reply, err := inTx(ctx, d, func(tx pgx.Tx) (*chat.Message, error) {
				return s.StopReply(ctx, tx, in.MessageID)
			})
			if err != nil {
				return nil, err
			}
			return &body[chat.Message]{*reply}, nil
		})

	huma.Register(api, op("answerInteraction", http.MethodPost, "/api/v1/chat/interactions/{interaction_id}/answer",
		"Answer an interaction", 202, "chat"),
		func(ctx context.Context, in *struct {
			InteractionID string `path:"interaction_id"`
			Body          InteractionAnswerIn
		}) (*body[chat.Interaction], error) {
			answered, err := inTx(ctx, d, func(tx pgx.Tx) (*chat.Interaction, error) {
				return s.AnswerInteraction(ctx, tx, in.InteractionID, in.Body.Value)
			})
			if err != nil {
				return nil, err
			}
			return &body[chat.Interaction]{*answered}, nil
		})

	registerStream(api, d)
}
