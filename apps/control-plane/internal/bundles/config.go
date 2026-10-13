package bundles

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// A bundle's config (docs/architecture/bundles.md#配置): what the user sets
// for it, declared in its bundle.json as a JSON Schema of string properties
// named after the environment variables they become. The values are set
// once for the bundle (Settings → 连接, a form built from the schema), kept
// sealed, and given to every agent that loads it; until the required ones
// are set its plugins stay out of those agents.

// ConfigSchema is the subset of JSON Schema a bundle's config may use.
type ConfigSchema struct {
	Type       string                    `json:"type" enum:"object"`
	Properties map[string]ConfigProperty `json:"properties"`
	Required   []string                  `json:"required,omitempty"`
}

type ConfigProperty struct {
	Type        string `json:"type" enum:"string"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty" doc:"Markdown."`
	// A secret: it goes in and never comes back out.
	WriteOnly bool `json:"writeOnly,omitempty" doc:"A secret: it goes in and never comes back out."`
	MaxLength int  `json:"maxLength,omitempty"`
}

// defaultMaxLength bounds a value whose property sets none.
const defaultMaxLength = 4096

var envName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// Variables the runtime, Codex and the system own.
var reservedEnv = []string{"AXP_", "OTEL_", "CODEX_", "AKHOOK_", "NODE_", "LD_", "PATH", "HOME", "USER", "SHELL", "PWD", "HOSTNAME", "TERM", "LANG"}

func reserved(name string) bool {
	return slices.ContainsFunc(reservedEnv, func(r string) bool {
		return name == r || strings.HasSuffix(r, "_") && strings.HasPrefix(name, r)
	})
}

func (s *ConfigSchema) check() error {
	if s == nil {
		return nil
	}
	if s.Type != "object" || len(s.Properties) == 0 {
		return errors.New(`type must be "object", with properties`)
	}
	for name, p := range s.Properties {
		if !envName.MatchString(name) || reserved(name) {
			return fmt.Errorf("property %q is not an environment variable a bundle may set", name)
		}
		if p.Type != "string" {
			return fmt.Errorf("property %q: only strings", name)
		}
	}
	for _, name := range s.Required {
		if _, ok := s.Properties[name]; !ok {
			return fmt.Errorf("required %q is not a property", name)
		}
	}
	return nil
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

func (s *ConfigSchema) ready(values map[string]string) bool {
	return !slices.ContainsFunc(s.Required, func(name string) bool { return values[name] == "" })
}

func (c *Catalog) configured(name string) (*ConfigSchema, error) {
	builtin, err := c.Builtin()
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(builtin, func(b Bundle) bool { return b.Name == name })
	if i < 0 || builtin[i].Config == nil {
		return nil, apierr.NotFound()
	}
	return builtin[i].Config, nil
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
		if p, ok := s.Properties[name]; ok && v != "" {
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
	for key, v := range changes {
		p, ok := s.Properties[key]
		if !ok {
			return nil, apierr.New(422, "CONFIG_UNKNOWN", "环境包没有这一项配置："+key+"。")
		}
		if v == nil || strings.TrimSpace(*v) == "" {
			delete(values, key)
			continue
		}
		value := strings.TrimSpace(*v)
		limit := p.MaxLength
		if limit == 0 {
			limit = defaultMaxLength
		}
		if len([]rune(value)) > limit || strings.ContainsRune(value, 0) {
			return nil, apierr.New(422, "CONFIG_INVALID", fmt.Sprintf("%s 太长或含有无效字符。", title(key, p)))
		}
		values[key] = value
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

func title(key string, p ConfigProperty) string {
	if p.Title != "" {
		return p.Title
	}
	return key
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
		if b.Config != nil && !b.Config.ready(values) {
			continue
		}
		enabled = append(enabled, b.Plugins...)
		if b.Config == nil {
			continue
		}
		for name := range b.Config.Properties {
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
