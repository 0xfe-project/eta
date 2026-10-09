// Package plugins is the plugins agents choose from: those of the chat
// target in apps/agent-runtime/plugins (docs/architecture/plugins.md), which
// the runtime image compiles for Codex in the same order.
package plugins

import (
	"slices"
	"sort"
	"strings"
	"sync"

	standard "github.com/akarachen/axp/packages/plugins-go"
	"github.com/akarachen/axp/packages/service-go/apierr"
)

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

// All is the catalog by name; empty when Dir cannot be read.
func (c *Catalog) All() []Plugin {
	c.once.Do(func() {
		c.plugins = []Plugin{}
		list, _ := standard.List(c.Dir, standard.TargetChat)
		for _, p := range list {
			c.plugins = append(c.plugins, Plugin{Name: p.Name, Description: p.Description})
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
