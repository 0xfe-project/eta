package api

import (
	"context"
	"net/http"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/idempotency"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
)

type GroupPath struct {
	GroupID string `path:"group_id"`
}
type GroupCreateIn struct {
	Name    string   `json:"name" minLength:"1" maxLength:"100"`
	Goal    string   `json:"goal,omitempty" maxLength:"10000"`
	Members []string `json:"members" minItems:"1" maxItems:"50"`
}

func registerGroups(api huma.API, d *Deps) {
	huma.Register(api, op("confirmTaskDraft", http.MethodPost, "/api/v1/groups/{group_id}/drafts/{message_id}/confirm", "Confirm an edited task draft", 201, "chat"), func(ctx context.Context, in *struct {
		GroupPath
		MessageID string `path:"message_id"`
		Body      TaskIn
	}) (*httpapi.Body[tasks.TaskDetail], error) {
		result, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*tasks.TaskDetail, error) {
			draft, err := chat.TaskDraft(ctx, tx, in.GroupID, in.MessageID)
			if err != nil {
				return nil, err
			}
			if taskID, ok := draft.Data["task_id"].(string); ok {
				return d.Tasks.Get(ctx, tx, taskID)
			}
			task, err := d.Tasks.Create(ctx, tx, tasks.Input{Title: in.Body.Title, Description: in.Body.Description, Status: in.Body.Status, Assignee: in.Body.Assignee}, tasks.User)
			if err != nil {
				return nil, err
			}
			if err = chat.ConfirmTaskDraft(ctx, tx, draft.ID, task.ID); err != nil {
				return nil, err
			}
			return d.Tasks.LinkGroup(ctx, tx, task.ID, in.GroupID)
		})
		if err != nil {
			return nil, err
		}
		return &httpapi.Body[tasks.TaskDetail]{Body: *result}, nil
	})
	s := d.Chat
	huma.Register(api, op("createGroup", http.MethodPost, "/api/v1/groups", "Create a named group", 201, "chat"), func(ctx context.Context, in *struct {
		idempotency.Keyed
		Body GroupCreateIn
	}) (*idempotency.Response[chat.Group], error) {
		return idempotency.Do(ctx, d.DB, in.IdempotencyKey, in.Body, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[chat.Group], error) {
			g, err := s.CreateGroup(ctx, tx, in.Body.Name, in.Body.Goal, in.Body.Members)
			if err != nil {
				return idempotency.Result[chat.Group]{}, err
			}
			return idempotency.Result[chat.Group]{Status: 201, Body: g, Resource: g.ID}, nil
		})
	})
	huma.Register(api, op("getGroup", http.MethodGet, "/api/v1/groups/{group_id}", "A group and its participants", 200, "chat"), func(ctx context.Context, in *GroupPath) (*httpapi.Body[chat.Group], error) {
		g, err := chat.GetGroup(ctx, d.DB, in.GroupID)
		if err != nil {
			return nil, err
		}
		return &httpapi.Body[chat.Group]{Body: *g}, nil
	})
	huma.Register(api, op("updateGroup", http.MethodPatch, "/api/v1/groups/{group_id}", "Rename, archive or update a group's brief", 200, "chat"), func(ctx context.Context, in *struct {
		GroupPath
		Body chat.GroupChanges
	}) (*httpapi.Body[chat.Group], error) {
		g, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*chat.Group, error) { return s.UpdateGroup(ctx, tx, in.GroupID, in.Body) })
		if err != nil {
			return nil, err
		}
		return &httpapi.Body[chat.Group]{Body: *g}, nil
	})
	huma.Register(api, op("setGroupMember", http.MethodPut, "/api/v1/groups/{group_id}/members/{agent_id}", "Invite or remove a member", 200, "chat"), func(ctx context.Context, in *struct {
		GroupPath
		AgentPath
		Body struct {
			Member bool `json:"member"`
		}
	}) (*httpapi.Body[chat.Group], error) {
		g, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*chat.Group, error) {
			return s.SetMember(ctx, tx, in.GroupID, in.AgentID, in.Body.Member)
		})
		if err != nil {
			return nil, err
		}
		return &httpapi.Body[chat.Group]{Body: *g}, nil
	})
	huma.Register(api, op("readGroupTo", http.MethodPost, "/api/v1/groups/{group_id}/read", "Mark a group's messages as read", 200, "chat"), func(ctx context.Context, in *struct {
		GroupPath
		Body struct {
			Seq int64 `json:"seq" minimum:"0"`
		}
	}) (*httpapi.Body[chat.Group], error) {
		g, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*chat.Group, error) { return s.ReadGroupTo(ctx, tx, in.GroupID, in.Body.Seq) })
		if err != nil {
			return nil, err
		}
		return &httpapi.Body[chat.Group]{Body: *g}, nil
	})
	huma.Register(api, op("stopGroup", http.MethodPost, "/api/v1/groups/{group_id}/stop", "Stop this group's replies and mention chains", 204, "chat"), func(ctx context.Context, in *GroupPath) (*struct{}, error) {
		return nil, pg.InTx(ctx, d.DB, func(tx pgx.Tx) error { return s.StopGroup(ctx, tx, in.GroupID) })
	})
}
