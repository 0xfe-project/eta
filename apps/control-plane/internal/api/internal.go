package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/danielgtaylor/huma/v2"
)

// The internal API: what the runtime gateway asks on runtimes' behalf, and
// the plugins' services the control plane serves (tasks, agenvo). Runtimes
// report themselves over NATS, never here.

type Bearer struct {
	Authorization string `header:"Authorization" doc:"Bearer <the agent's key>"`
}

func (b Bearer) token() string {
	token, _ := strings.CutPrefix(b.Authorization, "Bearer ")
	return token
}

func registerInternal(api huma.API, d *Deps) {
	huma.Register(api, huma.Operation{
		OperationID: "runtimeAuth", Method: http.MethodGet, Path: "/internal/v1/runtime-auth",
		Summary:       "The runtime gateway's forward auth: which agent holds this key, and whether it has the route's plugin",
		DefaultStatus: 204, Tags: []string{"runtime gateway"}, Errors: []int{400, 403},
	}, func(ctx context.Context, in *struct {
		Bearer
		Plugin string `query:"plugin" maxLength:"64" doc:"The plugin whose route this is; the agent must have it."`
		Bundle string `query:"bundle" maxLength:"40" doc:"The bundle whose service the route reaches; the agent must load it, or the calling service use it."`
		Use    string `query:"use" enum:"llm" doc:"What the route serves, for bundles' services that declare they use it."`
		// For a bundle's service: the agent its model requests are for.
		For string `header:"X-AXP-Agent-Id" maxLength:"100"`
	}) (*runtimeAuthOut, error) {
		if strings.HasPrefix(in.token(), "bundle.") {
			name, err := control.BundleFor(ctx, d.DB, d.Chat.Bundles, d.Secret, in.token(), in.Use, in.Bundle)
			if err != nil {
				return nil, err
			}
			// A model request's usage is the agent's the service works for,
			// which it names; anywhere else it is only itself.
			agent := "bundle-" + name
			if in.Use == "llm" && in.For != "" {
				agent = in.For
			}
			return &runtimeAuthOut{AgentID: agent, Bundle: name}, nil
		}
		agent, err := control.AgentFor(ctx, d.DB, d.Secret, in.token(), in.Plugin, in.Bundle)
		if err != nil {
			return nil, err
		}
		command, err := chat.ActiveCommand(ctx, d.DB, agent)
		if err != nil {
			return nil, err
		}
		var groupID string
		if command != nil {
			groupID = command.GroupID
		}
		return &runtimeAuthOut{AgentID: agent, GroupID: groupID}, nil
	})
}

type runtimeAuthOut struct {
	AgentID string `header:"X-AXP-Agent-Id"`
	GroupID string `header:"X-AXP-Group-Id"`
	Bundle  string `header:"X-AXP-Bundle"`
}
