// Package plugins is the runtime image's Codex plugins, which agents choose
// from.
//
// The catalog is the directories of apps/agent-runtime/plugins, each a plugin
// described by its .codex-plugin/plugin.json; building the runtime image makes
// them a marketplace in the same order (axp_runtime/plugins.py). Runtimes
// install the chosen ones at start.
package plugins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
)

// RoutineOnly are routine runs' own tools; never an agent's.
var RoutineOnly = []string{"routine"}

type Plugin struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Catalog reads Dir once.
type Catalog struct {
	Dir string

	once    sync.Once
	plugins []Plugin
}

// All is the catalog by name.
func (c *Catalog) All() []Plugin {
	c.once.Do(func() {
		manifests, _ := filepath.Glob(filepath.Join(c.Dir, "*", ".codex-plugin", "plugin.json"))
		sort.Strings(manifests)
		c.plugins = []Plugin{}
		for _, manifest := range manifests {
			name := filepath.Base(filepath.Dir(filepath.Dir(manifest)))
			if slices.Contains(RoutineOnly, name) {
				continue
			}
			var meta struct {
				Description string `json:"description"`
			}
			if data, err := os.ReadFile(manifest); err == nil {
				_ = json.Unmarshal(data, &meta)
			}
			c.plugins = append(c.plugins, Plugin{Name: name, Description: meta.Description})
		}
	})
	return c.plugins
}

// Choose is the plugins an agent runs with, in catalog order; all of them
// when names is nil.
func (c *Catalog) Choose(names []string) ([]string, error) {
	known := []string{}
	for _, p := range c.All() {
		known = append(known, p.Name)
	}
	if names == nil {
		return known, nil
	}
	var unknown []string
	for _, name := range names {
		if !slices.Contains(known, name) && !slices.Contains(unknown, name) {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, apierr.New(422, "PLUGIN_NOT_FOUND", "插件不存在："+strings.Join(unknown, "、")+"。")
	}
	chosen := []string{}
	for _, name := range known {
		if slices.Contains(names, name) {
			chosen = append(chosen, name)
		}
	}
	return chosen, nil
}
