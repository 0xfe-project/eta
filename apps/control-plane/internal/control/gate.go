package control

import (
	"context"
	"errors"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// AgentFor answers the runtime gateway: which agent holds the key, and
// whether it has the route's plugin. What a plugin's routes serve only its
// agents have: removing a plugin takes its abilities away, not just its
// tools.
func AgentFor(ctx context.Context, db pg.DB, secret []byte, key, plugin string) (string, error) {
	invalid := apierr.New(403, "INVALID_AGENT_KEY", "智能体凭据无效。")
	agentID, ok := pg.ParseID(auth.AgentOf(secret, key))
	if !ok {
		return "", invalid
	}
	var enabled bool
	err := db.QueryRow(ctx, "SELECT plugins ? $2 FROM agent WHERE id = $1 AND deleted_at IS NULL", agentID, plugin).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", invalid
	}
	if err != nil {
		return "", err
	}
	if plugin != "" && !enabled {
		return "", apierr.New(403, "PLUGIN_NOT_ENABLED", "这个智能体没有启用 "+plugin+" 插件。")
	}
	return agentID, nil
}
