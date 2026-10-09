// Package tasks is the task board and the remote computers that work on it
// (docs/architecture/tasks.md).
//
// A task is assigned to nobody, to the user, or to an agent on a remote
// computer (a computer, its runtime and a provider). Assigning a task to a
// remote agent, and every comment on it while it is, starts a run: one turn
// of a native agent opened in the task's workspace on that computer, through
// the agenvo relay. The agent reports back with the `axp` CLI, whose comments
// end its turn; a turn that ends without one is reminded once, then fails.
//
// Everything that happens to a task is one timeline (task_activity).
package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/jsontime"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// Statuses, as on multica's board.
const (
	StatusBacklog    = "backlog"
	StatusTodo       = "todo"
	StatusInProgress = "in_progress"
	StatusInReview   = "in_review"
	StatusDone       = "done"
	StatusBlocked    = "blocked"
	StatusCancelled  = "cancelled"
)

// Run statuses. A run is active while starting or running.
const (
	RunQueued    = "queued"
	RunStarting  = "starting"
	RunRunning   = "running"
	RunCompleted = "completed"
	RunFailed    = "failed"
	RunCancelled = "cancelled"
)

// Actors on the timeline.
const (
	ActorUser   = "user"
	ActorAgent  = "agent"
	ActorRemote = "remote"
	ActorSystem = "system"
)

// Actor is who does something: the user, an AXP agent (AgentID), a remote
// agent, or AXP itself.
type Actor struct {
	Kind    string
	AgentID string
}

var (
	User   = Actor{Kind: ActorUser}
	System = Actor{Kind: ActorSystem}
	Remote = Actor{Kind: ActorRemote}
)

func AgentActor(id string) Actor { return Actor{Kind: ActorAgent, AgentID: id} }

// Service is the task board.
type Service struct {
	Relay relay.Relay
}

// --- rows ------------------------------------------------------------------------------

type taskRow struct {
	ID             string    `db:"id"`
	Number         int64     `db:"number"`
	Title          string    `db:"title"`
	Description    string    `db:"description"`
	Status         string    `db:"status"`
	Assignee       string    `db:"assignee"`
	ComputerID     *string   `db:"computer_id"`
	Runtime        *string   `db:"runtime"`
	Provider       *string   `db:"provider"`
	Place          *Place    `db:"place"`
	CreatedByAgent *string   `db:"created_by_agent"`
	CreatedAt      time.Time `db:"created_at"`
	UpdatedAt      time.Time `db:"updated_at"`
	// Joined.
	ComputerName *string `db:"computer_name"`
	AgentName    *string `db:"agent_name"`
	RunStatus    *string `db:"run_status"`
	Comments     int64   `db:"comments"`
}

const taskSelect = `SELECT t.*, c.name AS computer_name, a.name AS agent_name,
	(SELECT r.status FROM task_run r WHERE r.task_id = t.id ORDER BY r.created_at DESC LIMIT 1) AS run_status,
	(SELECT count(*) FROM task_activity x WHERE x.task_id = t.id AND x.kind = 'comment') AS comments
	FROM task t LEFT JOIN computer c ON c.id = t.computer_id LEFT JOIN agent a ON a.id = t.created_by_agent`

type activityRow struct {
	ID         string          `db:"id"`
	TaskID     string          `db:"task_id"`
	RunID      *string         `db:"run_id"`
	Kind       string          `db:"kind"`
	Actor      string          `db:"actor"`
	ActorAgent *string         `db:"actor_agent"`
	Body       *string         `db:"body"`
	Data       json.RawMessage `db:"data"`
	CreatedAt  time.Time       `db:"created_at"`
	AgentName  *string         `db:"agent_name"`
}

type runRow struct {
	ID                   string     `db:"id"`
	TaskID               string     `db:"task_id"`
	SessionID            *string    `db:"session_id"`
	ComputerID           *string    `db:"computer_id"`
	Runtime              string     `db:"runtime"`
	Provider             string     `db:"provider"`
	Status               string     `db:"status"`
	Prompt               string     `db:"prompt"`
	Workspace            *string    `db:"workspace"`
	SentAt               *time.Time `db:"sent_at"`
	NudgedAt             *time.Time `db:"nudged_at"`
	InterruptRequestedAt *time.Time `db:"interrupt_requested_at"`
	Error                *string    `db:"error"`
	CreatedAt            time.Time  `db:"created_at"`
	FinishedAt           *time.Time `db:"finished_at"`
}

type sessionRow struct {
	ID         string          `db:"id"`
	TaskID     string          `db:"task_id"`
	ComputerID string          `db:"computer_id"`
	Runtime    string          `db:"runtime"`
	Provider   string          `db:"provider"`
	DeviceID   string          `db:"device_id"`
	InstanceID string          `db:"instance_id"`
	Workspace  string          `db:"workspace"`
	Native     json.RawMessage `db:"native"`
	CreatedAt  time.Time       `db:"created_at"`
	ClosedAt   *time.Time      `db:"closed_at"`
	// What AXP opened for it is to be archived or removed.
	CleanupPending bool `db:"cleanup_pending"`
}

func (s *sessionRow) native() native {
	var n native
	_ = json.Unmarshal(s.Native, &n)
	return n
}

// --- public shapes -----------------------------------------------------------------------

// Place is where a remote agent works: an existing workspace, or a new
// worktree its runtime creates (Paseo off a project, Herdr off a
// workspace's repository).
type Place struct {
	Kind string `json:"kind" enum:"workspace,worktree"`
	// workspace: the workspace.
	WorkspaceID *string `json:"workspace_id,omitempty" nullable:"true" maxLength:"256"`
	// worktree: Paseo's project id, or the Herdr workspace to branch off.
	From   *string `json:"from,omitempty" nullable:"true" maxLength:"256" doc:"For a new worktree: Paseo's project id, or the Herdr workspace whose repository to branch off."`
	Branch *string `json:"branch,omitempty" nullable:"true" maxLength:"200" doc:"The new worktree's branch; axp/<number>-<title> when empty."`
	Base   *string `json:"base,omitempty" nullable:"true" maxLength:"200" doc:"What the new branch starts from; the repository's current branch when empty."`
	// Herdr's session.
	Session *string `json:"session,omitempty" nullable:"true" maxLength:"64"`
	// How it reads: the workspace's or the project's name.
	Name *string `json:"name,omitempty" nullable:"true" maxLength:"200"`
}

const (
	PlaceKindWorkspace = "workspace"
	PlaceKindWorktree  = "worktree"
)

type TaskAssignee struct {
	Kind         string  `json:"kind" enum:"none,user,remote"`
	ComputerID   *string `json:"computer_id" nullable:"true"`
	ComputerName *string `json:"computer_name" nullable:"true"`
	Runtime      *string `json:"runtime" nullable:"true" enum:"paseo,herdr"`
	Provider     *string `json:"provider" nullable:"true"`
	Place        *Place  `json:"place,omitempty"`
}

type TaskCreator struct {
	Kind      string  `json:"kind" enum:"user,agent"`
	AgentID   *string `json:"agent_id" nullable:"true"`
	AgentName *string `json:"agent_name" nullable:"true"`
}

type Task struct {
	ID        string        `json:"id"`
	Number    int64         `json:"number"`
	Title     string        `json:"title"`
	Status    string        `json:"status" enum:"backlog,todo,in_progress,in_review,done,blocked,cancelled"`
	Assignee  TaskAssignee  `json:"assignee"`
	CreatedBy TaskCreator   `json:"created_by"`
	RunStatus *string       `json:"run_status" nullable:"true" enum:"queued,starting,running,completed,failed,cancelled" doc:"The latest run's status."`
	Comments  int64         `json:"comments"`
	CreatedAt jsontime.Time `json:"created_at"`
	UpdatedAt jsontime.Time `json:"updated_at"`
}

type TaskActor struct {
	Kind      string  `json:"kind" enum:"user,agent,remote,system"`
	AgentID   *string `json:"agent_id" nullable:"true"`
	AgentName *string `json:"agent_name" nullable:"true"`
}

type TaskActivity struct {
	ID    string    `json:"id"`
	Kind  string    `json:"kind" doc:"created, comment, status, assignee, title, description, run_queued, run_started, run_completed, run_failed, run_cancelled, run_nudged, cleanup or deliverable."`
	Actor TaskActor `json:"actor"`
	RunID *string   `json:"run_id" nullable:"true"`
	Body  *string   `json:"body" nullable:"true"`
	// Kind-specific details, e.g. {"from", "to"} for a status change.
	Data      map[string]any `json:"data"`
	CreatedAt jsontime.Time  `json:"created_at"`
}

type TaskRun struct {
	ID           string         `json:"id"`
	Status       string         `json:"status" enum:"queued,starting,running,completed,failed,cancelled"`
	ComputerID   *string        `json:"computer_id" nullable:"true"`
	ComputerName *string        `json:"computer_name" nullable:"true"`
	Runtime      string         `json:"runtime"`
	Provider     string         `json:"provider"`
	Workspace    *string        `json:"workspace" nullable:"true"`
	Nudged       bool           `json:"nudged"`
	Error        *string        `json:"error" nullable:"true"`
	CreatedAt    jsontime.Time  `json:"created_at"`
	SentAt       *jsontime.Time `json:"sent_at" nullable:"true"`
	FinishedAt   *jsontime.Time `json:"finished_at" nullable:"true"`
}

type TaskDetail struct {
	Task
	Description string         `json:"description"`
	Activity    []TaskActivity `json:"activity"`
	Runs        []TaskRun      `json:"runs"`
}

func (r *taskRow) public() Task {
	t := Task{
		ID: r.ID, Number: r.Number, Title: r.Title, Status: r.Status,
		RunStatus: r.RunStatus, Comments: r.Comments,
		CreatedAt: jsontime.From(r.CreatedAt), UpdatedAt: jsontime.From(r.UpdatedAt),
		Assignee:  TaskAssignee{Kind: r.Assignee, ComputerID: r.ComputerID, ComputerName: r.ComputerName, Runtime: r.Runtime, Provider: r.Provider, Place: r.Place},
		CreatedBy: TaskCreator{Kind: ActorUser},
	}
	if r.CreatedByAgent != nil {
		t.CreatedBy = TaskCreator{Kind: ActorAgent, AgentID: r.CreatedByAgent, AgentName: r.AgentName}
	}
	return t
}

func (a *activityRow) public() TaskActivity {
	data := map[string]any{}
	_ = json.Unmarshal(a.Data, &data)
	return TaskActivity{
		ID: a.ID, Kind: a.Kind, RunID: a.RunID, Body: a.Body, Data: data, CreatedAt: jsontime.From(a.CreatedAt),
		Actor: TaskActor{Kind: a.Actor, AgentID: a.ActorAgent, AgentName: a.AgentName},
	}
}

// --- reads -------------------------------------------------------------------------------

// List is every task, most recently updated first.
func (s *Service) List(ctx context.Context, db pg.DB) ([]Task, error) {
	rows, err := pg.All[taskRow](ctx, db, taskSelect+" ORDER BY t.updated_at DESC")
	if err != nil {
		return nil, err
	}
	out := make([]Task, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.public())
	}
	return out, nil
}

// find is a task by its id or its number ("12" or "#12").
func find(ctx context.Context, db pg.DB, ref string, lock bool) (*taskRow, error) {
	var where string
	var arg any
	if id, ok := pg.ParseID(ref); ok {
		where, arg = "t.id = $1", id
	} else if n, ok := parseNumber(ref); ok {
		where, arg = "t.number = $1", n
	} else {
		return nil, apierr.NotFound()
	}
	sql := taskSelect + " WHERE " + where
	if lock {
		sql += " FOR UPDATE OF t"
	}
	r, err := pg.One[taskRow](ctx, db, sql, arg)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, apierr.NotFound()
	}
	return r, nil
}

func parseNumber(ref string) (int64, bool) {
	ref = strings.TrimPrefix(strings.TrimSpace(ref), "#")
	if ref == "" || len(ref) > 18 {
		return 0, false
	}
	var n int64
	for _, c := range ref {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int64(c-'0')
	}
	return n, true
}

func (s *Service) Get(ctx context.Context, db pg.DB, ref string) (*TaskDetail, error) {
	r, err := find(ctx, db, ref, false)
	if err != nil {
		return nil, err
	}
	return detail(ctx, db, r)
}

func detail(ctx context.Context, db pg.DB, r *taskRow) (*TaskDetail, error) {
	activity, err := pg.All[activityRow](ctx, db, `SELECT x.*, a.name AS agent_name FROM task_activity x
		LEFT JOIN agent a ON a.id = x.actor_agent WHERE x.task_id = $1 ORDER BY x.created_at, x.id`, r.ID)
	if err != nil {
		return nil, err
	}
	runs, err := pg.All[struct {
		runRow
		ComputerName *string `db:"computer_name"`
	}](ctx, db, `SELECT r.*, c.name AS computer_name FROM task_run r LEFT JOIN computer c ON c.id = r.computer_id
		WHERE r.task_id = $1 ORDER BY r.created_at`, r.ID)
	if err != nil {
		return nil, err
	}
	out := &TaskDetail{Task: r.public(), Description: r.Description, Activity: []TaskActivity{}, Runs: []TaskRun{}}
	for _, a := range activity {
		out.Activity = append(out.Activity, a.public())
	}
	for _, run := range runs {
		out.Runs = append(out.Runs, TaskRun{
			ID: run.ID, Status: run.Status, ComputerID: run.ComputerID, ComputerName: run.ComputerName,
			Runtime: run.Runtime, Provider: run.Provider, Workspace: run.Workspace, Nudged: run.NudgedAt != nil,
			Error: run.Error, CreatedAt: jsontime.From(run.CreatedAt), SentAt: jsontime.Ptr(run.SentAt),
			FinishedAt: jsontime.Ptr(run.FinishedAt),
		})
	}
	return out, nil
}

// --- writes (in the caller's transaction) -------------------------------------------------

func record(ctx context.Context, tx pgx.Tx, taskID string, runID *string, kind string, actor Actor, body *string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}
	encoded, _ := json.Marshal(data)
	var agent *string
	if actor.AgentID != "" {
		agent = &actor.AgentID
	}
	_, err := tx.Exec(ctx, `INSERT INTO task_activity (id, task_id, run_id, kind, actor, actor_agent, body, data, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		pg.NewID(), taskID, runID, kind, actor.Kind, agent, body, encoded, pg.Now())
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE task SET updated_at = $2 WHERE id = $1", taskID, pg.Now())
	return err
}

// AssigneeInput is who a task is for.
type AssigneeInput struct {
	Kind       string  `json:"kind" enum:"none,user,remote"`
	ComputerID *string `json:"computer_id,omitempty" nullable:"true"`
	Runtime    *string `json:"runtime,omitempty" nullable:"true" enum:"paseo,herdr"`
	Provider   *string `json:"provider,omitempty" nullable:"true" maxLength:"32"`
	// Where it works (remote only).
	Place *Place `json:"place,omitempty"`
}

func invalid(message string) error { return apierr.New(422, "VALIDATION_ERROR", message) }

// checkAssignee validates a remote assignee against the computer's runtimes.
func checkAssignee(ctx context.Context, db pg.DB, in AssigneeInput) error {
	switch in.Kind {
	case "none", "user":
		return nil
	case "remote":
	default:
		return invalid("指派对象无效。")
	}
	if in.ComputerID == nil || in.Runtime == nil || in.Provider == nil {
		return invalid("指派给远程电脑时需要选择电脑、运行时和 provider。")
	}
	if err := checkPlace(in.Place); err != nil {
		return err
	}
	computer, ok := pg.ParseID(*in.ComputerID)
	if !ok {
		return invalid("没有这台电脑。")
	}
	*in.ComputerID = computer
	ok, err := pg.Exists(ctx, db, `SELECT 1 FROM computer_runtime WHERE computer_id = $1 AND kind = $2
		AND device_id IS NOT NULL AND $3 = ANY(providers)`, computer, *in.Runtime, *in.Provider)
	if err != nil {
		return err
	}
	if !ok {
		return invalid("这台电脑上没有可用的 " + *in.Runtime + " / " + *in.Provider + "。")
	}
	return nil
}

func checkPlace(p *Place) error {
	if p == nil {
		return invalid("指派给远程电脑时需要选择工作位置：已有的工作区，或新开一个 worktree。")
	}
	switch p.Kind {
	case PlaceKindWorkspace:
		if deref(p.WorkspaceID) == "" {
			return invalid("需要选择一个工作区。")
		}
	case PlaceKindWorktree:
		if deref(p.From) == "" {
			return invalid("新开 worktree 需要选择从哪个项目开。")
		}
	default:
		return invalid("工作位置无效。")
	}
	return nil
}

// label identifies an assignee with its place: a different place is a
// different assignment.
func (a AssigneeInput) label() string {
	if a.Kind != "remote" {
		return a.Kind
	}
	place, _ := json.Marshal(a.Place)
	return *a.ComputerID + "/" + *a.Runtime + "/" + *a.Provider + "/" + string(place)
}

func assigneeOf(r *taskRow) AssigneeInput {
	return AssigneeInput{Kind: r.Assignee, ComputerID: r.ComputerID, Runtime: r.Runtime, Provider: r.Provider, Place: r.Place}
}

func assigneeData(r *taskRow) map[string]any {
	d := map[string]any{"kind": r.Assignee}
	if r.Assignee == "remote" {
		d["computer_id"], d["computer_name"], d["runtime"], d["provider"], d["place"] = *r.ComputerID, r.ComputerName, *r.Runtime, *r.Provider, r.Place
	}
	return d
}

type Input struct {
	Title       string
	Description string
	Status      string
	Assignee    AssigneeInput
}

func (s *Service) Create(ctx context.Context, tx pgx.Tx, in Input, by Actor) (*TaskDetail, error) {
	if in.Status == "" {
		in.Status = StatusTodo
	}
	if err := checkAssignee(ctx, tx, in.Assignee); err != nil {
		return nil, err
	}
	var agent *string
	if by.Kind == ActorAgent {
		agent = &by.AgentID
	}
	id, now := pg.NewID(), pg.Now()
	a := in.Assignee
	if _, err := tx.Exec(ctx, `INSERT INTO task (id, title, description, status, assignee, computer_id, runtime, provider,
		place, created_by_agent, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
		id, strings.TrimSpace(in.Title), in.Description, in.Status, a.Kind, a.ComputerID, a.Runtime, a.Provider, placeOf(a), agent, now); err != nil {
		return nil, err
	}
	if err := record(ctx, tx, id, nil, "created", by, nil, nil); err != nil {
		return nil, err
	}
	r, err := find(ctx, tx, id, true)
	if err != nil {
		return nil, err
	}
	if r.Assignee != "none" {
		if err := record(ctx, tx, id, nil, "assignee", by, nil, map[string]any{"to": assigneeData(r)}); err != nil {
			return nil, err
		}
	}
	if r.Assignee == "remote" && workable(r.Status) {
		if err := s.enqueue(ctx, tx, r, initialPrompt(r)); err != nil {
			return nil, err
		}
	}
	return detail(ctx, tx, r)
}

// workable is a status a remote agent works in.
func workable(status string) bool {
	return status != StatusBacklog && status != StatusDone && status != StatusCancelled
}

// Changes are an update's fields; nil ones stay.
type Changes struct {
	Title       *string
	Description *string
	Status      *string
	Assignee    *AssigneeInput
}

func (s *Service) Update(ctx context.Context, tx pgx.Tx, ref string, c Changes, by Actor) (*TaskDetail, error) {
	r, err := find(ctx, tx, ref, true)
	if err != nil {
		return nil, err
	}
	if c.Title != nil && strings.TrimSpace(*c.Title) != r.Title {
		title := strings.TrimSpace(*c.Title)
		if _, err := tx.Exec(ctx, "UPDATE task SET title = $2 WHERE id = $1", r.ID, title); err != nil {
			return nil, err
		}
		if err := record(ctx, tx, r.ID, nil, "title", by, nil, map[string]any{"from": r.Title, "to": title}); err != nil {
			return nil, err
		}
	}
	if c.Description != nil && *c.Description != r.Description {
		if _, err := tx.Exec(ctx, "UPDATE task SET description = $2 WHERE id = $1", r.ID, *c.Description); err != nil {
			return nil, err
		}
		if err := record(ctx, tx, r.ID, nil, "description", by, nil, nil); err != nil {
			return nil, err
		}
	}
	reassigned := false
	if c.Assignee != nil && c.Assignee.label() != assigneeOf(r).label() {
		if err := checkAssignee(ctx, tx, *c.Assignee); err != nil {
			return nil, err
		}
		a := *c.Assignee
		if _, err := tx.Exec(ctx, `UPDATE task SET assignee = $2, computer_id = $3, runtime = $4, provider = $5, place = $6 WHERE id = $1`,
			r.ID, a.Kind, a.ComputerID, a.Runtime, a.Provider, placeOf(a)); err != nil {
			return nil, err
		}
		// The previous remote agent's work stops; its session is not reused.
		if err := s.stopRuns(ctx, tx, r.ID, "任务已改派。"); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, "UPDATE task_session SET closed_at = $2 WHERE task_id = $1 AND closed_at IS NULL", r.ID, pg.Now()); err != nil {
			return nil, err
		}
		from := assigneeData(r)
		if r, err = find(ctx, tx, r.ID, true); err != nil {
			return nil, err
		}
		if err := record(ctx, tx, r.ID, nil, "assignee", by, nil, map[string]any{"from": from, "to": assigneeData(r)}); err != nil {
			return nil, err
		}
		reassigned = true
	}
	if c.Status != nil && *c.Status != r.Status {
		from := r.Status
		if err := setStatus(ctx, tx, r, *c.Status, by, nil); err != nil {
			return nil, err
		}
		if *c.Status == StatusCancelled {
			if err := s.stopRuns(ctx, tx, r.ID, "任务已取消。"); err != nil {
				return nil, err
			}
		}
		if *c.Status == StatusDone {
			if err := s.finish(ctx, tx, r.ID); err != nil {
				return nil, err
			}
		}
		// Taking a remote task out of the backlog starts it.
		if !reassigned && r.Assignee == "remote" && !workable(from) && workable(r.Status) {
			if err := s.startIfIdle(ctx, tx, r); err != nil {
				return nil, err
			}
		}
	}
	if reassigned && r.Assignee == "remote" && workable(r.Status) {
		if err := s.enqueue(ctx, tx, r, initialPrompt(r)); err != nil {
			return nil, err
		}
	}
	if r, err = find(ctx, tx, r.ID, false); err != nil {
		return nil, err
	}
	return detail(ctx, tx, r)
}

// placeOf is a remote assignee's place, for the place column.
func placeOf(a AssigneeInput) *Place {
	if a.Kind != "remote" {
		return nil
	}
	return a.Place
}

// finish stops the task's remote work and has the runner archive or remove
// what AXP opened for it.
func (s *Service) finish(ctx context.Context, tx pgx.Tx, taskID string) error {
	if err := s.stopRuns(ctx, tx, taskID, "任务已完成。"); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE task_session SET closed_at = $2, cleanup_pending = true
		WHERE task_id = $1 AND closed_at IS NULL`, taskID, pg.Now())
	return err
}

// setStatus changes the status; data adds to the record (who, for a remote
// agent).
func setStatus(ctx context.Context, tx pgx.Tx, r *taskRow, status string, by Actor, runID *string, data ...map[string]any) error {
	if status == r.Status {
		return nil
	}
	if _, err := tx.Exec(ctx, "UPDATE task SET status = $2 WHERE id = $1", r.ID, status); err != nil {
		return err
	}
	d := map[string]any{"from": r.Status, "to": status}
	for _, extra := range data {
		maps.Copy(d, extra)
	}
	r.Status = status
	return record(ctx, tx, r.ID, runID, "status", by, nil, d)
}

// startIfIdle queues the first brief when the remote agent has no run yet.
func (s *Service) startIfIdle(ctx context.Context, tx pgx.Tx, r *taskRow) error {
	started, err := pg.Exists(ctx, tx, `SELECT 1 FROM task_run WHERE task_id = $1 AND computer_id = $2
		AND runtime = $3 AND provider = $4 AND status <> 'cancelled'`, r.ID, *r.ComputerID, *r.Runtime, *r.Provider)
	if err != nil || started {
		return err
	}
	return s.enqueue(ctx, tx, r, initialPrompt(r))
}

func (s *Service) Delete(ctx context.Context, tx pgx.Tx, ref string) error {
	r, err := find(ctx, tx, ref, true)
	if err != nil {
		return err
	}
	active, err := pg.Exists(ctx, tx, `SELECT 1 FROM task_run WHERE task_id = $1 AND status IN ('starting', 'running')`, r.ID)
	if err != nil {
		return err
	}
	if active {
		return apierr.New(409, "TASK_RUNNING", "远程智能体正在处理这个任务，先停止它再删除。")
	}
	_, err = tx.Exec(ctx, "DELETE FROM task WHERE id = $1", r.ID)
	return err
}

// Comment adds a comment. On a task a remote agent works on, a comment from
// anyone else is passed on to it as a follow-up.
func (s *Service) Comment(ctx context.Context, tx pgx.Tx, ref, body string, by Actor) (*TaskDetail, error) {
	r, err := find(ctx, tx, ref, true)
	if err != nil {
		return nil, err
	}
	body = strings.TrimSpace(body)
	if body == "" {
		return nil, invalid("评论不能为空。")
	}
	if err := record(ctx, tx, r.ID, nil, "comment", by, &body, nil); err != nil {
		return nil, err
	}
	if r.Assignee == "remote" && workable(r.Status) {
		if err := s.enqueue(ctx, tx, r, followUpPrompt(r, by, body)); err != nil {
			return nil, err
		}
	}
	return detail(ctx, tx, r)
}

// --- runs ----------------------------------------------------------------------------------

// enqueue queues a run for the task's remote agent; the runner starts it
// once the task has no other active run.
func (s *Service) enqueue(ctx context.Context, tx pgx.Tx, r *taskRow, prompt string) error {
	id := pg.NewID()
	if _, err := tx.Exec(ctx, `INSERT INTO task_run (id, task_id, computer_id, runtime, provider, status, prompt, created_at)
		VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7)`, id, r.ID, *r.ComputerID, *r.Runtime, *r.Provider, prompt, pg.Now()); err != nil {
		return err
	}
	return record(ctx, tx, r.ID, &id, "run_queued", System, nil, nil)
}

// stopRuns cancels queued runs and asks the active one to stop.
func (s *Service) stopRuns(ctx context.Context, tx pgx.Tx, taskID, reason string) error {
	runs, err := pg.All[runRow](ctx, tx, `SELECT * FROM task_run WHERE task_id = $1
		AND status IN ('queued', 'starting', 'running') FOR UPDATE`, taskID)
	if err != nil {
		return err
	}
	for _, run := range runs {
		if run.Status == RunRunning {
			if _, err := tx.Exec(ctx, "UPDATE task_run SET interrupt_requested_at = $2 WHERE id = $1 AND interrupt_requested_at IS NULL",
				run.ID, pg.Now()); err != nil {
				return err
			}
			continue
		}
		if err := finishRun(ctx, tx, run, RunCancelled, &reason); err != nil {
			return err
		}
	}
	return nil
}

// Interrupt asks a running run to stop; queued and starting ones stop now.
func (s *Service) Interrupt(ctx context.Context, tx pgx.Tx, ref, runID string) (*TaskDetail, error) {
	r, err := find(ctx, tx, ref, true)
	if err != nil {
		return nil, err
	}
	id, ok := pg.ParseID(runID)
	if !ok {
		return nil, apierr.NotFound()
	}
	run, err := pg.One[runRow](ctx, tx, "SELECT * FROM task_run WHERE id = $1 AND task_id = $2 FOR UPDATE", id, r.ID)
	if err != nil {
		return nil, err
	}
	if run == nil {
		return nil, apierr.NotFound()
	}
	switch run.Status {
	case RunRunning:
		if _, err := tx.Exec(ctx, "UPDATE task_run SET interrupt_requested_at = $2 WHERE id = $1", run.ID, pg.Now()); err != nil {
			return nil, err
		}
	case RunQueued, RunStarting:
		reason := "已停止。"
		if err := finishRun(ctx, tx, run, RunCancelled, &reason); err != nil {
			return nil, err
		}
	default:
		return nil, apierr.New(409, "RUN_FINISHED", "这次运行已经结束。")
	}
	return detail(ctx, tx, r)
}

func finishRun(ctx context.Context, tx pgx.Tx, run *runRow, status string, reason *string) error {
	if _, err := tx.Exec(ctx, `UPDATE task_run SET status = $2, error = $3, finished_at = $4 WHERE id = $1`,
		run.ID, status, reason, pg.Now()); err != nil {
		return err
	}
	return record(ctx, tx, run.TaskID, &run.ID, "run_"+status, System, reason, nil)
}

// Log is a page of a run's session transcript, read live from the remote
// agent: the latest one, or the one before older (a page's Older).
func (s *Service) Log(ctx context.Context, db pg.DB, ref, runID, older string) (*LogPage, error) {
	r, err := find(ctx, db, ref, false)
	if err != nil {
		return nil, err
	}
	id, ok := pg.ParseID(runID)
	if !ok {
		return nil, apierr.NotFound()
	}
	session, err := pg.One[sessionRow](ctx, db, `SELECT s.* FROM task_session s JOIN task_run r ON r.session_id = s.id
		WHERE r.id = $1 AND r.task_id = $2`, id, r.ID)
	if err != nil {
		return nil, err
	}
	if session == nil {
		return &LogPage{Entries: []LogEntry{}}, nil
	}
	if s.Relay == nil {
		return nil, relayUnavailable()
	}
	page, err := agents{s.Relay}.log(ctx, session, session.native(), older)
	switch {
	case errors.Is(err, errBadCursor):
		return nil, apierr.Invalid()
	case errors.Is(err, errStaleCursor):
		return nil, apierr.New(409, "LOG_RESET", "远程智能体的记录重建过，请从最新的记录重新读取。")
	case tooLarge(err) || errors.Is(err, errTooManyReads):
		return nil, apierr.Upstream("REMOTE_LOG_TOO_LARGE", "远程智能体最新的记录太大，超过了中继单次 64 KiB 的上限，读不出来。")
	case err != nil:
		return nil, apierr.Upstream("REMOTE_UNAVAILABLE", "读取远程智能体的记录失败："+err.Error())
	}
	return page, nil
}

func relayUnavailable() error {
	return apierr.New(503, "RELAY_NOT_CONFIGURED", "远程执行没有配置中继。")
}
