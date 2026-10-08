package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
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
	Assignee    *tasks.AssigneeInput `json:"assignee,omitempty" jsonschema:"kind none, user (the user themself) or remote (with computer_id, runtime and provider from list_assignees); none by default"`
	Repository  string               `json:"repository,omitempty" jsonschema:"owner/name on GitHub that the work is in"`
}

type updateTaskIn struct {
	taskRef
	Title       *string              `json:"title,omitempty"`
	Description *string              `json:"description,omitempty"`
	Status      *string              `json:"status,omitempty" jsonschema:"backlog, todo, in_progress, in_review, done, blocked or cancelled"`
	Assignee    *tasks.AssigneeInput `json:"assignee,omitempty" jsonschema:"kind none, user or remote (with computer_id, runtime and provider from list_assignees)"`
	Repository  *string              `json:"repository,omitempty"`
}

type commentTaskIn struct {
	taskRef
	Body string `json:"body" jsonschema:"the comment, in Markdown"`
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
		if parsed, ok := chat.ParseID(id); ok {
			return tasks.AgentActor(parsed), nil
		}
		return tasks.Actor{}, errors.New("the task board is only for agents")
	}
	write := func(ctx context.Context, fn func(tx pgx.Tx, by tasks.Actor) (*tasks.TaskDetail, error)) (*tasks.TaskDetail, error) {
		by, err := agent(ctx)
		if err != nil {
			return nil, err
		}
		t, err := inTx(ctx, d, func(tx pgx.Tx) (*tasks.TaskDetail, error) { return fn(tx, by) })
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
		Name:        "get_task",
		Description: "One task in full: its description, its timeline (comments, status changes, runs, checkouts, pull requests) and its runs.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in taskRef) (*mcp.CallToolResult, any, error) {
		t, err := s.Get(ctx, d.DB, in.Task)
		return nil, t, toolError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_assignees",
		Description: "The agents on the user's remote computers a task can be assigned to: each is a computer, a runtime (paseo or herdr) and a provider (codex, claude, ...).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		options, err := s.AssigneeOptions(ctx, d.DB)
		return nil, &assigneesOut{options}, toolError(err)
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
		var repo *string
		if in.Repository != "" {
			repo = &in.Repository
		}
		t, err := write(ctx, func(tx pgx.Tx, by tasks.Actor) (*tasks.TaskDetail, error) {
			return s.Create(ctx, tx, tasks.Input{
				Title: in.Title, Description: in.Description, Status: in.Status, Assignee: assignee, Repository: repo,
			}, by)
		})
		return nil, t, err
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "update_task",
		Description: "Change a task's title, description, status, assignee or repository; only the fields given change.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in updateTaskIn) (*mcp.CallToolResult, any, error) {
		t, err := write(ctx, func(tx pgx.Tx, by tasks.Actor) (*tasks.TaskDetail, error) {
			return s.Update(ctx, tx, in.Task, tasks.Changes{
				Title: in.Title, Description: in.Description, Status: in.Status, Assignee: in.Assignee, Repository: in.Repository,
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
