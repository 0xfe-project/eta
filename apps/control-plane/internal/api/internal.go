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
	}) (*struct {
		AgentID string `header:"X-AXP-Agent-Id"`
		GroupID string `header:"X-AXP-Group-Id"`
	}, error) {
		agent, err := control.AgentFor(ctx, d.DB, d.Secret, in.token(), in.Plugin)
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
		return &struct {
			AgentID string `header:"X-AXP-Agent-Id"`
			GroupID string `header:"X-AXP-Group-Id"`
		}{agent, groupID}, nil
	})
}
