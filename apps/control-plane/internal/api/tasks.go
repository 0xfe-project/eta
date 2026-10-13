package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/idempotency"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
)

// The task board and remote computers: the web client's 任务 tab and the
// 远程电脑 settings.

type TaskIn struct {
	Title       string              `json:"title" minLength:"1" maxLength:"200"`
	Description string              `json:"description,omitempty" maxLength:"20000"`
	Status      string              `json:"status,omitempty" enum:"backlog,todo,in_progress,in_review,done,blocked,cancelled" default:"todo"`
	Assignee    tasks.AssigneeInput `json:"assignee"`
}

// TaskUpdateIn is a partial update: only fields that are sent change.
type TaskUpdateIn struct {
	Title       *string              `json:"title,omitempty" nullable:"true" minLength:"1" maxLength:"200"`
	Description *string              `json:"description,omitempty" nullable:"true" maxLength:"20000"`
	Status      *string              `json:"status,omitempty" nullable:"true" enum:"backlog,todo,in_progress,in_review,done,blocked,cancelled"`
	Assignee    *tasks.AssigneeInput `json:"assignee,omitempty"`
}

type CommentIn struct {
	Body string `json:"body" minLength:"1" maxLength:"20000"`
}

type TaskList struct {
	Tasks []tasks.Task `json:"tasks"`
	// Who tasks can be assigned to besides the user.
	Assignees []tasks.AssigneeOption `json:"assignees"`
}

type TaskPath struct {
	TaskID string `path:"task_id" doc:"The task's id or number."`
}

type TaskRunPath struct {
	TaskPath
	RunID string `path:"run_id"`
}

type RunLog struct {
	Entries []tasks.LogEntry `json:"entries"`
	Older   string           `json:"older,omitempty" doc:"Reads the entries before these (as before); absent at the start."`
}

type RunLogIn struct {
	TaskRunPath
	Before string `query:"before" doc:"A page's older: read the entries before it."`
}

type ComputerIn struct {
	Name string `json:"name" minLength:"1" maxLength:"100"`
}

type ApproveIn struct {
	Fingerprint string `json:"fingerprint" minLength:"1" maxLength:"200" doc:"The fingerprint the user compared with setup's output; only that pairing is approved."`
}

type ComputerPath struct {
	ComputerID string `path:"computer_id"`
}

// Install is a new install command for a computer.
type Install struct {
	Computer tasks.Computer `json:"computer"`
	Command  string         `json:"command" doc:"Run on the computer; works once, until enroll_expires_at."`
}

func taskOp(id, method, path, summary string, status int, tag string) huma.Operation {
	o := op(id, method, path, summary, status, tag)
	o.Errors = []int{400, 404, 409, 422, 424, 503}
	return o
}

// publicURL is the address computers reach AXP at: the configured one, or
// the one the browser used.
func publicURL(d *Deps, r *http.Request) string {
	if d.PublicURL != "" {
		return strings.TrimRight(d.PublicURL, "/")
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func installCommand(ctx context.Context, d *Deps, code string) string {
	base := d.PublicURL
	if r := httpapi.Request(ctx); r != nil {
		base = publicURL(d, r)
	}
	return "curl -fsSL " + base + "/remote/install.sh | sh -s -- " + code
}

func registerTasks(api huma.API, d *Deps) {
	s := d.Tasks

	huma.Register(api, taskOp("listTasks", http.MethodGet, "/api/v1/tasks", "Every task, and who they can be assigned to", 200, "tasks"),
		func(ctx context.Context, _ *struct{}) (*httpapi.Body[TaskList], error) {
			list, err := s.List(ctx, d.DB)
			if err != nil {
				return nil, err
			}
			assignees, err := s.AssigneeOptions(ctx, d.DB)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[TaskList]{Body: TaskList{list, assignees}}, nil
		})

	huma.Register(api, taskOp("getTask", http.MethodGet, "/api/v1/tasks/{task_id}", "A task with its timeline and runs", 200, "tasks"),
		func(ctx context.Context, in *TaskPath) (*httpapi.Body[tasks.TaskDetail], error) {
			t, err := s.Get(ctx, d.DB, in.TaskID)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[tasks.TaskDetail]{Body: *t}, nil
		})

	huma.Register(api, taskOp("createTask", http.MethodPost, "/api/v1/tasks", "Create a task", 201, "tasks"),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			Body TaskIn
		}) (*idempotency.Response[tasks.TaskDetail], error) {
			b := in.Body
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, b, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[tasks.TaskDetail], error) {
				t, err := s.Create(ctx, tx, tasks.Input{
					Title: b.Title, Description: b.Description, Status: b.Status, Assignee: b.Assignee,
				}, tasks.User)
				if err != nil {
					return idempotency.Result[tasks.TaskDetail]{}, err
				}
				return idempotency.Result[tasks.TaskDetail]{Status: 201, Body: t, Resource: t.ID}, nil
			})
		})

	huma.Register(api, taskOp("updateTask", http.MethodPatch, "/api/v1/tasks/{task_id}",
		"Change a task; only the fields sent change", 200, "tasks"),
		func(ctx context.Context, in *struct {
			TaskPath
			Body TaskUpdateIn
		}) (*httpapi.Body[tasks.TaskDetail], error) {
			b := in.Body
			t, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*tasks.TaskDetail, error) {
				return s.Update(ctx, tx, in.TaskID, tasks.Changes{
					Title: b.Title, Description: b.Description, Status: b.Status, Assignee: b.Assignee,
				}, tasks.User)
			})
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[tasks.TaskDetail]{Body: *t}, nil
		})

	huma.Register(api, taskOp("deleteTask", http.MethodDelete, "/api/v1/tasks/{task_id}", "Delete a task", 204, "tasks"),
		func(ctx context.Context, in *TaskPath) (*struct{}, error) {
			_, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (struct{}, error) { return struct{}{}, s.Delete(ctx, tx, in.TaskID) })
			return nil, err
		})

	huma.Register(api, taskOp("commentTask", http.MethodPost, "/api/v1/tasks/{task_id}/comments",
		"Comment on a task; a remote agent working on it gets the comment as a follow-up", 201, "tasks"),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			TaskPath
			Body CommentIn
		}) (*idempotency.Response[tasks.TaskDetail], error) {
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, in.Body, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[tasks.TaskDetail], error) {
				t, err := s.Comment(ctx, tx, in.TaskID, in.Body.Body, tasks.User)
				if err != nil {
					return idempotency.Result[tasks.TaskDetail]{}, err
				}
				return idempotency.Result[tasks.TaskDetail]{Status: 201, Body: t, Resource: t.ID}, nil
			})
		})

	huma.Register(api, taskOp("assistTask", http.MethodPost, "/api/v1/tasks/{task_id}/assists",
		"请 Agent 协助: another agent on the task's computer does one piece of work on it, in a place of its own, without changing the task's status or assignee", 201, "tasks"),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			TaskPath
			Body tasks.AssistInput
		}) (*idempotency.Response[tasks.TaskDetail], error) {
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, in.Body, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[tasks.TaskDetail], error) {
				t, err := s.Assist(ctx, tx, in.TaskID, in.Body, tasks.User)
				if err != nil {
					return idempotency.Result[tasks.TaskDetail]{}, err
				}
				return idempotency.Result[tasks.TaskDetail]{Status: 201, Body: t, Resource: t.ID}, nil
			})
		})

	huma.Register(api, taskOp("interruptTaskRun", http.MethodPost, "/api/v1/tasks/{task_id}/runs/{run_id}/interrupt",
		"Stop a run", 200, "tasks"),
		func(ctx context.Context, in *TaskRunPath) (*httpapi.Body[tasks.TaskDetail], error) {
			t, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*tasks.TaskDetail, error) {
				return s.Interrupt(ctx, tx, in.TaskID, in.RunID)
			})
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[tasks.TaskDetail]{Body: *t}, nil
		})

	huma.Register(api, taskOp("getTaskRunLog", http.MethodGet, "/api/v1/tasks/{task_id}/runs/{run_id}/log",
		"The remote agent's recent transcript, read from it now", 200, "tasks"),
		func(ctx context.Context, in *RunLogIn) (*httpapi.Body[RunLog], error) {
			page, err := s.Log(ctx, d.DB, in.TaskID, in.RunID, in.Before)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[RunLog]{Body: RunLog{page.Entries, page.Older}}, nil
		})

	huma.Register(api, taskOp("listComputers", http.MethodGet, "/api/v1/computers",
		"Remote computers and their runtimes on the relay", 200, "computers"),
		func(ctx context.Context, _ *struct{}) (*httpapi.Body[tasks.Computers], error) {
			list, err := s.ListComputers(ctx, d.DB)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[tasks.Computers]{Body: *list}, nil
		})

	huma.Register(api, taskOp("createComputer", http.MethodPost, "/api/v1/computers",
		"Add a computer; the answer has its one-time install command", 201, "computers"),
		func(ctx context.Context, in *struct{ Body ComputerIn }) (*idempotency.Response[Install], error) {
			e, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*tasks.Enrollment, error) { return s.CreateComputer(ctx, tx, in.Body.Name) })
			if err != nil {
				return nil, err
			}
			return &idempotency.Response[Install]{Status: 201, Body: Install{e.Computer, installCommand(ctx, d, e.Code)}}, nil
		})

	huma.Register(api, taskOp("renewComputerInstall", http.MethodPost, "/api/v1/computers/{computer_id}/install",
		"A new install command for a computer: to install it, or to update it once connected", 200, "computers"),
		func(ctx context.Context, in *ComputerPath) (*httpapi.Body[Install], error) {
			e, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*tasks.Enrollment, error) { return s.RenewEnrollment(ctx, tx, in.ComputerID) })
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[Install]{Body: Install{e.Computer, installCommand(ctx, d, e.Code)}}, nil
		})

	huma.Register(api, taskOp("listComputerPlaces", http.MethodGet, "/api/v1/computers/{computer_id}/runtimes/{kind}/places",
		"Where on a computer's runtime an agent can work: its projects and workspaces, read now", 200, "computers"),
		func(ctx context.Context, in *struct {
			ComputerPath
			Kind string `path:"kind" enum:"paseo,herdr"`
		}) (*httpapi.Body[tasks.Places], error) {
			places, err := s.Places(ctx, d.DB, in.ComputerID, in.Kind)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[tasks.Places]{Body: *places}, nil
		})

	huma.Register(api, taskOp("approveComputerRuntime", http.MethodPost, "/api/v1/computers/{computer_id}/runtimes/{kind}/approve",
		"Approve a computer's runtime on the relay, after comparing its fingerprint", 204, "computers"),
		func(ctx context.Context, in *struct {
			ComputerPath
			Kind string `path:"kind" enum:"paseo,herdr"`
			Body ApproveIn
		}) (*struct{}, error) {
			return nil, s.Approve(ctx, d.DB, in.ComputerID, in.Kind, in.Body.Fingerprint)
		})

	huma.Register(api, taskOp("deleteComputer", http.MethodDelete, "/api/v1/computers/{computer_id}",
		"Revoke a computer's access and forget it", 204, "computers"),
		func(ctx context.Context, in *ComputerPath) (*struct{}, error) {
			_, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (struct{}, error) { return struct{}{}, s.DeleteComputer(ctx, tx, in.ComputerID) })
			return nil, err
		})
}
