package plugins

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"gopkg.in/yaml.v3"
)

// A plugin's hooks are akhook lifecycle rules (aghub-app/akhook) in its
// akhook.yml: prompt_submit, whose command may add context to the turn, and
// stop. akhook runs them on every target; each target registers akhook and
// gives it the plugins' rules as additional configs. A rule's command may
// use ${PLUGIN_ROOT} and gets AXP_GATEWAY_URL, AXP_AGENT_KEY and
// AXP_WORKSPACE_DIR in its environment.

// Hooks is a plugin's akhook.yml.
type Hooks struct {
	Version int    `yaml:"version"`
	Rules   []Hook `yaml:"rules"`
}

type Hook struct {
	ID  string `yaml:"id"`
	On  string `yaml:"on"`
	Run struct {
		Argv      []string `yaml:"argv"`
		TimeoutMS int      `yaml:"timeout_ms,omitempty"`
	} `yaml:"run"`
}

// ReadHooks reads and checks the plugin's akhook.yml: lifecycle rules only,
// with ${PLUGIN_ROOT} the only variable.
func ReadHooks(p *Plugin) (*Hooks, error) {
	data, err := os.ReadFile(p.Hooks)
	if err != nil {
		return nil, err
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	var h Hooks
	if err := decoder.Decode(&h); err != nil {
		return nil, fmt.Errorf("%s: %w", p.Hooks, err)
	}
	if h.Version != 1 {
		return nil, fmt.Errorf("%s: version must be 1", p.Hooks)
	}
	for _, rule := range h.Rules {
		if rule.ID == "" || len(rule.Run.Argv) == 0 || !slices.Contains([]string{"prompt_submit", "stop"}, rule.On) {
			return nil, fmt.Errorf("%s: rule %q: a plugin's rules are prompt_submit or stop rules with an id and run.argv", p.Hooks, rule.ID)
		}
		for _, arg := range rule.Run.Argv {
			for _, m := range variable.FindAllStringSubmatch(arg, -1) {
				if m[1] != "PLUGIN_ROOT" {
					return nil, fmt.Errorf("%s: rule %s: ${%s}: only ${PLUGIN_ROOT} is expanded; the others are environment variables", p.Hooks, rule.ID, m[1])
				}
			}
		}
	}
	return &h, nil
}

// WriteHooks writes the plugins' rules as one akhook config at path: rule ids
// get their plugin's name ("memory/recall"), ${PLUGIN_ROOT} becomes
// root(plugin), and wrap, when given, rewrites each command.
func WriteHooks(path string, list []*Plugin, root func(*Plugin) string, wrap func(*Plugin, []string) []string) error {
	out := Hooks{Version: 1, Rules: []Hook{}}
	for _, p := range list {
		if p.Hooks == "" {
			continue
		}
		h, err := ReadHooks(p)
		if err != nil {
			return err
		}
		for _, rule := range h.Rules {
			rule.ID = p.Name + "/" + rule.ID
			argv := make([]string, len(rule.Run.Argv))
			for i, arg := range rule.Run.Argv {
				argv[i] = Expand(arg, map[string]string{"PLUGIN_ROOT": root(p)})
			}
			if wrap != nil {
				argv = wrap(p, argv)
			}
			rule.Run.Argv = argv
			out.Rules = append(out.Rules, rule)
		}
	}
	data, err := yaml.Marshal(out)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	header := "# The plugins' akhook rules (generated from their akhook.yml).\n"
	return os.WriteFile(path, append([]byte(header), data...), 0o644)
}
