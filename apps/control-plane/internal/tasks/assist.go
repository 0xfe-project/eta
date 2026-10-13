package tasks

import (
	"context"
	"regexp"
	"strings"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// 请 Agent 协助: another agent on the task's computer does one piece of work
// on the task (a review, a test run) beside its assignee, e.g. Codex
// reviewing what Claude delivered. Its runs are the task's second lane: the
// runner moves them like the assignee's (one active at a time, never sent
// twice), but in a session and place of their own, a new worktree of the
// assignee's repository, so the assignee's session and directory are never
// taken over. Assisting changes neither the task's status nor its assignee,
// and wakes no one else: its replies are remote comments, which are never
// passed on. Asking the same agent again continues its session, so it can be
// asked about its answer.

// AssistInput is what the user asks of an assisting agent.
type AssistInput struct {
	Runtime  string `json:"runtime" enum:"paseo,herdr"`
	Provider string `json:"provider" minLength:"1" maxLength:"32"`
	Request  string `json:"request" minLength:"1" maxLength:"20000" doc:"What the agent is to do; it is told this is the user's confirmed request."`
	// The pull request to look at, at the head the user saw.
	Pull *AssistPull `json:"pull,omitempty"`
}

// AssistPull pins a delivered pull request at a commit, so the agent looks at
// what was delivered rather than whatever a local branch holds.
type AssistPull struct {
	URL     string `json:"url" minLength:"1" maxLength:"2000" doc:"One of the task's deliverables."`
	HeadSHA string `json:"head_sha,omitempty" maxLength:"40" doc:"Its head commit when the user asked; when empty the agent looks it up and says which it used."`
}

var commitSHA = regexp.MustCompile(`^[0-9a-f]{40}$`)

// Assist queues a run of another agent on the task's computer.
func (s *Service) Assist(ctx context.Context, tx pgx.Tx, ref string, in AssistInput, by Actor) (*TaskDetail, error) {
	r, err := find(ctx, tx, ref, true)
	if err != nil {
		return nil, err
	}
	if r.Assignee != "remote" {
		return nil, apierr.New(409, "TASK_NOT_REMOTE", "任务还没有指派到远程电脑。协助的 Agent 和主执行者在同一台电脑上工作：先在「指派给」里选一台电脑。")
	}
	if r.Status == StatusDone || r.Status == StatusCancelled {
		return nil, apierr.New(409, "TASK_FINISHED", "任务已经结束，它的工作位置已收尾；重新打开任务后再请 Agent 协助。")
	}
	request := strings.TrimSpace(in.Request)
	if request == "" {
		return nil, invalid("需要写下协助要求。")
	}
	available, err := pg.Exists(ctx, tx, `SELECT 1 FROM computer_runtime WHERE computer_id = $1 AND kind = $2
		AND device_id IS NOT NULL AND $3 = ANY(providers)`, *r.ComputerID, in.Runtime, in.Provider)
	if err != nil {
		return nil, err
	}
	if !available {
		return nil, invalid("这台电脑上没有可用的 " + in.Runtime + " / " + in.Provider + "。")
	}
	pull := map[string]any(nil)
	if in.Pull != nil {
		delivered, err := pg.Exists(ctx, tx, `SELECT 1 FROM task_activity WHERE task_id = $1 AND kind = 'deliverable'
			AND data->>'url' = $2`, r.ID, in.Pull.URL)
		if err != nil {
			return nil, err
		}
		if !delivered {
			return nil, invalid("这个 PR 不是这个任务的交付。")
		}
		if in.Pull.HeadSHA != "" && !commitSHA.MatchString(in.Pull.HeadSHA) {
			return nil, invalid("head SHA 无效。")
		}
		pull = map[string]any{"url": in.Pull.URL, "head_sha": in.Pull.HeadSHA}
	}
	id := pg.NewID()
	if _, err := tx.Exec(ctx, `INSERT INTO task_run (id, task_id, computer_id, runtime, provider, status, prompt, created_at, assist)
		VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, true)`,
		id, r.ID, *r.ComputerID, in.Runtime, in.Provider, assistPrompt(r, request, in.Pull), pg.Now()); err != nil {
		return nil, err
	}
	if err := record(ctx, tx, r.ID, &id, "assist", by, &request, map[string]any{
		"computer_id": *r.ComputerID, "computer_name": r.ComputerName, "runtime": in.Runtime, "provider": in.Provider, "pull": pull,
	}); err != nil {
		return nil, err
	}
	return detail(ctx, tx, r)
}
