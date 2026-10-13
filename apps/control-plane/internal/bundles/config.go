package bundles

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/jackc/pgx/v5"
)

// A bundle's config (docs/architecture/bundles.md#配置): what the user sets
// for it, declared in its bundle.json as a JSON Schema of string properties
// named after the environment variables they become. The values are set
// once for the bundle (Settings → 连接, a form built from the schema), kept
// sealed, and given to every agent that loads it; until the required ones
// are set its plugins stay out of those agents.

// config.schema.json is what a bundle's config may be; the validation is
// jsonschema-go's, both of a bundle's schema against it and of the user's
// values against that schema.
//
//go:embed config.schema.json
var metaSchemaJSON []byte

var metaSchema = mustResolve(metaSchemaJSON)

func mustResolve(data []byte) *jsonschema.Resolved {
	var s jsonschema.Schema
	if err := json.Unmarshal(data, &s); err != nil {
		panic(err)
	}
	r, err := s.Resolve(nil)
	if err != nil {
		panic(err)
	}
	return r
}

// ConfigSchema is a bundle's config, resolved: whole (all of it, the
// required values included, makes it ready) and without required (what
// any save must satisfy).
type ConfigSchema struct {
	schema         *jsonschema.Schema
	whole, partial *jsonschema.Resolved
}

// parseConfig checks a bundle.json's config against config.schema.json.
func parseConfig(raw map[string]any) (*ConfigSchema, error) {
	if raw == nil {
		return nil, nil
	}
	if err := metaSchema.Validate(raw); err != nil {
		return nil, err
	}
	data, _ := json.Marshal(raw)
	var s jsonschema.Schema
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	whole, err := s.Resolve(nil)
	if err != nil {
		return nil, err
	}
	optional := s
	optional.Required = nil
	partial, err := optional.Resolve(nil)
	if err != nil {
		return nil, err
	}
	return &ConfigSchema{schema: &s, whole: whole, partial: partial}, nil
}

func instance(values map[string]string) map[string]any {
	out := make(map[string]any, len(values))
	for k, v := range values {
		out[k] = v
	}
	return out
}

// ready: the stored values make a valid config. Values of properties the
// bundle no longer has are left out, not held against it.
func (s *ConfigSchema) ready(values map[string]string) bool {
	known := map[string]any{}
	for k, v := range values {
		if _, ok := s.schema.Properties[k]; ok {
			known[k] = v
		}
	}
	return s.whole.Validate(known) == nil
}

// ConfigState is what the browser sees of a bundle's config: its values,
// except secrets, of which it only learns that they are set.
type ConfigState struct {
	Values map[string]string `json:"values" doc:"Values set, secrets left out."`
	Set    []string          `json:"set" doc:"Every property with a value, secrets included."`
	// Every required property has a value: agents get the bundle's plugins.
	Ready     bool       `json:"ready" doc:"Every required property has a value, so agents get the bundle's plugins."`
	UpdatedAt *time.Time `json:"updated_at,omitempty"`
}

// sealed config: the values as JSON, sealed with a key derived from the
// control plane's secret.
const configPurpose = "bundle-config"

func (c *Catalog) configured(name string) (*ConfigSchema, error) {
	builtin, err := c.Builtin()
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(builtin, func(b Bundle) bool { return b.Name == name })
	if i < 0 || builtin[i].config == nil {
		return nil, apierr.NotFound()
	}
	return builtin[i].config, nil
}

func readConfig(ctx context.Context, db pg.DB, secret []byte, name string) (map[string]string, *time.Time, error) {
	var sealed []byte
	var updated time.Time
	err := db.QueryRow(ctx, "SELECT sealed, updated_at FROM bundle_config WHERE bundle = $1", name).Scan(&sealed, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]string{}, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	values, err := open(secret, sealed)
	if err != nil {
		// AXP_SECRET_KEY changed: as if nothing were set.
		return map[string]string{}, &updated, nil
	}
	return values, &updated, nil
}

func open(secret, sealed []byte) (map[string]string, error) {
	plain, err := auth.Open(secret, configPurpose, sealed)
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	return values, json.Unmarshal(plain, &values)
}

func state(s *ConfigSchema, values map[string]string, updated *time.Time) *ConfigState {
	out := &ConfigState{Values: map[string]string{}, Set: []string{}, Ready: s.ready(values), UpdatedAt: updated}
	for name, v := range values {
		if p, ok := s.schema.Properties[name]; ok && v != "" {
			out.Set = append(out.Set, name)
			if !p.WriteOnly {
				out.Values[name] = v
			}
		}
	}
	slices.Sort(out.Set)
	return out
}

// Config is the bundle's config as the browser sees it.
func (c *Catalog) Config(ctx context.Context, db pg.DB, secret []byte, name string) (*ConfigState, error) {
	s, err := c.configured(name)
	if err != nil {
		return nil, err
	}
	values, updated, err := readConfig(ctx, db, secret, name)
	if err != nil {
		return nil, err
	}
	return state(s, values, updated), nil
}

// SetConfig changes the values sent: a string sets one, null clears it,
// and the ones left out stay. Agents loading the bundle get the new values
// once idle (their container is replaced).
func (c *Catalog) SetConfig(ctx context.Context, db pg.DB, secret []byte, name string, changes map[string]*string) (*ConfigState, error) {
	s, err := c.configured(name)
	if err != nil {
		return nil, err
	}
	values, _, err := readConfig(ctx, db, secret, name)
	if err != nil {
		return nil, err
	}
	for key := range values {
		if _, ok := s.schema.Properties[key]; !ok {
			delete(values, key) // a property the bundle no longer has
		}
	}
	for key, v := range changes {
		if v == nil || strings.TrimSpace(*v) == "" {
			delete(values, key)
		} else {
			values[key] = strings.TrimSpace(*v)
		}
	}
	if err := s.partial.Validate(instance(values)); err != nil {
		return nil, s.invalid(values)
	}
	plain, _ := json.Marshal(values)
	sealed, err := auth.Seal(secret, configPurpose, plain)
	if err != nil {
		return nil, err
	}
	now := pg.Now()
	if _, err := db.Exec(ctx, `INSERT INTO bundle_config (bundle, sealed, updated_at) VALUES ($1, $2, $3)
		ON CONFLICT (bundle) DO UPDATE SET sealed = $2, updated_at = $3`, name, sealed, now); err != nil {
		return nil, err
	}
	return state(s, values, &now), nil
}

// DeleteConfig clears every value.
func (c *Catalog) DeleteConfig(ctx context.Context, db pg.DB, name string) error {
	if _, err := c.configured(name); err != nil {
		return err
	}
	_, err := db.Exec(ctx, "DELETE FROM bundle_config WHERE bundle = $1", name)
	return err
}

// invalid names the values that break the schema. The library's messages
// quote values, and some are secrets, so they are not passed on.
func (s *ConfigSchema) invalid(values map[string]string) error {
	var bad []string
	for key, v := range values {
		p, ok := s.schema.Properties[key]
		switch {
		case !ok:
			bad = append(bad, key)
		case s.partial.Validate(map[string]any{key: v}) != nil:
			if p.Title != "" {
				key = p.Title
			}
			bad = append(bad, key)
		}
	}
	slices.Sort(bad)
	return apierr.New(422, "CONFIG_INVALID", "配置不符合要求："+strings.Join(bad, "、")+"。")
}

// Configs are the bundles' values, by bundle, for the controller.
func Configs(ctx context.Context, db pg.DB, secret []byte) (map[string]map[string]string, error) {
	rows, err := db.Query(ctx, "SELECT bundle, sealed FROM bundle_config")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]string{}
	for rows.Next() {
		var name string
		var sealed []byte
		if err := rows.Scan(&name, &sealed); err != nil {
			return nil, err
		}
		if values, err := open(secret, sealed); err == nil {
			out[name] = values
		}
	}
	return out, rows.Err()
}

// Environment is what the agent's bundles' configs add to its container:
// the values of each bundle whose required ones are set, and the plugins
// of the others, which it goes without (no other of its bundles adds them).
func Environment(chosen []Bundle, configs map[string]map[string]string) (env map[string]string, disabled []string) {
	env = map[string]string{}
	var enabled []string
	for _, b := range chosen {
		values := configs[b.Name]
		if b.config != nil && !b.config.ready(values) {
			continue
		}
		enabled = append(enabled, b.Plugins...)
		if b.config == nil {
			continue
		}
		for name := range b.config.schema.Properties {
			if v := values[name]; v != "" {
				env[name] = v
			}
		}
	}
	for _, p := range PluginsOf(chosen) {
		if !slices.Contains(enabled, p) {
			disabled = append(disabled, p)
		}
	}
	return env, disabled
}
