// Package control operates agents' runtimes (docs/architecture/chat-runtime.md).
// Every agent has one long-lived container, built from its bundles, with
// its state on its own volume. The controller keeps that container in step with
// the agent, delivers the agent's waiting commands to its runtime's control
// API one at a time, stops what the user stopped, and imports what the
// runtimes report (events.go).
//
// Only the controller calls runtimes' control API (with a token derived per
// agent). It runs alone (an advisory lock), in one goroutine: a
// tick reconciles every agent, a wake-up (the API's NOTIFY, an imported
// event, a finished build) delivers one agent's work at once. Nomad, Docker
// and runtime calls happen outside database transactions; every write locks the
// conversation row first, like the API, so the controller and request
// handlers never deadlock.
package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/apps/control-plane/internal/llm"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/akarachen/axp/packages/telemetry-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Unused agent images are removed this often.
const pruneEvery = 10 * time.Minute

type Controller struct {
	DB      *pgxpool.Pool
	Chat    *chat.Service
	Bundles *bundles.Catalog
	Driver  container.Driver
	Models  llm.Catalog
	Secret  []byte
	// The plugins bundles name (the repository's plugins/).
	PluginsDir string
	// Where runtimes reach AXP's services (the runtime gateway) and NATS.
	RuntimeGatewayURL string
	NATSURL           string
	// Calls to runtimes' control API.
	HTTP *http.Client
	// Wakes the loop for an agent, when a build finishes.
	Wake func(agentID string)

	// Agents' containers and their desired configuration and image, as of
	// the last reconcile.
	runtimes map[string]container.Runtime
	desired  map[string]string
	images   map[string]string
	builds   builds
	// The config version an agent's failed build was reported at; a newer
	// one (a change, a restart) builds again.
	buildFailed map[string]int64
	// Last known context windows by model, for when the catalog is away.
	contextWindows map[string]int
	// When a stop was last sent for a command, and steers tried once.
	aborts map[string]time.Time
	steers map[string]bool
	pruned time.Time

	treesMu sync.Mutex
	trees   map[string]string

	// Failing steps: an outage is logged when it changes and now and then,
	// not every tick.
	failures telemetry.Repeats
}

// Tick reconciles every agent's container, then delivers what waits.
func (c *Controller) Tick(ctx context.Context) {
	c.failures.Log(ctx, slog.LevelError, "reconcile", c.reconcile(ctx), "Controller step failed", "step", "reconcile")
	waiting, err := pg.All[struct {
		AgentID string `db:"agent_id"`
	}](ctx, c.DB, `SELECT DISTINCT agent_id FROM agent_command WHERE status IN ('queued', 'running', 'waiting_approval')`)
	c.failures.Log(ctx, slog.LevelError, "dispatch", err, "Controller step failed", "step", "dispatch")
	for _, w := range waiting {
		c.Dispatch(ctx, w.AgentID)
	}
	if time.Since(c.pruned) > pruneEvery && c.images != nil {
		c.pruned = time.Now()
		if err := c.Driver.Prune(ctx, keep(c.images, c.builds.busy())); err != nil {
			slog.WarnContext(ctx, "Pruning agent images failed", "error", err)
		}
	}
}

func (c *Controller) inConversation(ctx context.Context, agentID string, fn func(pgx.Tx) error) error {
	return pg.InTx(ctx, c.DB, func(tx pgx.Tx) error {
		var conversationID string
		if err := tx.QueryRow(ctx, "SELECT conversation_id FROM agent WHERE id = $1", agentID).Scan(&conversationID); err != nil {
			return err
		}
		if err := chat.LockConversation(ctx, tx, conversationID); err != nil {
			return err
		}
		return fn(tx)
	})
}

// --- containers ------------------------------------------------------------------

// list reads the agents' containers.
func (c *Controller) list(ctx context.Context) error {
	list, err := c.Driver.List(ctx)
	if err != nil {
		return err
	}
	runtimes := map[string]container.Runtime{}
	for _, r := range list {
		runtimes[r.AgentID] = r
	}
	c.runtimes = runtimes
	return nil
}

func (c *Controller) reconcile(ctx context.Context) error {
	if err := c.list(ctx); err != nil {
		return err
	}
	runtimes := c.runtimes
	agents, err := pg.All[chat.AgentRecord](ctx, c.DB, "SELECT * FROM agent WHERE deleted_at IS NULL ORDER BY created_at")
	if err != nil {
		return err
	}
	all, err := c.Bundles.All(ctx, c.DB)
	if err != nil {
		return err
	}
	baseID, baseRef, err := c.Driver.Base(ctx)
	if err != nil {
		return err
	}
	configs, err := bundles.Configs(ctx, c.DB, c.Secret)
	if err != nil {
		return err
	}
	live := map[string]bool{}
	desired, images := map[string]string{}, map[string]string{}
	started := 0
	var errs []error
	for _, agent := range agents {
		live[agent.ID] = true
		img, err := c.plan(baseID, baseRef, bundles.Of(all, agent.Bundles))
		if err != nil {
			errs = append(errs, err)
			continue
		}
		images[agent.ID] = img.Tag
		ready, err := c.ensureImage(ctx, agent, baseRef, img)
		if err != nil || !ready {
			errs = append(errs, err)
			continue
		}
		spec := c.spec(ctx, agent, img, configs)
		desired[agent.ID] = spec.Config
		ran, err := c.ensureContainer(ctx, agent, spec)
		if ran {
			started++
		}
		errs = append(errs, err)
	}
	c.desired, c.images = desired, images
	for agentID := range runtimes {
		if !live[agentID] {
			errs = append(errs, c.removeRuntime(ctx, agentID))
		}
	}
	if started > 0 {
		// Their control API, now that they have an address.
		errs = append(errs, c.list(ctx))
	}
	return errors.Join(errs...)
}

// ensureImage reports whether the agent's image exists, building it when
// it does not. A build that fails makes the agent unavailable until its
// configuration changes or it is restarted.
func (c *Controller) ensureImage(ctx context.Context, agent *chat.AgentRecord, baseRef string, img image) (bool, error) {
	if ok, err := c.Driver.HasImage(ctx, img.Tag); err != nil || ok {
		return ok, err
	}
	building, failure, failed := c.builds.state(img.Tag)
	if building {
		return false, nil
	}
	if failed {
		reported, ok := c.buildFailed[agent.ID]
		switch {
		case !ok:
			if c.buildFailed == nil {
				c.buildFailed = map[string]int64{}
			}
			c.buildFailed[agent.ID] = agent.ConfigVersion
			return false, c.inConversation(ctx, agent.ID, func(tx pgx.Tx) error {
				return chat.MarkAgentFailed(ctx, tx, agent.ID, "BUILD_FAILED", &failure)
			})
		case agent.ConfigVersion <= reported:
			return false, nil
		}
		c.builds.retry(img.Tag)
	}
	delete(c.buildFailed, agent.ID)
	wake := c.Wake
	if wake == nil {
		wake = func(string) {}
	}
	c.startBuild(context.WithoutCancel(ctx), baseRef, img, func() { wake(agent.ID) })
	return false, nil
}

// ensureContainer runs the agent's container as spec says, reporting
// whether it started one.
func (c *Controller) ensureContainer(ctx context.Context, agent *chat.AgentRecord, spec container.Spec) (bool, error) {
	runtime, exists := c.runtimes[agent.ID]
	switch {
	case exists && runtime.Config == spec.Config:
		return false, nil
	case exists:
		// Its configuration changed (or it was restarted): replaced between
		// turns, so a turn never sees it change.
		if busy, err := c.busy(ctx, agent.ID); err != nil || busy {
			return false, err
		}
	}
	slog.InfoContext(ctx, "Starting an agent's runtime", "agent", agent.ID, "image", spec.Image)
	if err := c.inConversation(ctx, agent.ID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE agent SET status = 'starting', last_error_code = NULL, build_error = NULL,
			updated_at = $2 WHERE id = $1`, agent.ID, pg.Now()); err != nil {
			return err
		}
		return chat.RefreshAgentStatus(ctx, tx, agent.ID)
	}); err != nil {
		return false, err
	}
	if err := c.Driver.Run(ctx, spec); err != nil {
		return false, err
	}
	if exists {
		// What the old container had is gone with it.
		return true, c.settleLost(ctx, agent.ID)
	}
	return true, nil
}

// busy reports whether the agent's runtime has work: a command running, or
// a steer it took that the running turn has yet to hand over to.
func (c *Controller) busy(ctx context.Context, agentID string) (bool, error) {
	return pg.Exists(ctx, c.DB, `SELECT 1 FROM agent_command WHERE agent_id = $1
		AND (status IN ('running', 'waiting_approval') OR (status = 'queued' AND delivered_at IS NOT NULL))`, agentID)
}

// settleLost finishes what the agent's runtime had: it never reports it.
func (c *Controller) settleLost(ctx context.Context, agentID string) error {
	return c.inConversation(ctx, agentID, func(tx pgx.Tx) error {
		commands, err := pg.All[chat.CommandRecord](ctx, tx, `SELECT * FROM agent_command WHERE agent_id = $1
			AND (status IN ('running', 'waiting_approval') OR (status = 'queued' AND delivered_at IS NOT NULL)) ORDER BY agent_sequence`, agentID)
		if err != nil {
			return err
		}
		for _, command := range commands {
			outcome, code := chat.Failed, "REPLY_INTERRUPTED"
			if command.InterruptRequestedAt != nil {
				outcome, code = chat.Cancelled, ""
			}
			if _, err := chat.FinishCommand(ctx, tx, command, outcome, code); err != nil {
				return err
			}
		}
		return nil
	})
}

// removeRuntime removes a deleted agent's container; its volume stays.
func (c *Controller) removeRuntime(ctx context.Context, agentID string) error {
	if err := c.Driver.Remove(ctx, agentID); err != nil {
		return err
	}
	delete(c.runtimes, agentID)
	if known, err := pg.Exists(ctx, c.DB, "SELECT 1 FROM agent WHERE id = $1", agentID); err != nil || !known {
		return err
	}
	return c.settleLost(ctx, agentID)
}

// instructions are the agent's identity, then the user's instructions.
func instructions(agent *chat.AgentRecord) string {
	identity := "你的名字是" + agent.Name + "。"
	if agent.Description == "" {
		return identity
	}
	return identity + "\n\n" + agent.Description
}

func (c *Controller) contextWindow(ctx context.Context, model *string) string {
	if model == nil {
		return ""
	}
	if window := llm.ContextWindow(ctx, c.Models, model); window != nil && *window > 0 {
		if c.contextWindows == nil {
			c.contextWindows = map[string]int{}
		}
		c.contextWindows[*model] = *window
	}
	if window, ok := c.contextWindows[*model]; ok {
		return fmt.Sprint(window)
	}
	return ""
}

// spec is the agent's container. Its model provider is the LLM gateway,
// through the runtime gateway, with the agent's key: provider credentials
// never enter the container. Its bundles' configs do, as environment
// variables (bundles.Environment); a bundle whose config is incomplete
// keeps its plugins out (AXP_DISABLED_PLUGINS). Both are in the spec, so
// setting or clearing a config replaces the container between turns.
func (c *Controller) spec(ctx context.Context, agent *chat.AgentRecord, img image, configs map[string]map[string]string) container.Spec {
	image := img.Tag
	key := auth.AgentKey(c.Secret, agent.ID)
	model := ""
	if agent.Model != nil {
		model = *agent.Model
	}
	env, disabled := bundles.Environment(img.bundles, configs)
	if len(disabled) > 0 {
		env["AXP_DISABLED_PLUGINS"] = strings.Join(disabled, ",")
	}
	for k, v := range map[string]string{
		"AXP_AGENT_ID":      agent.ID,
		"AXP_AGENT_KEY":     key,
		"AXP_CONTROL_TOKEN": auth.ControlToken(c.Secret, agent.ID),
		"AXP_GATEWAY_URL":   c.RuntimeGatewayURL,
		"AXP_NATS_URL":      c.NATSURL,
		"AXP_LLM_BASE_URL":  strings.TrimRight(c.RuntimeGatewayURL, "/") + "/v1",
		"AXP_LLM_API_KEY":   key,
		"AXP_MODEL":         model,
		"AXP_INSTRUCTIONS":  instructions(agent),
		// A restart replaces the container even when nothing else changed.
		"AXP_CONFIG_VERSION": fmt.Sprint(agent.ConfigVersion),
	} {
		env[k] = v
	}
	if window := c.contextWindow(ctx, agent.Model); window != "" {
		env["AXP_MODEL_CONTEXT_WINDOW"] = window
	}
	h := sha256.New()
	fmt.Fprintln(h, image)
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(h, "%s=%s\n", k, env[k])
	}
	return container.Spec{AgentID: agent.ID, Image: image, Env: env, Config: hex.EncodeToString(h.Sum(nil))[:24]}
}
