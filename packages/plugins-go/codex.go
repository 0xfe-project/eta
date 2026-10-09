package plugins

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The chat target: Codex plugins in a local marketplace, which the chat
// runtime installs for each agent (apps/agent-runtime). The runtime fills in
// ${AXP_GATEWAY_URL} and ${AXP_WORKSPACE_DIR} when it installs a plugin, and
// gives Codex the agent's key as AgentKeyEnv.

const (
	Marketplace = "axp"
	AgentKeyEnv = "AXP_RUNTIME_LLM_KEY"
)

// Chat compiles root's chat plugins for Codex, in place: each gets
// .codex-plugin/plugin.json and a Codex .mcp.json, root gets the marketplace,
// and codexDir's config.toml approves the plugins' tools and its
// requirements.toml declares their hooks as managed hooks. Codex only runs
// plugin hooks a person has trusted; managed hooks run by policy, but for
// every agent, so each runs only where its plugin is installed. imageRoot is
// where agents see root.
func Chat(root, codexDir, imageRoot string) error {
	plugins, err := List(root, TargetChat)
	if err != nil {
		return err
	}
	type entry struct {
		Name   string `json:"name"`
		Source struct {
			Source string `json:"source"`
			Path   string `json:"path"`
		} `json:"source"`
		Policy struct {
			Installation   string `json:"installation"`
			Authentication string `json:"authentication"`
		} `json:"policy"`
		Category string `json:"category"`
	}
	catalog := struct {
		Name      string            `json:"name"`
		Interface map[string]string `json:"interface"`
		Plugins   []entry           `json:"plugins"`
	}{Name: Marketplace, Interface: map[string]string{"displayName": "AXP"}, Plugins: []entry{}}
	var approvals, hooks []string
	for _, p := range plugins {
		pluginRoot := filepath.Join(imageRoot, p.Name)
		manifest := map[string]string{"name": p.Name, "version": p.Version, "description": p.Description}
		if err := writeJSON(filepath.Join(p.Dir, ".codex-plugin", "plugin.json"), manifest); err != nil {
			return err
		}
		if len(p.Servers) > 0 {
			servers := map[string]map[string]any{}
			for name, s := range p.Servers {
				if servers[name], err = codexServer(s, pluginRoot); err != nil {
					return fmt.Errorf("%s: server %s: %w", p.Name, name, err)
				}
				approvals = append(approvals, fmt.Sprintf("[plugins.%s.mcp_servers.%s]\ndefault_tools_approval_mode = \"approve\"\n",
					quote(p.Name+"@"+Marketplace), quote(name)))
			}
			if err := writeJSON(filepath.Join(p.Dir, ".mcp.json"), map[string]any{"mcpServers": servers}); err != nil {
				return err
			}
		}
		if p.Hooks != "" {
			tables, err := managedHooks(p, pluginRoot)
			if err != nil {
				return err
			}
			hooks = append(hooks, tables...)
		}
		e := entry{Name: p.Name, Category: "Productivity"}
		e.Source.Source, e.Source.Path = "local", "./"+p.Name
		e.Policy.Installation, e.Policy.Authentication = "AVAILABLE", "ON_INSTALL"
		catalog.Plugins = append(catalog.Plugins, e)
	}
	sort.Strings(approvals)
	if err := writeJSON(filepath.Join(root, ".agents", "plugins", "marketplace.json"), catalog); err != nil {
		return err
	}
	for _, f := range []struct {
		name, heading string
		tables        []string
	}{
		{"config.toml", "The plugins' tools need no approval.", approvals},
		{"requirements.toml", "The plugins' hooks.", hooks},
	} {
		if len(f.tables) == 0 {
			continue
		}
		text := fmt.Sprintf("\n# %s (generated from the plugins)\n%s", f.heading, strings.Join(f.tables, "\n"))
		file, err := os.OpenFile(filepath.Join(codexDir, f.name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		_, err = file.WriteString(text)
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
	}
	return nil
}

const bearerKey = "Bearer ${AXP_AGENT_KEY}"

// codexServer is s in Codex's .mcp.json: the agent's key as a bearer token
// (HTTP) or through the environment Codex passes on (stdio).
func codexServer(s Server, pluginRoot string) (map[string]any, error) {
	root := map[string]string{"PLUGIN_ROOT": pluginRoot}
	if s.URL != "" {
		out := map[string]any{"type": "streamable-http", "url": Expand(s.URL, root)}
		static := map[string]string{}
		for name, value := range s.Headers {
			switch {
			case strings.EqualFold(name, "Authorization") && value == bearerKey:
				out["bearer_token_env_var"] = AgentKeyEnv
			case strings.Contains(value, "${AXP_AGENT_KEY}"):
				return nil, fmt.Errorf("header %s: the agent key only goes in %q", name, "Authorization: "+bearerKey)
			default:
				static[name] = Expand(value, root)
			}
		}
		if len(static) > 0 {
			out["http_headers"] = static
		}
		return out, nil
	}
	command, args := Expand(s.Command, root), make([]string, len(s.Args))
	for i, a := range s.Args {
		args[i] = Expand(a, root)
	}
	if strings.Contains(command+strings.Join(args, " ")+s.Cwd, "${AXP_AGENT_KEY}") {
		return nil, fmt.Errorf("the agent key only goes in env")
	}
	env := map[string]string{}
	var fromKey []string
	for name, value := range s.Env {
		switch {
		case value == "${AXP_AGENT_KEY}":
			fromKey = append(fromKey, name)
		case strings.Contains(value, "${AXP_AGENT_KEY}"):
			return nil, fmt.Errorf("env %s: the agent key is a whole value", name)
		default:
			env[name] = Expand(value, root)
		}
	}
	out := map[string]any{}
	if len(fromKey) > 0 {
		// Codex passes variables on but does not rename them.
		sort.Strings(fromKey)
		assign := make([]string, len(fromKey))
		for i, name := range fromKey {
			assign[i] = fmt.Sprintf(`export %s="$%s"; `, name, AgentKeyEnv)
		}
		args = append([]string{"-c", strings.Join(assign, "") + `exec "$0" "$@"`, command}, args...)
		command = "sh"
		out["env_vars"] = []string{AgentKeyEnv}
	}
	out["command"] = command
	if len(args) > 0 {
		out["args"] = args
	}
	if s.Cwd != "" {
		out["cwd"] = Expand(s.Cwd, root)
	}
	if len(env) > 0 {
		out["env"] = env
	}
	return out, nil
}

// managedHooks are requirements.toml tables for the plugin's hooks.json,
// run from the image and only where the plugin is installed.
func managedHooks(p *Plugin, pluginRoot string) ([]string, error) {
	var file struct {
		Hooks map[string][]struct {
			Matcher *string          `json:"matcher"`
			Hooks   []map[string]any `json:"hooks"`
		} `json:"hooks"`
	}
	if err := readJSON(p.Hooks, &file); err != nil {
		return nil, err
	}
	installed := fmt.Sprintf(`"$CODEX_HOME/plugins/cache/%s/%s"`, Marketplace, p.Name)
	events := make([]string, 0, len(file.Hooks))
	for event := range file.Hooks {
		events = append(events, event)
	}
	sort.Strings(events)
	var tables []string
	for _, event := range events {
		for _, group := range file.Hooks[event] {
			lines := []string{fmt.Sprintf("[[hooks.%s]]", event)}
			if group.Matcher != nil {
				lines = append(lines, "matcher = "+quote(*group.Matcher))
			}
			for _, handler := range group.Hooks {
				lines = append(lines, fmt.Sprintf("[[hooks.%s.hooks]]", event))
				keys := make([]string, 0, len(handler))
				for key := range handler {
					keys = append(keys, key)
				}
				sort.Strings(keys)
				for _, key := range keys {
					value := handler[key]
					if key == "command" {
						command := fmt.Sprint(value)
						for _, name := range []string{"${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"} {
							command = strings.ReplaceAll(command, name, pluginRoot)
						}
						value = fmt.Sprintf("if [ -d %s ]; then %s; fi", installed, command)
					}
					lines = append(lines, key+" = "+quote(value))
				}
			}
			tables = append(tables, strings.Join(lines, "\n")+"\n")
		}
	}
	return tables, nil
}

// quote is v as JSON, which is valid TOML for strings and numbers.
func quote(v any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	return strings.TrimSpace(b.String())
}

func writeJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	e.SetIndent("", "  ")
	if err := e.Encode(v); err != nil {
		return err
	}
	return os.WriteFile(path, b.Bytes(), 0o644)
}
