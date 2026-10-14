package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

const (
	// A stop is asked of the runtime again this often until its turn ends.
	abortEvery = 5 * time.Second
	// Starting a turn answers quickly; one that takes longer has an unknown
	// outcome.
	callTimeout = 60 * time.Second
)

// answer is the runtime's answer to a prompt or a steer.
type answer struct {
	Accepted bool   `json:"accepted"`
	Code     string `json:"code"`
	Reason   string `json:"reason"`
}

// errUnreachable: the call never reached the runtime, so nothing happened.
var errUnreachable = errors.New("runtime unreachable")

func (c *Controller) call(ctx context.Context, url, agentID, path string, body any) (*answer, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+auth.ControlToken(c.Secret, agentID))
	request.Header.Set("Content-Type", "application/json")
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() == nil {
			// Refused, or no route: the runtime is not there (yet).
			return nil, fmt.Errorf("%w: %v", errUnreachable, err)
		}
		return nil, err
	}
	defer response.Body.Close()
	var a answer
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusConflict {
		return nil, fmt.Errorf("%s answered %d", path, response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&a); err != nil {
		return nil, err
	}
	return &a, nil
}

// ready is the agent's runtime's control API when it can take work: its
// container is the current one and its boot has reported itself.
func (c *Controller) ready(agent *chat.AgentRecord) string {
	runtime, ok := c.runtimes[agent.ID]
	if !ok || runtime.URL == "" || runtime.Config != c.desired[agent.ID] || agent.Status != chat.AgentReady || agent.BootID == nil {
		return ""
	}
	return runtime.URL
}

// Dispatch delivers the agent's work: stops first, then a steer to the
// running turn, then the next command when nothing runs.
func (c *Controller) Dispatch(ctx context.Context, agentID string) {
	if _, ok := pg.ParseID(agentID); !ok {
		return
	}
	c.failures.Log(ctx, slog.LevelError, "dispatch "+agentID, c.dispatch(ctx, agentID),
		"Delivering an agent's work failed", "agent", agentID)
}

func (c *Controller) dispatch(ctx context.Context, agentID string) error {
	agent, err := pg.One[chat.AgentRecord](ctx, c.DB, "SELECT * FROM agent WHERE id = $1", agentID)
	if err != nil || agent == nil || agent.DeletedAt != nil {
		return err
	}
	commands, err := pg.All[chat.CommandRecord](ctx, c.DB, `SELECT * FROM agent_command
		WHERE agent_id = $1 AND status IN ('queued', 'running', 'waiting_approval') ORDER BY agent_sequence`, agentID)
	if err != nil || len(commands) == 0 {
		return err
	}
	if agent.Status == chat.AgentError && agent.LastErrorCode != nil && *agent.LastErrorCode == "BUILD_FAILED" {
		// No runtime until its image builds: what arrives fails at once.
		return c.inConversation(ctx, agentID, func(tx pgx.Tx) error {
			return chat.MarkAgentFailed(ctx, tx, agentID, "BUILD_FAILED", agent.BuildError)
		})
	}
	url := c.ready(agent)
	if url == "" {
		return nil
	}
	var running *chat.CommandRecord
	var waiting []*chat.CommandRecord
	delivered := false
	for _, command := range commands {
		active := slices.Contains(chat.ActiveCommandStatuses, command.Status)
		if command.InterruptRequestedAt != nil && (active || command.DeliveredAt != nil) {
			c.abort(ctx, url, command)
		}
		switch {
		case active:
			running = command
		case command.DeliveredAt != nil:
			delivered = true
		case command.InterruptRequestedAt == nil:
			waiting = append(waiting, command)
		}
	}
	if err := c.decide(ctx, url, agent); err != nil {
		return err
	}
	if running != nil {
		if running.CodexTurnID != nil {
			for _, command := range waiting {
				if command.Steer() && command.GroupID == running.GroupID {
					if err := c.steer(ctx, url, agent, command); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
	if delivered || len(waiting) == 0 {
		return nil
	}
	return c.prompt(ctx, url, agent, waiting[0])
}

// abort asks the runtime to stop the command, now and then until it does.
func (c *Controller) abort(ctx context.Context, url string, command *chat.CommandRecord) {
	if c.aborts == nil {
		c.aborts = map[string]time.Time{}
	}
	if time.Since(c.aborts[command.ID]) < abortEvery {
		return
	}
	c.aborts[command.ID] = time.Now()
	if _, err := c.call(ctx, url, command.AgentID, "/abort", map[string]string{"command_id": command.ID}); err != nil {
		slog.WarnContext(ctx, "Stopping a command failed", "command", command.ID, "error", err)
	}
}

// decide hands the runtime the user's decisions it has not applied yet, now
// and then until it confirms them (approval.applied).
func (c *Controller) decide(ctx context.Context, url string, agent *chat.AgentRecord) error {
	decided, err := pg.All[chat.ApprovalRecord](ctx, c.DB, `SELECT * FROM approval
		WHERE agent_id = $1 AND status = 'decided' AND boot_id = $2`, agent.ID, *agent.BootID)
	if err != nil {
		return err
	}
	if c.aborts == nil {
		c.aborts = map[string]time.Time{}
	}
	for _, approval := range decided {
		if time.Since(c.aborts["approval:"+approval.ID]) < abortEvery || approval.Decision == nil {
			continue
		}
		c.aborts["approval:"+approval.ID] = time.Now()
		if _, err := c.call(ctx, url, agent.ID, "/decide", map[string]string{
			"approval_id": approval.SDKRequestID, "decision": *approval.Decision,
		}); err != nil {
			slog.WarnContext(ctx, "Delivering a decision failed", "approval", approval.ID, "error", err)
		}
	}
	return nil
}

// steer offers the running turn a steer, once; one it refuses waits for its
// own turn.
func (c *Controller) steer(ctx context.Context, url string, agent *chat.AgentRecord, command *chat.CommandRecord) error {
	if c.steers == nil {
		c.steers = map[string]bool{}
	}
	if c.steers[command.ID] {
		return nil
	}
	c.steers[command.ID] = true
	input, err := chat.RuntimeInput(ctx, c.DB, command)
	if err != nil {
		return err
	}
	input["boot_id"] = *agent.BootID
	a, err := c.call(ctx, url, agent.ID, "/steer", input)
	if err != nil {
		delete(c.steers, command.ID)
		return err
	}
	if !a.Accepted {
		return nil
	}
	_, err = c.DB.Exec(ctx, `UPDATE agent_command SET delivered_at = $2, boot_id = $3
		WHERE id = $1 AND status = 'queued' AND delivered_at IS NULL`, command.ID, pg.Now(), *agent.BootID)
	return err
}

// prompt hands the command to the runtime as a new turn. It is recorded as
// delivered first, so a lost answer never delivers it twice.
func (c *Controller) prompt(ctx context.Context, url string, agent *chat.AgentRecord, command *chat.CommandRecord) error {
	claimed := false
	err := c.inConversation(ctx, agent.ID, func(tx pgx.Tx) error {
		if busy, err := pg.Exists(ctx, tx, `SELECT 1 FROM agent_command WHERE agent_id = $1
			AND (status IN ('running', 'waiting_approval') OR (status = 'queued' AND delivered_at IS NOT NULL))`, agent.ID); err != nil || busy {
			return err
		}
		updated, err := tx.Exec(ctx, `UPDATE agent_command SET status = 'running', delivered_at = $2, boot_id = $3
			WHERE id = $1 AND status = 'queued' AND delivered_at IS NULL AND interrupt_requested_at IS NULL`,
			command.ID, pg.Now(), *agent.BootID)
		claimed = err == nil && updated.RowsAffected() == 1
		return err
	})
	if err != nil || !claimed {
		return err
	}
	input, err := chat.RuntimeInput(ctx, c.DB, command)
	var a *answer
	if err == nil {
		input["boot_id"] = *agent.BootID
		a, err = c.call(ctx, url, agent.ID, "/prompt", input)
	}
	switch {
	case err == nil && a.Accepted:
		return nil
	case errors.Is(err, errUnreachable) || (err == nil && retryable[a.Code]):
		// Nothing ran: it waits for the runtime.
		return c.inConversation(ctx, agent.ID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE agent_command SET status = 'queued', delivered_at = NULL, boot_id = NULL
				WHERE id = $1 AND status = 'running' AND codex_turn_id IS NULL`, command.ID)
			return err
		})
	}
	code := "TURN_FAILED"
	if err != nil {
		// It may have started: never replayed, and stopped if it did.
		slog.ErrorContext(ctx, "Delivering a command failed", "command", command.ID, "error", err)
		code = "REPLY_INTERRUPTED"
		c.abort(ctx, url, command)
	} else {
		if a.Code == "RECOVERY_RESUME_FAILED" {
			code = "AGENT_RECOVERY_FAILED"
		}
		slog.WarnContext(ctx, "The runtime refused a command", "command", command.ID, "code", a.Code, "reason", a.Reason)
	}
	return c.inConversation(ctx, agent.ID, func(tx pgx.Tx) error {
		current, err := pg.One[chat.CommandRecord](ctx, tx, "SELECT * FROM agent_command WHERE id = $1", command.ID)
		if err != nil || current == nil {
			return err
		}
		_, err = chat.FinishCommand(ctx, tx, current, chat.Failed, code)
		return err
	})
}

// The runtime's refusals that leave the command for later: another turn
// runs, the prompt was meant for a boot that is gone or not yet reported,
// or Codex is restarting.
var retryable = map[string]bool{"busy": true, "wrong_boot": true, "runtime_exited": true, "disposed": true}
