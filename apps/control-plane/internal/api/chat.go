package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/idempotency"
	"github.com/akarachen/axp/packages/service-go/pg"
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
	// Names from GET /bundles; every built-in bundle when left out.
	Bundles []string `json:"bundles,omitempty" nullable:"true" maxItems:"50" doc:"Names from GET /api/v1/bundles; every built-in bundle when left out."`
}

// AgentUpdateIn is a partial update: only fields that are sent change.
type AgentUpdateIn struct {
	Name        *string   `json:"name,omitempty" nullable:"true" minLength:"1" maxLength:"100"`
	Description *string   `json:"description,omitempty" nullable:"true" maxLength:"10000"`
	Model       *string   `json:"model,omitempty" nullable:"true" minLength:"1" maxLength:"100"`
	Bundles     *[]string `json:"bundles,omitempty" nullable:"true" maxItems:"50"`
}

type InteractionAnswerIn struct {
	Value string `json:"value" minLength:"1" maxLength:"100"`
}

type BundleCreateIn struct {
	Name        string `json:"name" minLength:"1" maxLength:"40" doc:"Lower-case letters, digits and hyphens."`
	Description string `json:"description,omitempty" maxLength:"500"`
	// Run as root when an agent's image is built; a shell script unless it
	// starts with #!.
	Script  string   `json:"script,omitempty" maxLength:"100000" doc:"Run as root when an agent's image is built; a shell script unless it starts with #!."`
	Plugins []string `json:"plugins" maxItems:"50" doc:"Names from GET /api/v1/plugins."`
}

// BundleUpdateIn is a partial update: only fields that are sent change.
type BundleUpdateIn struct {
	Description *string   `json:"description,omitempty" nullable:"true" maxLength:"500"`
	Script      *string   `json:"script,omitempty" nullable:"true" maxLength:"100000"`
	Plugins     *[]string `json:"plugins,omitempty" nullable:"true" maxItems:"50"`
}

type BundlePath struct {
	Name string `path:"name" maxLength:"40"`
}

type MessageCreateIn struct {
	// The client's id for the message, so it knows the message when it
	// arrives; a new UUID per message. Left out, the server picks one.
	ID      string `json:"id,omitempty" maxLength:"64" doc:"The client's id for the message (a UUID, new per message), so it knows the message when it arrives; left out, the server picks one."`
	AgentID string `json:"agent_id" minLength:"1" maxLength:"64"`
	// Kept verbatim so code indentation survives.
	Text string `json:"text" minLength:"1" maxLength:"10000" doc:"Kept verbatim so code indentation survives."`
	// "queue" waits for the agent's current turn; "steer" joins it.
	Mode string `json:"mode,omitempty" enum:"queue,steer" default:"queue" doc:"\"queue\" waits for the agent's current turn; \"steer\" joins it."`
}

// cleanName trims a name, which must not be blank.
func cleanName(name *string) error {
	if name == nil {
		return nil
	}
	*name = strings.TrimSpace(*name)
	if *name == "" {
		return apierr.Invalid()
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

func registerChat(api huma.API, d *Deps) {
	s := d.Chat

	huma.Register(api, op("getChat", http.MethodGet, "/api/v1/chat",
		"The chat as of an event cursor; follow it with the stream", 200, "chat"),
		func(ctx context.Context, _ *struct{}) (*httpapi.Body[chat.Snapshot], error) {
			snapshot, err := s.Snapshot(ctx, d.DB)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[chat.Snapshot]{Body: *snapshot}, nil
		})

	huma.Register(api, op("listMessages", http.MethodGet, "/api/v1/agents/{agent_id}/messages",
		"One agent's history, newest page first", 200, "chat"),
		func(ctx context.Context, in *struct {
			AgentPath
			Before string `query:"before" doc:"next_cursor of the previous page."`
			Limit  int    `query:"limit" default:"50" minimum:"1" maximum:"100"`
		}) (*httpapi.Body[chat.MessagePage], error) {
			page, err := s.History(ctx, d.DB, in.AgentID, in.Before, in.Limit)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[chat.MessagePage]{Body: *page}, nil
		})

	huma.Register(api, op("listInteractions", http.MethodGet, "/api/v1/chat/interactions",
		"Every agent's latest confirmations, newest first, answered or not", 200, "chat"),
		func(ctx context.Context, in *struct {
			Limit int `query:"limit" default:"50" minimum:"1" maximum:"200"`
		}) (*httpapi.Body[chat.InteractionList], error) {
			list, err := s.Interactions(ctx, d.DB, in.Limit)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[chat.InteractionList]{Body: *list}, nil
		})

	huma.Register(api, op("listPlugins", http.MethodGet, "/api/v1/plugins",
		"The plugins bundles add", 200, "bundles"),
		func(context.Context, *struct{}) (*httpapi.Body[[]plugins.Plugin], error) {
			return &httpapi.Body[[]plugins.Plugin]{Body: s.Bundles.Plugins.All()}, nil
		})

	huma.Register(api, op("listBundles", http.MethodGet, "/api/v1/bundles",
		"The bundles agents are built from: the built-in ones, then the user's", 200, "bundles"),
		func(ctx context.Context, _ *struct{}) (*httpapi.Body[[]bundles.Bundle], error) {
			all, err := s.Bundles.All(ctx, d.DB)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[[]bundles.Bundle]{Body: all}, nil
		})

	huma.Register(api, op("createBundle", http.MethodPost, "/api/v1/bundles", "Add a bundle", 201, "bundles"),
		func(ctx context.Context, in *struct{ Body BundleCreateIn }) (*httpapi.Body[bundles.Bundle], error) {
			b := in.Body
			bundle, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*bundles.Bundle, error) {
				return s.Bundles.Create(ctx, tx, bundles.Input{Name: &b.Name, Description: &b.Description, Script: &b.Script, Plugins: &b.Plugins})
			})
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[bundles.Bundle]{Body: *bundle}, nil
		})

	huma.Register(api, op("updateBundle", http.MethodPatch, "/api/v1/bundles/{name}",
		"Change a bundle; agents that load it are rebuilt", 200, "bundles"),
		func(ctx context.Context, in *struct {
			BundlePath
			Body BundleUpdateIn
		}) (*httpapi.Body[bundles.Bundle], error) {
			b := in.Body
			bundle, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*bundles.Bundle, error) {
				return s.Bundles.Update(ctx, tx, in.Name, bundles.Input{Description: b.Description, Script: b.Script, Plugins: b.Plugins})
			})
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[bundles.Bundle]{Body: *bundle}, nil
		})

	huma.Register(api, op("deleteBundle", http.MethodDelete, "/api/v1/bundles/{name}",
		"Remove a bundle no agent loads", 204, "bundles"),
		func(ctx context.Context, in *BundlePath) (*struct{}, error) {
			_, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (struct{}, error) {
				return struct{}{}, s.Bundles.Delete(ctx, tx, in.Name)
			})
			return nil, err
		})

	huma.Register(api, op("createAgent", http.MethodPost, "/api/v1/agents", "Create an agent", 201, "chat"),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			Body AgentCreateIn
		}) (*idempotency.Response[chat.Agent], error) {
			if err := cleanName(&in.Body.Name); err != nil {
				return nil, err
			}
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, in.Body, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[chat.Agent], error) {
				agent, err := s.CreateAgent(ctx, tx, in.Body.Name, in.Body.Description, in.Body.Model, in.Body.Bundles)
				if err != nil {
					return idempotency.Result[chat.Agent]{}, err
				}
				return idempotency.Result[chat.Agent]{Status: 201, Body: agent, Resource: agent.ID}, nil
			})
		})

	huma.Register(api, op("updateAgent", http.MethodPatch, "/api/v1/agents/{agent_id}",
		"Change an agent; only the fields sent change", 200, "chat"),
		func(ctx context.Context, in *struct {
			AgentPath
			Body AgentUpdateIn
		}) (*httpapi.Body[chat.Agent], error) {
			if err := cleanName(in.Body.Name); err != nil {
				return nil, err
			}
			agent, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*chat.Agent, error) {
				return s.UpdateAgent(ctx, tx, in.AgentID, chat.AgentChanges{
					Name: in.Body.Name, Description: in.Body.Description, Model: in.Body.Model, Bundles: in.Body.Bundles,
				})
			})
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[chat.Agent]{Body: *agent}, nil
		})

	huma.Register(api, op("deleteAgent", http.MethodDelete, "/api/v1/agents/{agent_id}",
		"Delete an agent; its messages stay in the history", 204, "chat"),
		func(ctx context.Context, in *AgentPath) (*struct{}, error) {
			_, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (struct{}, error) {
				return struct{}{}, s.DeleteAgent(ctx, tx, in.AgentID)
			})
			return nil, err
		})

	huma.Register(api, op("restartAgent", http.MethodPost, "/api/v1/agents/{agent_id}/restart",
		"Stop the agent's work and replace its container; it resumes its thread", 204, "chat"),
		func(ctx context.Context, in *AgentPath) (*struct{}, error) {
			_, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (struct{}, error) {
				return struct{}{}, s.RestartAgent(ctx, tx, in.AgentID)
			})
			return nil, err
		})

	huma.Register(api, op("sendMessage", http.MethodPost, "/api/v1/chat/messages",
		"Send a message to an agent; returns it and the reply that will answer it", 202, "chat"),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			Body MessageCreateIn
		}) (*idempotency.Response[chat.Sent], error) {
			if strings.TrimSpace(in.Body.Text) == "" {
				return nil, apierr.Invalid()
			}
			if in.Body.Mode == "" {
				in.Body.Mode = "queue"
			}
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, in.Body, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[chat.Sent], error) {
				sent, err := s.SendMessage(ctx, tx, in.Body.AgentID, in.Body.ID, in.Body.Text, in.Body.Mode == "steer")
				if err != nil {
					return idempotency.Result[chat.Sent]{}, err
				}
				return idempotency.Result[chat.Sent]{Status: 202, Body: sent, Resource: sent.Reply.ID}, nil
			})
		})

	huma.Register(api, op("compactAgent", http.MethodPost, "/api/v1/agents/{agent_id}/compact",
		"Compact the agent's context, shown as /compact", 202, "chat"),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			AgentPath
		}) (*idempotency.Response[chat.Sent], error) {
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, struct{}{}, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[chat.Sent], error) {
				sent, err := s.Compact(ctx, tx, in.AgentID)
				if err != nil {
					return idempotency.Result[chat.Sent]{}, err
				}
				return idempotency.Result[chat.Sent]{Status: 202, Body: sent, Resource: sent.Reply.ID}, nil
			})
		})

	huma.Register(api, op("stopMessage", http.MethodPost, "/api/v1/chat/messages/{message_id}/stop",
		"Stop a reply; repeating it is harmless", 200, "chat"),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			MessageID string `path:"message_id"`
		}) (*idempotency.Response[chat.Message], error) {
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, struct{}{}, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[chat.Message], error) {
				reply, err := s.StopReply(ctx, tx, in.MessageID)
				if err != nil {
					return idempotency.Result[chat.Message]{}, err
				}
				return idempotency.Result[chat.Message]{Status: 200, Body: reply, Resource: reply.ID}, nil
			})
		})

	huma.Register(api, op("answerInteraction", http.MethodPost, "/api/v1/chat/interactions/{interaction_id}/answer",
		"Answer an interaction", 202, "chat"),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			InteractionID string `path:"interaction_id"`
			Body          InteractionAnswerIn
		}) (*idempotency.Response[chat.Interaction], error) {
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, in.Body, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[chat.Interaction], error) {
				answered, err := s.AnswerInteraction(ctx, tx, in.InteractionID, in.Body.Value)
				if err != nil {
					return idempotency.Result[chat.Interaction]{}, err
				}
				return idempotency.Result[chat.Interaction]{Status: 202, Body: answered, Resource: answered.ID}, nil
			})
		})

	registerStream(api, d)
}
