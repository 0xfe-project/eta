package control

import (
	"context"
	"errors"
	"slices"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// AgentFor answers the runtime gateway: which agent holds the key, and
// whether it has the route's plugin, or loads the route's bundle (whose
// service the route reaches). What a plugin's routes serve only its agents
// have: removing a plugin takes its abilities away, not just its tools.
func AgentFor(ctx context.Context, db pg.DB, secret []byte, key, plugin, bundle string) (string, error) {
	invalid := apierr.New(403, "INVALID_AGENT_KEY", "智能体凭据无效。")
	agentID, ok := pg.ParseID(auth.AgentOf(secret, key))
	if !ok {
		return "", invalid
	}
	if bundle != "" {
		loads, err := pg.Exists(ctx, db, "SELECT 1 FROM agent WHERE id = $1 AND deleted_at IS NULL AND bundles ? $2", agentID, bundle)
		if err != nil || !loads {
			return "", errors.Join(err, apierr.New(403, "BUNDLE_NOT_LOADED", "这个智能体没有载入 "+bundle+" 环境包。"))
		}
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

// BundleFor answers the runtime gateway for a bundle's service: which
// bundle holds the token, and whether it uses what the route serves (llm,
// or another bundle's service). Nothing else is open to it.
func BundleFor(ctx context.Context, db pg.DB, catalog *bundles.Catalog, secret []byte, token, use, bundle string) (string, error) {
	name := auth.BundleOf(secret, token)
	if name == "" {
		return "", apierr.New(403, "INVALID_AGENT_KEY", "智能体凭据无效。")
	}
	all, err := catalog.All(ctx, db)
	if err != nil {
		return "", err
	}
	for _, b := range all {
		if b.Name != name || b.Service == nil {
			continue
		}
		if (use != "" && slices.Contains(b.Service.Uses, use)) || (bundle != "" && slices.Contains(b.Service.Uses, bundle)) {
			return name, nil
		}
	}
	return "", apierr.New(403, "BUNDLE_NOT_ALLOWED", "环境包 "+name+" 的服务没有声明可以使用这个接口。")
}
