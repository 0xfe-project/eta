// Package plugins is AXP's plugin standard (docs/architecture/plugins.md):
// a plugin is a directory that no agent harness owns, compiled for each
// target that runs it.
//
//	plugin.json       name, version, description and targets ("chat", "routine")
//	mcp.json          MCP servers, in the standard mcpServers shape
//	skills/*/SKILL.md Agent Skills
//	hooks/hooks.json  lifecycle hooks (chat only, until they move to akhook)
//	setup             run once when an image is built
//
// The chat target is the chat agents' runtime, which runs Codex: Chat
// compiles plugins to Codex's layout. The routine target is the routine
// service's ADK agents: package adk loads plugins into them.
package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
)

const (
	TargetChat    = "chat"
	TargetRoutine = "routine"
)

// Variables are the names a plugin may use as ${NAME}; each target gives
// their values.
var Variables = []string{
	// The plugin's directory.
	"PLUGIN_ROOT",
	// Where the agent reaches AXP's services.
	"AXP_GATEWAY_URL",
	// The agent's credential for them.
	"AXP_AGENT_KEY",
	// The agent's working directory.
	"AXP_WORKSPACE_DIR",
}

type Manifest struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Targets     []string `json:"targets"`
}

// Server is an MCP server: a command (stdio) or a URL (streamable HTTP).
type Server struct {
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type Plugin struct {
	Manifest
	Dir     string
	Servers map[string]Server
	// Hooks is hooks/hooks.json, when there is one.
	Hooks string
	// Skills is the skills directory, when there is one.
	Skills string
	// Setup is the setup script, when there is one.
	Setup string
}

// For reports whether the plugin runs on target.
func (p *Plugin) For(target string) bool { return slices.Contains(p.Targets, target) }

var variable = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// Read reads the plugin in dir and checks it.
func Read(dir string) (*Plugin, error) {
	p := &Plugin{Dir: dir, Servers: map[string]Server{}}
	if err := readJSON(filepath.Join(dir, "plugin.json"), &p.Manifest); err != nil {
		return nil, err
	}
	if p.Name != filepath.Base(dir) {
		return nil, fmt.Errorf("%s: name %q is not its directory's", dir, p.Name)
	}
	if len(p.Targets) == 0 {
		return nil, fmt.Errorf("%s: no targets", p.Name)
	}
	for _, t := range p.Targets {
		if t != TargetChat && t != TargetRoutine {
			return nil, fmt.Errorf("%s: unknown target %q", p.Name, t)
		}
	}
	var mcp struct {
		Servers map[string]Server `json:"mcpServers"`
	}
	switch err := readJSON(filepath.Join(dir, "mcp.json"), &mcp); {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		p.Servers = mcp.Servers
	}
	for name, s := range p.Servers {
		if (s.Command == "") == (s.URL == "") {
			return nil, fmt.Errorf("%s: server %s needs a command or a url", p.Name, name)
		}
		if err := checkVariables(s); err != nil {
			return nil, fmt.Errorf("%s: server %s: %w", p.Name, name, err)
		}
	}
	for _, f := range []struct {
		path string
		into *string
	}{{"hooks/hooks.json", &p.Hooks}, {"skills", &p.Skills}, {"setup", &p.Setup}} {
		path := filepath.Join(dir, f.path)
		if _, err := os.Stat(path); err == nil {
			*f.into = path
		}
	}
	return p, nil
}

func readJSON(path string, into any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, into); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func checkVariables(s Server) error {
	texts := append([]string{s.Command, s.Cwd, s.URL}, s.Args...)
	for _, v := range s.Env {
		texts = append(texts, v)
	}
	for _, v := range s.Headers {
		texts = append(texts, v)
	}
	for _, text := range texts {
		for _, m := range variable.FindAllStringSubmatch(text, -1) {
			if !slices.Contains(Variables, m[1]) {
				return fmt.Errorf("unknown variable ${%s}", m[1])
			}
		}
	}
	return nil
}

// List is the plugins under root for target (every target when ""), by name.
func List(root, target string) ([]*Plugin, error) {
	manifests, err := filepath.Glob(filepath.Join(root, "*", "plugin.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(manifests)
	var out []*Plugin
	for _, manifest := range manifests {
		p, err := Read(filepath.Dir(manifest))
		if err != nil {
			return nil, err
		}
		if target == "" || p.For(target) {
			out = append(out, p)
		}
	}
	return out, nil
}

// Expand replaces the variables in s with values; those without a value
// stay as they are.
func Expand(s string, values map[string]string) string {
	return variable.ReplaceAllStringFunc(s, func(m string) string {
		if v, ok := values[m[2:len(m)-1]]; ok {
			return v
		}
		return m
	})
}

// SetUp runs the setup script of every plugin for target, from the plugin's
// directory, with AXP_PLUGIN_CACHE (a directory of its own under cache, kept
// across builds, for downloads) and AXP_PLUGIN_BIN (where it installs its
// executables).
func SetUp(plugins []*Plugin, cache, bin string) error {
	for _, p := range plugins {
		if p.Setup == "" {
			continue
		}
		fmt.Printf("Setting up plugin %s\n", p.Name)
		dir := filepath.Join(cache, p.Name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		cmd := exec.Command(p.Setup)
		cmd.Dir = p.Dir
		cmd.Env = append(os.Environ(), "PLUGIN_ROOT="+p.Dir, "AXP_PLUGIN_CACHE="+dir, "AXP_PLUGIN_BIN="+bin)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("%s: setup: %w", p.Name, err)
		}
	}
	return nil
}
