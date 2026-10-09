// Package control operates agent runtimes: the controller keeps a runtime
// running for every agent with work and replaces or stops it, and the
// internal protocol is how runtimes report to the control plane.
//
// Runtimes take their work from the agent queue themselves; the controller
// starts, replaces and stops their containers. Each tick runs short
// database transactions; Docker and queue calls always happen outside them.
// Every write locks the conversation row first, like the API, so the
// controller and request handlers never deadlock.
package control

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/apps/control-plane/internal/queue"
	"github.com/akarachen/axp/apps/control-plane/internal/snapshots"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/akarachen/axp/packages/telemetry-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	StartTimeout = 120 * time.Second
	IdleAfter    = 600 * time.Second
	// A runtime that never came up is retried after this long.
	RetryAfter = 30 * time.Second
	// A runtime reports a command it took within this long, as started or
	// in its heartbeat; see Controller.busy.
	ClaimGrace = LeaseSeconds * time.Second
	// The OpenTelemetry Collector on the runtime network.
	runtimeOTLPEndpoint = "http://otel-collector:4318"
)

type Controller struct {
	DB        *pgxpool.Pool
	Chat      *chat.Service
	Queue     queue.Queue
	Driver    container.Driver
	Snapshots snapshots.Store
	Models    llm.Catalog
	Secret    []byte
	// Where runtimes reach the internal API and NATS.
	RuntimeGatewayURL string
	NATSURL           string
	CodexLaunch       string
	ID                string
	HostID            string
	// IdleAfter stops a ready runtime with no work for this long.
	IdleAfter time.Duration
	// ClaimGrace overrides the package default.
	ClaimGrace time.Duration

	// Agents with commands in the queue, as of this tick.
	waiting map[string]bool
	// Failing steps: an outage is logged when it changes and now and then,
	// not every tick.
	failures telemetry.Repeats
	// Commands taken but not reported started, by agent, and when this
	// controller first saw them taken.
	claims map[string]map[string]time.Time
}

// Tick runs every step once; a failing step is logged and the rest run.
func (c *Controller) Tick(ctx context.Context) {
	steps := []struct {
		name string
		run  func(context.Context) error
	}{
		{"look_at_queue", c.LookAtQueue},
		{"expire_runtimes", c.expireRuntimes},
		{"restart_outdated", c.restartOutdated},
		{"ensure_runtimes", c.ensureRuntimes},
		{"stop_idle", c.StopIdle},
		{"stop_deleted", c.stopDeleted},
	}
	for _, step := range steps {
		c.failures.Log(ctx, slog.LevelError, step.name, step.run(ctx), "Controller step failed", "step", step.name)
	}
}

func (c *Controller) LookAtQueue(ctx context.Context) error {
	waiting, err := c.Queue.AgentsWithCommands(ctx)
	if err != nil {
		return err
	}
	c.waiting = waiting
	return nil
}

type liveRuntime struct {
	chat.RuntimeRecord
	ConversationID     string     `db:"conversation_id"`
	AgentConfigVersion int64      `db:"agent_config_version"`
	DesiredState       string     `db:"desired_state"`
	LastActiveAt       *time.Time `db:"last_active_at"`
}

func (c *Controller) live(ctx context.Context, where string, args ...any) ([]*liveRuntime, error) {
	return pg.All[liveRuntime](ctx, c.DB, `SELECT r.*, a.conversation_id, a.config_version AS agent_config_version,
		a.desired_state, a.last_active_at
		FROM runtime_instance r JOIN agent a ON a.id = r.agent_id
		WHERE r.ended_at IS NULL`+where+` ORDER BY r.created_at`, args...)
}

func containerID(r *chat.RuntimeRecord) string {
	if r.ContainerID == nil {
		return ""
	}
	return *r.ContainerID
}

func (c *Controller) expireRuntimes(ctx context.Context) error {
	live, err := c.live(ctx, "")
	if err != nil {
		return err
	}
	now := time.Now()
	for _, instance := range live {
		var reason, status string
		switch {
		case instance.LeaseExpiresAt.Before(now):
			reason, status = "LEASE_EXPIRED", chat.RuntimeFailed
			if instance.ReadyAt == nil && instance.Status != chat.RuntimeFailed {
				// It never came up: what waits for it fails.
				if err := c.failStart(ctx, instance.ID, instance.ConversationID, "START_TIMEOUT"); err != nil {
					return err
				}
			}
		case instance.Status == chat.RuntimeFailed && c.waiting[instance.AgentID]:
			// New work arrived for a failed runtime: try a fresh one.
			reason, status = "RETRY", chat.RuntimeStopped
		default:
			continue
		}
		// Fence physically before a replacement starts.
		if err := c.Driver.Stop(ctx, containerID(&instance.RuntimeRecord)); err != nil {
			return err
		}
		if err := c.EndInstance(ctx, instance.ID, reason, status); err != nil {
			return err
		}
	}
	return nil
}

func (c *Controller) failStart(ctx context.Context, instanceID, conversationID, code string) error {
	return pg.InTx(ctx, c.DB, func(tx pgx.Tx) error {
		if err := chat.LockConversation(ctx, tx, conversationID); err != nil {
			return err
		}
		instance, err := pg.One[chat.RuntimeRecord](ctx, tx, "SELECT * FROM runtime_instance WHERE id = $1", instanceID)
		if err != nil {
			return err
		}
		return c.Chat.MarkRuntimeFailed(ctx, tx, instance, code)
	})
}

// EndInstance records that the instance's container is gone, and what that
// means for the work it had.
func (c *Controller) EndInstance(ctx context.Context, instanceID, reason, status string) error {
	instance, err := pg.One[chat.RuntimeRecord](ctx, c.DB, "SELECT * FROM runtime_instance WHERE id = $1", instanceID)
	if err != nil {
		return err
	}
	queued, err := pg.All[chat.CommandRecord](ctx, c.DB,
		"SELECT * FROM agent_command WHERE agent_id = $1 AND status = 'queued'", instance.AgentID)
	if err != nil {
		return err
	}
	taken, err := c.taken(ctx, queued)
	if err != nil {
		return err
	}
	return pg.InTx(ctx, c.DB, func(tx pgx.Tx) error {
		var conversationID string
		if err := tx.QueryRow(ctx, "SELECT conversation_id FROM agent WHERE id = $1", instance.AgentID).Scan(&conversationID); err != nil {
			return err
		}
		if err := chat.LockConversation(ctx, tx, conversationID); err != nil {
			return err
		}
		var ended bool
		if err := tx.QueryRow(ctx, "SELECT ended_at IS NOT NULL FROM runtime_instance WHERE id = $1", instanceID).Scan(&ended); err != nil || ended {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE runtime_instance SET ended_at = $2, status = $3, end_reason = $4 WHERE id = $1",
			instanceID, pg.Now(), status, reason); err != nil {
			return err
		}
		// Its container, and whatever ran there since the last snapshot, is
		// gone. What it took from the queue is never replayed; the rest waits
		// there for the next instance.
		commands, err := pg.All[chat.CommandRecord](ctx, tx, `SELECT * FROM agent_command
			WHERE (runtime_instance_id = $1 AND status = ANY($2)) OR id = ANY($3) ORDER BY agent_sequence`,
			instanceID, chat.ActiveCommandStatuses, taken)
		if err != nil {
			return err
		}
		for _, command := range commands {
			if command.InterruptRequestedAt != nil {
				_, err = chat.FinishCommand(ctx, tx, command, chat.Cancelled, "")
			} else {
				_, err = chat.FinishCommand(ctx, tx, command, chat.Failed, "REPLY_INTERRUPTED")
			}
			if err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE agent SET status = 'stopped', updated_at = $2
			WHERE id = $1 AND status NOT IN ('error', 'recovery_failed')`, instance.AgentID, pg.Now()); err != nil {
			return err
		}
		return chat.RefreshAgentStatus(ctx, tx, instance.AgentID)
	})
}

func (c *Controller) ensureRuntimes(ctx context.Context) error {
	waiting := make([]string, 0, len(c.waiting))
	for id := range c.waiting {
		if id, ok := pg.ParseID(id); ok {
			waiting = append(waiting, id)
		}
	}
	wanted, err := pg.All[chat.AgentRecord](ctx, c.DB, `SELECT * FROM agent
		WHERE (id = ANY($1) OR desired_state = 'running') AND deleted_at IS NULL ORDER BY created_at`, waiting)
	if err != nil {
		return err
	}
	for _, agent := range wanted {
		live, err := pg.Exists(ctx, c.DB, "SELECT 1 FROM runtime_instance WHERE agent_id = $1 AND ended_at IS NULL", agent.ID)
		if err != nil {
			return err
		}
		if live {
			continue
		}
		last, err := pg.One[chat.RuntimeRecord](ctx, c.DB, `SELECT * FROM runtime_instance WHERE agent_id = $1
			ORDER BY generation DESC LIMIT 1`, agent.ID)
		if err != nil {
			return err
		}
		if last != nil && last.Status == chat.RuntimeFailed && last.ReadyAt == nil &&
			last.EndedAt != nil && last.EndedAt.After(time.Now().Add(-RetryAfter)) {
			// It never came up: back off instead of crash-looping.
			continue
		}
		if err := c.Provision(ctx, agent.ID); err != nil {
			return err
		}
	}
	return nil
}

// Provision starts a runtime for the agent unless one is live.
func (c *Controller) Provision(ctx context.Context, agentID string) error {
	if _, err := c.DB.Exec(ctx, `INSERT INTO agent_session (agent_id, status, sdk_version, runtime_version)
		VALUES ($1, 'new', '', '') ON CONFLICT (agent_id) DO NOTHING`, agentID); err != nil {
		return err
	}
	session, err := pg.One[chat.SessionRecord](ctx, c.DB, "SELECT * FROM agent_session WHERE agent_id = $1", agentID)
	if err != nil {
		return err
	}
	// Every container starts empty; the agent's home comes from its snapshot.
	restore, err := c.Snapshots.Exists(ctx, agentID)
	if err != nil {
		return err
	}
	recovering := session.ThreadID != nil && *session.ThreadID != ""
	var agent *chat.AgentRecord
	var instance *chat.RuntimeRecord
	err = pg.InTx(ctx, c.DB, func(tx pgx.Tx) error {
		var conversationID string
		if err := tx.QueryRow(ctx, "SELECT conversation_id FROM agent WHERE id = $1", agentID).Scan(&conversationID); err != nil {
			return err
		}
		if err := chat.LockConversation(ctx, tx, conversationID); err != nil {
			return err
		}
		if agent, err = pg.One[chat.AgentRecord](ctx, tx, "SELECT * FROM agent WHERE id = $1 FOR UPDATE", agentID); err != nil {
			return err
		}
		if live, err := pg.Exists(ctx, tx, "SELECT 1 FROM runtime_instance WHERE agent_id = $1 AND ended_at IS NULL", agentID); err != nil || live {
			instance = nil
			return err
		}
		agent.Generation++
		now := pg.Now()
		instance = &chat.RuntimeRecord{
			ID: pg.NewID(), AgentID: agentID, Generation: agent.Generation, HostID: c.HostID,
			ControllerID: c.ID, Status: chat.RuntimeProvisioning, LeaseExpiresAt: now.Add(StartTimeout),
			ConfigVersion: agent.ConfigVersion, CreatedAt: now,
		}
		agentStatus := chat.AgentProvisioning
		if recovering {
			instance.Status, agentStatus = chat.RuntimeRecovering, chat.AgentRecovering
		}
		if _, err := tx.Exec(ctx, `INSERT INTO runtime_instance (id, agent_id, generation, host_id, image_digest,
			status, controller_id, lease_expires_at, config_version, last_source_seq, created_at)
			VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8, 0, $9)`,
			instance.ID, agentID, instance.Generation, c.HostID, instance.Status, c.ID,
			instance.LeaseExpiresAt, instance.ConfigVersion, now); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE agent SET generation = $2, status = $3, updated_at = $4 WHERE id = $1",
			agentID, agent.Generation, agentStatus, now); err != nil {
			return err
		}
		if recovering {
			if _, err := tx.Exec(ctx, "UPDATE agent_session SET status = 'recovering' WHERE agent_id = $1", agentID); err != nil {
				return err
			}
		}
		return chat.RefreshAgentStatus(ctx, tx, agentID)
	})
	if err != nil || instance == nil {
		return err
	}
	err = c.Queue.OpenConsumer(ctx, agentID)
	var started container.Started
	if err == nil {
		var spec container.Spec
		if spec, err = c.spec(ctx, agent, instance, session, restore); err == nil {
			started, err = c.Driver.Start(ctx, spec)
		}
	}
	if err != nil {
		slog.ErrorContext(ctx, "Failed to start runtime", "agent", agentID, "error", err)
		if err := c.failStart(ctx, instance.ID, agent.ConversationID, "START_FAILED"); err != nil {
			return err
		}
		return c.EndInstance(ctx, instance.ID, "START_FAILED", chat.RuntimeFailed)
	}
	_, err = c.DB.Exec(ctx, "UPDATE runtime_instance SET container_id = $2, image_digest = $3 WHERE id = $1",
		instance.ID, started.ContainerID, started.ImageDigest)
	return err
}

// instructions are the agent's identity, then the user's instructions.
func instructions(agent *chat.AgentRecord) string {
	identity := "你的名字是" + agent.Name + "。"
	if agent.Description == "" {
		return identity
	}
	return identity + "\n\n" + agent.Description
}

func (c *Controller) spec(ctx context.Context, agent *chat.AgentRecord, instance *chat.RuntimeRecord,
	session *chat.SessionRecord, restore bool) (container.Spec, error) {
	plugins := agent.Plugins
	if plugins == nil {
		plugins = []string{}
	}
	settings, err := json.Marshal(map[string]any{
		"model":                  agent.Model,
		"model_context_window":   llm.ContextWindow(ctx, c.Models, agent.Model),
		"developer_instructions": instructions(agent),
		"plugins":                plugins,
	})
	if err != nil {
		return container.Spec{}, err
	}
	threadID := ""
	if session.ThreadID != nil {
		threadID = *session.ThreadID
	}
	generation := fmt.Sprint(instance.Generation)
	env := map[string]string{
		"AXP_AGENT_ID":      agent.ID,
		"AXP_INSTANCE_ID":   instance.ID,
		"AXP_GENERATION":    generation,
		"AXP_RUNTIME_TOKEN": auth.RuntimeToken(c.Secret, instance.ID, instance.Generation),
		// The runtime's only route out: the internal API and, for model
		// requests, the LLM gateway. Provider credentials never enter the
		// container.
		"AXP_GATEWAY_URL": c.RuntimeGatewayURL,
		// Its work: the agent's queue.
		"AXP_NATS_URL":          c.NATSURL,
		"AXP_THREAD_ID":         threadID,
		"AXP_CODEX_SETTINGS":    string(settings),
		"AXP_CONFIG_VERSION":    fmt.Sprint(instance.ConfigVersion),
		"AXP_HEARTBEAT_SECONDS": fmt.Sprint(LeaseSeconds / 4.0),
		// The runtime and Codex export without credentials; the collector
		// holds them. Resource attributes tie records to the agent.
		"OTEL_EXPORTER_OTLP_ENDPOINT": runtimeOTLPEndpoint,
		"OTEL_SERVICE_NAME":           "agent-runtime",
		"OTEL_RESOURCE_ATTRIBUTES": resourceAttributes(
			"axp.agent.id="+agent.ID,
			"axp.runtime.instance.id="+instance.ID,
			"axp.runtime.generation="+generation,
		),
	}
	if restore {
		url, err := c.Snapshots.DownloadURL(ctx, agent.ID)
		if err != nil {
			return container.Spec{}, err
		}
		env["AXP_SNAPSHOT_URL"] = url
	}
	if c.CodexLaunch != "" {
		env["AXP_CODEX_LAUNCH"] = c.CodexLaunch
	}
	return container.Spec{
		AgentID:    agent.ID,
		InstanceID: instance.ID,
		Generation: instance.Generation,
		Name:       c.Driver.Name(fmt.Sprintf("agent-%s-g%d", agent.ID, instance.Generation)),
		Env:        env,
	}, nil
}

// taken are the queued commands no longer in the queue: the agent's runtime
// took them (only one runs per agent), and they may have started.
func (c *Controller) taken(ctx context.Context, queued []*chat.CommandRecord) ([]string, error) {
	var taken []string
	for _, command := range queued {
		waiting := false
		if command.QueueSeq != nil {
			var err error
			if waiting, err = c.Queue.Waiting(ctx, *command.QueueSeq); err != nil {
				return nil, err
			}
		}
		if !waiting {
			taken = append(taken, command.ID)
		}
	}
	return taken, nil
}

// busy reports whether the instance's agent has work: waiting in the queue,
// running, or taken by the runtime but not yet reported started. The runtime
// acks a command as it takes it, and turn.started follows only once Codex
// started the turn, so the queue and the database alone miss that window.
//
// A taken command counts until the runtime has had ClaimGrace to report it;
// from then on only while its heartbeat says busy, so a command it never
// reports does not keep it alive forever. Stopping it then fails the command
// like any taken one, never replaying it.
func (c *Controller) busy(ctx context.Context, instance *liveRuntime) (bool, error) {
	agentID := instance.AgentID
	if c.waiting[agentID] {
		return true, nil
	}
	// One read, then the queue: a command taken or started in between is
	// still seen, as taken.
	commands, err := pg.All[chat.CommandRecord](ctx, c.DB,
		"SELECT * FROM agent_command WHERE agent_id = $1 AND (status = ANY($2) OR status = 'queued')",
		agentID, chat.ActiveCommandStatuses)
	if err != nil {
		return false, err
	}
	var queued []*chat.CommandRecord
	for _, command := range commands {
		if command.Status != chat.CommandQueued {
			return true, nil
		}
		queued = append(queued, command)
	}
	// The runtime reports a turn finished before it uploads the snapshot
	// that turn left; stopping it in between would lose the turn's work.
	if uploading, err := pg.Exists(ctx, c.DB, `SELECT 1 FROM (SELECT type FROM agent_event
		WHERE runtime_instance_id = $1 AND source_seq IS NOT NULL
		AND type IN ('turn.completed', 'snapshot.saved', 'snapshot.failed')
		ORDER BY source_seq DESC LIMIT 1) last WHERE type = 'turn.completed'`, instance.ID); err != nil || uploading {
		return uploading, err
	}
	taken, err := c.taken(ctx, queued)
	if err != nil {
		return false, err
	}
	grace := c.ClaimGrace
	if grace == 0 {
		grace = ClaimGrace
	}
	now := time.Now()
	seen := map[string]time.Time{}
	busy := false
	for _, id := range taken {
		since, ok := c.claims[agentID][id]
		if !ok {
			since = now
		}
		seen[id] = since
		if now.Sub(since) < grace || instance.Status == chat.RuntimeBusy {
			busy = true
		}
	}
	if c.claims == nil {
		c.claims = map[string]map[string]time.Time{}
	}
	if len(seen) == 0 {
		delete(c.claims, agentID)
	} else {
		c.claims[agentID] = seen
	}
	return busy, nil
}

// StopIdle stops ready runtimes that have had no work for a while.
func (c *Controller) StopIdle(ctx context.Context) error {
	idleAfter := c.IdleAfter
	if idleAfter == 0 {
		idleAfter = IdleAfter
	}
	live, err := c.live(ctx, " AND r.status = 'ready'")
	if err != nil {
		return err
	}
	idleBefore := time.Now().Add(-idleAfter)
	for _, instance := range live {
		if instance.DesiredState == chat.DesiredRunning {
			continue
		}
		if busy, err := c.busy(ctx, instance); err != nil || busy {
			if err != nil {
				return err
			}
			continue
		}
		lastActive := instance.CreatedAt
		if instance.LastActiveAt != nil {
			lastActive = *instance.LastActiveAt
		}
		if lastActive.After(idleBefore) {
			continue
		}
		if err := c.Driver.Stop(ctx, containerID(&instance.RuntimeRecord)); err != nil {
			return err
		}
		if err := c.EndInstance(ctx, instance.ID, "IDLE", chat.RuntimeStopped); err != nil {
			return err
		}
	}
	return nil
}

// restartOutdated restarts runtimes started with an old configuration. Only
// between turns, so a turn never sees its configuration change; the
// replacement resumes the same thread with the new configuration.
func (c *Controller) restartOutdated(ctx context.Context) error {
	live, err := c.live(ctx, " AND r.status IN ('ready', 'busy')")
	if err != nil {
		return err
	}
	for _, instance := range live {
		if instance.ConfigVersion >= instance.AgentConfigVersion {
			continue
		}
		if busy, err := c.busy(ctx, instance); err != nil || busy {
			if err != nil {
				return err
			}
			continue
		}
		if err := c.Driver.Stop(ctx, containerID(&instance.RuntimeRecord)); err != nil {
			return err
		}
		if err := c.EndInstance(ctx, instance.ID, "CONFIG_CHANGED", chat.RuntimeStopped); err != nil {
			return err
		}
	}
	return nil
}

// stopDeleted stops runtimes of deleted agents once their interrupted work
// settles.
func (c *Controller) stopDeleted(ctx context.Context) error {
	live, err := c.live(ctx, " AND a.deleted_at IS NOT NULL")
	if err != nil {
		return err
	}
	for _, instance := range live {
		active, err := pg.Exists(ctx, c.DB, "SELECT 1 FROM agent_command WHERE agent_id = $1 AND status = ANY($2)",
			instance.AgentID, chat.ActiveCommandStatuses)
		if err != nil {
			return err
		}
		if active {
			continue
		}
		if err := c.Driver.Stop(ctx, containerID(&instance.RuntimeRecord)); err != nil {
			return err
		}
		if err := c.EndInstance(ctx, instance.ID, "DELETED", chat.RuntimeStopped); err != nil {
			return err
		}
		if err := c.Queue.Forget(ctx, instance.AgentID); err != nil {
			return err
		}
	}
	return nil
}

// HostID is this machine's name.
func HostID() string {
	name, _ := os.Hostname()
	return name
}

// resourceAttributes is OTEL_RESOURCE_ATTRIBUTES for a runtime: this
// process's, then attrs.
func resourceAttributes(attrs ...string) string {
	if own := os.Getenv("OTEL_RESOURCE_ATTRIBUTES"); own != "" {
		attrs = append([]string{own}, attrs...)
	}
	return strings.Join(attrs, ",")
}
