package api

import (
	"context"
	"net/http"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type groupKey struct{}
type groupReadIn struct {
	After  int64 `json:"after,omitempty" jsonschema:"only messages after this sequence; defaults to your last participation"`
	Before int64 `json:"before,omitempty" jsonschema:"only messages before this sequence"`
	Limit  int   `json:"limit,omitempty" jsonschema:"maximum messages, 1 to 100; default 30"`
}

func groupsMCP(d *Deps) http.Handler {
	srv := mcp.NewServer(&mcp.Implementation{Name: "groups"}, nil)
	current := func(ctx context.Context) (string, string, error) {
		group, _ := ctx.Value(groupKey{}).(string)
		agent, _ := ctx.Value(agentKey{}).(string)
		_, err := chat.CurrentCommand(ctx, d.DB, group, agent)
		return group, agent, toolError(err)
	}
	mcp.AddTool(srv, &mcp.Tool{Name: "group_info", Description: "Read the current group's name, goal, decisions and participants. The runtime gateway supplies the group; you cannot choose another context."}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		group, _, err := current(ctx)
		if err != nil {
			return nil, nil, err
		}
		g, err := d.Chat.Group(ctx, d.DB, group)
		if err != nil {
			return nil, nil, toolError(err)
		}
		all, err := d.Tasks.List(ctx, d.DB)
		if err != nil {
			return nil, nil, toolError(err)
		}
		linked := []tasks.Task{}
		for _, task := range all {
			if task.GroupID != nil && *task.GroupID == group {
				linked = append(linked, task)
			}
		}
		return nil, struct {
			*chat.Group
			Tasks []tasks.Task `json:"tasks"`
		}{g, linked}, nil
	})
	mcp.AddTool(srv, &mcp.Tool{Name: "read_group", Description: "Read this group's messages in sequence order, including other agents, system notices and task cards. By default read since your last participation. Fetch only enough context to answer the message that woke you."}, func(ctx context.Context, _ *mcp.CallToolRequest, in groupReadIn) (*mcp.CallToolResult, any, error) {
		group, agent, err := current(ctx)
		if err != nil {
			return nil, nil, err
		}
		messages, err := d.Chat.GroupMessages(ctx, d.DB, group, agent, in.After, in.Before, in.Limit, "")
		return nil, map[string]any{"messages": messages}, toolError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{Name: "search_group", Description: "Search only this group's history for relevant decisions, data or links. Use specific terms; cross-group knowledge is available through memory, not this tool."}, func(ctx context.Context, _ *mcp.CallToolRequest, in struct {
		Query string `json:"query"`
		Limit int    `json:"limit,omitempty"`
	}) (*mcp.CallToolResult, any, error) {
		group, agent, err := current(ctx)
		if err != nil {
			return nil, nil, err
		}
		messages, err := d.Chat.GroupMessages(ctx, d.DB, group, agent, 0, 0, in.Limit, in.Query)
		return nil, map[string]any{"messages": messages}, toolError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{Name: "mention", Description: "Notify another agent (exact name or id) with one self-contained request needed for the user's work. Writing @ in text does not notify. Their reply appears HERE and never wakes you back: after success continue independent work and finish; do not wait, poll, or call back merely to acknowledge or deliver an answer. Guests may be notified without joining; the user sees an invitation prompt. No self-mentions. All agents and branches together have at most FIVE wake-ups per originating user message. At the limit or after Stop All, stop the exchange and ask the user to review; never retry or evade the budget."}, func(ctx context.Context, _ *mcp.CallToolRequest, in struct {
		Agent   string `json:"agent"`
		Message string `json:"message"`
	}) (*mcp.CallToolResult, any, error) {
		group, agent, err := current(ctx)
		if err != nil {
			return nil, nil, err
		}
		result, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*chat.MentionResult, error) {
			return d.Chat.Mention(ctx, tx, group, agent, in.Agent, in.Message)
		})
		return nil, result, toolError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{Name: "update_brief", Description: "Record agreed goals and decisions in this group's brief. Only supplied fields change; a system message records the update. Do not record proposals as agreed decisions."}, func(ctx context.Context, _ *mcp.CallToolRequest, in struct {
		Goal    *string `json:"goal,omitempty"`
		Decided *string `json:"decided,omitempty"`
	}) (*mcp.CallToolResult, any, error) {
		group, _, err := current(ctx)
		if err != nil {
			return nil, nil, err
		}
		result, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*chat.Group, error) {
			return d.Chat.UpdateGroup(ctx, tx, group, chat.GroupChanges{Goal: in.Goal, Decided: in.Decided})
		})
		return nil, result, toolError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{Name: "draft_task", Description: "Propose executable work in this group as an editable task draft: title, goal, agreed decisions, acceptance criteria, and the relevant source message sequence range. This does NOT create a board task or wake an executor. The user must confirm it. Never silently create a task instead."}, func(ctx context.Context, _ *mcp.CallToolRequest, in chat.DraftTaskInput) (*mcp.CallToolResult, any, error) {
		group, agent, err := current(ctx)
		if err != nil {
			return nil, nil, err
		}
		result, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*chat.Message, error) { return d.Chat.DraftTask(ctx, tx, group, agent, in) })
		return nil, result, toolError(err)
	})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, DisableLocalhostProtection: true})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), agentKey{}, r.Header.Get("X-AXP-Agent-Id"))
		ctx = context.WithValue(ctx, groupKey{}, r.Header.Get("X-AXP-Group-Id"))
		handler.ServeHTTP(w, r.WithContext(ctx))
	})
}
