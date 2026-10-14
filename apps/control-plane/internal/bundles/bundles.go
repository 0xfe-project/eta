// Package bundles is what agents are built from (docs/architecture/bundles.md):
// a bundle is a script run into the agent's image and the plugins it adds.
// The built-in ones are directories in apps/agent-runtime/bundles
// (bundle.json, an optional setup script and its files); the user's are rows
// of the bundle table. An agent loads any number of them.
package bundles

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

type Bundle struct {
	Required    bool   `json:"required" doc:"Built in and always loaded; cannot be disabled."`
	Name        string `json:"name"`
	Description string `json:"description"`
	// Built in: part of AXP, read only.
	Builtin bool `json:"builtin" doc:"Part of AXP, read only."`
	// Run as root when an agent's image is built, from the bundle's directory.
	Script string `json:"script" doc:"Run as root when an agent's image is built, from the bundle's directory."`
	// Plugins it adds, by name (GET /api/v1/plugins).
	Plugins []string `json:"plugins" doc:"Plugins it adds, by name (GET /api/v1/plugins)."`
	// What the user sets for it (config.go); built-in bundles only.
	Config map[string]any `json:"config,omitempty" doc:"What the user sets for it, a JSON Schema of string properties: environment variables of the agents that load it."`
	config *ConfigSchema
	// What it runs in the cluster, if anything (service.go).
	Service *Service `json:"service,omitempty"`
	// How its service is, when it has one and the cluster is reachable.
	ServiceStatus *ServiceStatus `json:"service_status,omitempty"`
	// A built-in bundle's directory.
	Dir string `json:"-"`
}

// SetupFile is a bundle's script in its directory.
const SetupFile = "setup"

var validName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// Catalog reads the built-in bundles from Dir once.
type Catalog struct {
	Dir     string
	Plugins *plugins.Catalog

	once    sync.Once
	builtin []Bundle
	err     error
}

func (c *Catalog) Builtin() ([]Bundle, error) {
	c.once.Do(func() { c.builtin, c.err = readDir(c.Dir) })
	return c.builtin, c.err
}

func readDir(dir string) ([]Bundle, error) {
	manifests, err := filepath.Glob(filepath.Join(dir, "*", "bundle.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(manifests)
	out := []Bundle{}
	for _, manifest := range manifests {
		data, err := os.ReadFile(manifest)
		if err != nil {
			return nil, err
		}
		b := Bundle{Builtin: true, Dir: filepath.Dir(manifest)}
		if err := json.Unmarshal(data, &b); err != nil {
			return nil, fmt.Errorf("%s: %w", manifest, err)
		}
		if b.Name != filepath.Base(b.Dir) {
			return nil, fmt.Errorf("%s: name %q is not its directory's", manifest, b.Name)
		}
		script, err := os.ReadFile(filepath.Join(b.Dir, SetupFile))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		b.Script = string(script)
		if b.Plugins == nil {
			b.Plugins = []string{}
		}
		if b.config, err = parseConfig(b.Config); err != nil {
			return nil, fmt.Errorf("%s: config: %w", manifest, err)
		}
		if b.Service != nil {
			if err := readService(b.Service, b.Dir); err != nil {
				return nil, fmt.Errorf("%s: service: %w", manifest, err)
			}
		}
		out = append(out, b)
	}
	return out, nil
}

type row struct {
	Name        string    `db:"name"`
	Description string    `db:"description"`
	Script      string    `db:"script"`
	Plugins     []string  `db:"plugins"`
	Service     *Service  `db:"service"`
	CreatedAt   time.Time `db:"created_at"`
	UpdatedAt   time.Time `db:"updated_at"`
}

// All is every bundle: the built-in ones, then the user's, each by name.
func (c *Catalog) All(ctx context.Context, db pg.DB) ([]Bundle, error) {
	builtin, err := c.Builtin()
	if err != nil {
		return nil, err
	}
	rows, err := pg.All[row](ctx, db, "SELECT * FROM bundle ORDER BY name")
	if err != nil {
		return nil, err
	}
	out := slices.Clone(builtin)
	for _, r := range rows {
		out = append(out, *public(r))
	}
	return out, nil
}

// Of is the named bundles, in catalog order.
func Of(all []Bundle, names []string) []Bundle {
	var out []Bundle
	for _, b := range all {
		if slices.Contains(names, b.Name) {
			out = append(out, b)
		}
	}
	return out
}

// PluginsOf is the plugins the bundles add, each once, by name.
func PluginsOf(chosen []Bundle) []string {
	out := []string{}
	for _, b := range chosen {
		for _, p := range b.Plugins {
			if !slices.Contains(out, p) {
				out = append(out, p)
			}
		}
	}
	sort.Strings(out)
	return out
}

// Choose checks the names an agent loads and puts them in catalog order;
// every built-in bundle when names is nil. It returns their plugins too.
func (c *Catalog) Choose(ctx context.Context, db pg.DB, names []string) (chosen, added []string, err error) {
	all, err := c.All(ctx, db)
	if err != nil {
		return nil, nil, err
	}
	if names == nil {
		for _, b := range all {
			if b.Builtin {
				names = append(names, b.Name)
			}
		}
	}
	for _, b := range all {
		if b.Required && !slices.Contains(names, b.Name) {
			names = append(names, b.Name)
		}
	}
	var unknown []string
	for _, name := range names {
		if !slices.ContainsFunc(all, func(b Bundle) bool { return b.Name == name }) && !slices.Contains(unknown, name) {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, nil, apierr.New(422, "BUNDLE_NOT_FOUND", "环境包不存在："+strings.Join(unknown, "、")+"。")
	}
	bundles := Of(all, names)
	chosen = []string{}
	for _, b := range bundles {
		chosen = append(chosen, b.Name)
	}
	return chosen, PluginsOf(bundles), nil
}

// Input is a user's bundle as sent; nil fields of an update stay.
type Input struct {
	Name        *string
	Description *string
	Script      *string
	Plugins     *[]string
	// A service whose manifests are empty removes it.
	Service *Service
}

func (c *Catalog) check(in Input) error {
	if in.Name != nil && !validName.MatchString(*in.Name) {
		return apierr.New(422, "INVALID_BUNDLE_NAME", "环境包名只能用小写字母、数字和连字符，最多 40 个字符。")
	}
	if in.Plugins != nil {
		if _, err := c.Plugins.Choose(*in.Plugins); err != nil {
			return err
		}
	}
	return checkService(in.Service)
}

// service is what to store of in: nothing for none.
func (in Input) service() *Service {
	if in.Service == nil || in.Service.Manifests == "" {
		return nil
	}
	return in.Service
}

func (c *Catalog) builtinNamed(name string) (bool, error) {
	builtin, err := c.Builtin()
	return slices.ContainsFunc(builtin, func(b Bundle) bool { return b.Name == name }), err
}

func readOnly() error { return apierr.New(409, "BUNDLE_BUILTIN", "内置环境包不能修改。") }

func public(r *row) *Bundle {
	return &Bundle{Name: r.Name, Description: r.Description, Script: r.Script, Plugins: r.Plugins, Service: r.Service}
}

func (c *Catalog) Create(ctx context.Context, tx pgx.Tx, in Input) (*Bundle, error) {
	if in.Name == nil || in.Description == nil || in.Script == nil || in.Plugins == nil {
		return nil, apierr.Invalid()
	}
	if err := c.check(in); err != nil {
		return nil, err
	}
	added, _ := c.Plugins.Choose(*in.Plugins)
	if builtin, err := c.builtinNamed(*in.Name); err != nil || builtin {
		if err != nil {
			return nil, err
		}
		return nil, apierr.New(409, "BUNDLE_EXISTS", "已有同名环境包。")
	}
	now := pg.Now()
	created, err := tx.Exec(ctx, `INSERT INTO bundle (name, description, script, plugins, service, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT (name) DO NOTHING`, *in.Name, *in.Description, *in.Script, added, in.service(), now)
	if err != nil {
		return nil, err
	}
	if created.RowsAffected() == 0 {
		return nil, apierr.New(409, "BUNDLE_EXISTS", "已有同名环境包。")
	}
	return &Bundle{Name: *in.Name, Description: *in.Description, Script: *in.Script, Plugins: added, Service: in.service()}, nil
}

// Update changes the user's bundle; agents loading it get its new plugins
// at once and its new image when the controller has built it.
func (c *Catalog) Update(ctx context.Context, tx pgx.Tx, name string, in Input) (*Bundle, error) {
	if err := c.check(in); err != nil {
		return nil, err
	}
	if builtin, err := c.builtinNamed(name); err != nil || builtin {
		if err != nil {
			return nil, err
		}
		return nil, readOnly()
	}
	r, err := pg.One[row](ctx, tx, "SELECT * FROM bundle WHERE name = $1 FOR UPDATE", name)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, apierr.NotFound()
	}
	if in.Description != nil {
		r.Description = *in.Description
	}
	if in.Script != nil {
		r.Script = *in.Script
	}
	if in.Plugins != nil {
		r.Plugins, _ = c.Plugins.Choose(*in.Plugins)
	}
	if in.Service != nil {
		r.Service = in.service()
	}
	if _, err := tx.Exec(ctx, `UPDATE bundle SET description = $2, script = $3, plugins = $4, service = $5, updated_at = $6
		WHERE name = $1`, name, r.Description, r.Script, r.Plugins, r.Service, pg.Now()); err != nil {
		return nil, err
	}
	if in.Plugins != nil {
		if err := c.refreshAgents(ctx, tx, name); err != nil {
			return nil, err
		}
	}
	return public(r), nil
}

// refreshAgents recomputes the plugins of the agents loading the bundle.
func (c *Catalog) refreshAgents(ctx context.Context, tx pgx.Tx, name string) error {
	all, err := c.All(ctx, tx)
	if err != nil {
		return err
	}
	type agent struct {
		ID      string   `db:"id"`
		Bundles []string `db:"bundles"`
	}
	agents, err := pg.All[agent](ctx, tx, "SELECT id, bundles FROM agent WHERE bundles ? $1 FOR UPDATE", name)
	if err != nil {
		return err
	}
	for _, a := range agents {
		if _, err := tx.Exec(ctx, "UPDATE agent SET plugins = $2 WHERE id = $1", a.ID, PluginsOf(Of(all, a.Bundles))); err != nil {
			return err
		}
	}
	return nil
}

// Delete removes the user's bundle, which no agent may still load.
func (c *Catalog) Delete(ctx context.Context, tx pgx.Tx, name string) error {
	if builtin, err := c.builtinNamed(name); err != nil || builtin {
		if err != nil {
			return err
		}
		return readOnly()
	}
	used, err := pg.Exists(ctx, tx, "SELECT 1 FROM agent WHERE bundles ? $1 AND deleted_at IS NULL", name)
	if err != nil {
		return err
	}
	if used {
		return apierr.New(409, "BUNDLE_IN_USE", "还有智能体在用这个环境包。")
	}
	deleted, err := tx.Exec(ctx, "DELETE FROM bundle WHERE name = $1", name)
	if err != nil {
		return err
	}
	if deleted.RowsAffected() == 0 {
		return apierr.NotFound()
	}
	return nil
}
