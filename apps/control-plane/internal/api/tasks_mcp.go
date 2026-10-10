package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The tasks plugin's MCP server: AXP agents read and write the task board.
// The runtime gateway authenticates the runtime and passes on its agent as
// X-AXP-Agent-Id (apps/gateway/runtime.caddy, /tasks).

type agentKey struct{}

type taskRef struct {
	Task string `json:"task" jsonschema:"the task's number (e.g. 12) or id"`
}

type listTasksIn struct {
	Status string `json:"status,omitempty" jsonschema:"only tasks with this status: backlog, todo, in_progress, in_review, done, blocked or cancelled"`
}

type createTaskIn struct {
	Title       string               `json:"title" jsonschema:"a short title"`
	Description string               `json:"description,omitempty" jsonschema:"what to do, in Markdown; a remote agent gets it as its brief"`
	Status      string               `json:"status,omitempty" jsonschema:"backlog, todo (default), in_progress, in_review, done, blocked or cancelled"`
	Assignee    *tasks.AssigneeInput `json:"assignee,omitempty" jsonschema:"kind none, user (the user themself) or remote (with computer_id, runtime and provider from list_assignees, and a place from list_places); none by default"`
}

type updateTaskIn struct {
	taskRef
	Title       *string              `json:"title,omitempty"`
	Description *string              `json:"description,omitempty"`
	Status      *string              `json:"status,omitempty" jsonschema:"backlog, todo, in_progress, in_review, done, blocked or cancelled"`
	Assignee    *tasks.AssigneeInput `json:"assignee,omitempty" jsonschema:"kind none, user or remote (with computer_id, runtime and provider from list_assignees, and a place from list_places)"`
}

type listPlacesIn struct {
	ComputerID string `json:"computer_id" jsonschema:"from list_assignees"`
	Runtime    string `json:"runtime" jsonschema:"paseo or herdr"`
}

type commentTaskIn struct {
	taskRef
	Body string `json:"body" jsonschema:"the comment, in Markdown"`
}

type taskOut struct {
	*tasks.TaskDetail
	Sessions []tasks.TaskSession `json:"sessions"`
}

type taskListOut struct {
	Tasks []tasks.Task `json:"tasks"`
}

type assigneesOut struct {
	Assignees []tasks.AssigneeOption `json:"assignees"`
}

// toolError is what the agent sees: the product message.
func toolError(err error) error {
	var product *apierr.Error
	if errors.As(err, &product) {
		return errors.New(product.Message)
	}
	return err
}

func tasksMCP(d *Deps) http.Handler {
	s := d.Tasks
	srv := mcp.NewServer(&mcp.Implementation{Name: "tasks"}, nil)
	agent := func(ctx context.Context) (tasks.Actor, error) {
		id, _ := ctx.Value(agentKey{}).(string)
		if parsed, ok := pg.ParseID(id); ok {
			return tasks.AgentActor(parsed), nil
		}
		return tasks.Actor{}, errors.New("the task board is only for agents")
	}
	write := func(ctx context.Context, fn func(tx pgx.Tx, by tasks.Actor) (*tasks.TaskDetail, error)) (*tasks.TaskDetail, error) {
		by, err := agent(ctx)
		if err != nil {
			return nil, err
		}
		t, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*tasks.TaskDetail, error) { return fn(tx, by) })
		return t, toolError(err)
	}

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_tasks",
		Description: "List the task board's tasks (the user's and agents'), most recently updated first.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listTasksIn) (*mcp.CallToolResult, any, error) {
		list, err := s.List(ctx, d.DB)
		if err != nil {
			return nil, nil, toolError(err)
		}
		out := &taskListOut{Tasks: []tasks.Task{}}
		for _, t := range list {
			if in.Status == "" || t.Status == in.Status {
				out.Tasks = append(out.Tasks, t)
			}
		}
		return nil, out, nil
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name: "get_task",
		Description: "One task in full: its description, its timeline (comments, status changes, runs, checkouts, pull requests), " +
			"its runs, and its sessions: the native agents on remote computers working on it, with their agenvo target and native IDs.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in taskRef) (*mcp.CallToolResult, any, error) {
		t, err := s.Get(ctx, d.DB, in.Task)
		if err != nil {
			return nil, nil, toolError(err)
		}
		sessions, err := s.Sessions(ctx, d.DB, t.ID)
		return nil, &taskOut{t, sessions}, toolError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_assignees",
		Description: "The agents on the user's remote computers a task can be assigned to: each is a computer, a runtime (paseo or herdr) and a provider (codex, claude, ...).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		options, err := s.AssigneeOptions(ctx, d.DB)
		return nil, &assigneesOut{options}, toolError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name: "list_places",
		Description: "Where on a remote computer's runtime an agent can work, read from it now: its projects (repositories a new worktree " +
			"can branch off) and its existing workspaces (with path, branch and whether they have uncommitted changes). Pick one " +
			"for the assignee's place: {kind: workspace, workspace_id} to work in an existing workspace, or {kind: worktree, " +
			"from: <project id>, branch?, base?} for a new worktree (Paseo only branches off its projects; for Herdr, from is a " +
			"workspace whose repository to branch off). Pass session for Herdr.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listPlacesIn) (*mcp.CallToolResult, any, error) {
		places, err := s.Places(ctx, d.DB, in.ComputerID, in.Runtime)
		return nil, places, toolError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name: "create_task",
		Description: "Create a task on the board. Assigned to a remote agent, it starts working on it in the task's own workspace on that " +
			"computer, and reports back as comments; assigned to the user, it waits for them.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in createTaskIn) (*mcp.CallToolResult, any, error) {
		assignee := tasks.AssigneeInput{Kind: "none"}
		if in.Assignee != nil {
			assignee = *in.Assignee
		}
		t, err := write(ctx, func(tx pgx.Tx, by tasks.Actor) (*tasks.TaskDetail, error) {
			return s.Create(ctx, tx, tasks.Input{
				Title: in.Title, Description: in.Description, Status: in.Status, Assignee: assignee,
			}, by)
		})
		return nil, t, err
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "update_task",
		Description: "Change a task's title, description, status or assignee (with its place); only the fields given change. Setting a task done archives or removes what AXP opened on the remote computer for it.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in updateTaskIn) (*mcp.CallToolResult, any, error) {
		t, err := write(ctx, func(tx pgx.Tx, by tasks.Actor) (*tasks.TaskDetail, error) {
			return s.Update(ctx, tx, in.Task, tasks.Changes{
				Title: in.Title, Description: in.Description, Status: in.Status, Assignee: in.Assignee,
			}, by)
		})
		return nil, t, err
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "comment_task",
		Description: "Comment on a task. If a remote agent works on it, it gets the comment as a follow-up and replies on the task.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in commentTaskIn) (*mcp.CallToolResult, any, error) {
		t, err := write(ctx, func(tx pgx.Tx, by tasks.Actor) (*tasks.TaskDetail, error) {
			return s.Comment(ctx, tx, in.Task, in.Body, by)
		})
		return nil, t, err
	})

	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{
		Stateless: true, JSONResponse: true,
		// Reached through the runtime gateway; the network is the trust boundary.
		DisableLocalhostProtection: true,
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), agentKey{}, r.Header.Get("X-AXP-Agent-Id"))
		handler.ServeHTTP(w, r.WithContext(ctx))
	})
}
