package api

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/packages/service-go/pg"
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
		AgentID   string `header:"X-AXP-Agent-Id"`
		GroupID   string `header:"X-AXP-Group-Id"`
		GroupName string `header:"X-AXP-Group-Name"`
	}, error) {
		agent, err := control.AgentFor(ctx, d.DB, d.Secret, in.token(), in.Plugin)
		if err != nil {
			return nil, err
		}
		var groupID string
		err = d.DB.QueryRow(ctx, `SELECT COALESCE((SELECT c.group_id::text FROM agent_command c JOIN group_participant p ON p.group_id=c.group_id AND p.agent_id=c.agent_id WHERE c.agent_id=$1 AND c.status IN ('running','waiting_approval') AND p.removed_at IS NULL ORDER BY c.agent_sequence LIMIT 1),'')`, agent).Scan(&groupID)
		if err != nil {
			return nil, err
		}
		if groupID != "" {
			if _, ok := pg.ParseID(groupID); !ok {
				groupID = ""
			}
		}
		var groupName string
		if groupID != "" {
			if err = d.DB.QueryRow(ctx, `SELECT name FROM chat_group WHERE id=$1`, groupID).Scan(&groupName); err != nil {
				return nil, err
			}
		}
		return &struct {
			AgentID   string `header:"X-AXP-Agent-Id"`
			GroupID   string `header:"X-AXP-Group-Id"`
			GroupName string `header:"X-AXP-Group-Name"`
		}{agent, groupID, url.QueryEscape(groupName)}, nil
	})
}
