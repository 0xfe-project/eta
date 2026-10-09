// Package adk loads plugins into ADK agents: the routine target.
//
// A plugin's MCP servers become MCP toolsets and its skills one skill
// toolset. Its hooks (akhook.yml) run through akhook's ADK callbacks
// (github.com/aghub-app/akhook/go/adk), which need akhook on PATH.
package adk

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	akhook "github.com/aghub-app/akhook/go/adk"
	plugins "github.com/akarachen/axp/packages/plugins-go"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/mcptoolset"
	"google.golang.org/adk/v2/tool/skilltoolset"
	"google.golang.org/adk/v2/tool/skilltoolset/skill"
)

// Plugins are the plugins of one agent run.
type Plugins struct {
	Toolsets []tool.Toolset
	hooks    *akhook.Hooks
}

// Install gives config the plugins' tools and hooks.
func (p *Plugins) Install(config *llmagent.Config) {
	config.Toolsets = append(config.Toolsets, p.Toolsets...)
	if p.hooks != nil {
		p.hooks.Install(config)
	}
}

// Load loads the plugins for one agent run. values are the variables'
// values but PLUGIN_ROOT, and AXP_WORKSPACE_DIR is required: the run's
// directory, where the hooks' config is written. The MCP servers' processes
// end with ctx. A stdio server or hook command gets PATH, HOME and what the
// plugin declares, nothing else of this process's environment.
func Load(ctx context.Context, list []*plugins.Plugin, values map[string]string) (*Plugins, error) {
	out := &Plugins{}
	var skills []skill.Source
	hooked := false
	for _, p := range list {
		hooked = hooked || p.Hooks != ""
		vars := map[string]string{"PLUGIN_ROOT": p.Dir}
		for k, v := range values {
			vars[k] = v
		}
		for name, s := range p.Servers {
			transport, err := connect(ctx, s, vars)
			if err != nil {
				return nil, fmt.Errorf("plugin %s: server %s: %w", p.Name, name, err)
			}
			ts, err := mcptoolset.New(mcptoolset.Config{Transport: transport})
			if err != nil {
				return nil, fmt.Errorf("plugin %s: server %s: %w", p.Name, name, err)
			}
			out.Toolsets = append(out.Toolsets, ts)
		}
		if p.Skills != "" {
			skills = append(skills, skill.NewFileSystemSource(os.DirFS(p.Skills)))
		}
	}
	if len(skills) > 0 {
		ts, err := skilltoolset.New(ctx, skilltoolset.Config{Source: skill.NewMergedSource(skills...)})
		if err != nil {
			return nil, err
		}
		out.Toolsets = append(out.Toolsets, ts)
	}
	if hooked {
		workspace := values["AXP_WORKSPACE_DIR"]
		config := filepath.Join(workspace, ".akhook", "plugins.yml")
		root := func(p *plugins.Plugin) string { return p.Dir }
		if err := plugins.WriteHooks(config, list, root, nil); err != nil {
			return nil, err
		}
		out.hooks = akhook.New(workspace)
		out.hooks.Env = []string{
			"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"),
			"AKHOOK_ADDITIONAL_CONFIG_PATH=" + config,
			"AKHOOK_STATE_DIR=" + filepath.Join(workspace, ".akhook", "state"),
			"AXP_GATEWAY_URL=" + values["AXP_GATEWAY_URL"],
			"AXP_AGENT_KEY=" + values["AXP_AGENT_KEY"],
			"AXP_WORKSPACE_DIR=" + workspace,
		}
	}
	return out, nil
}

func connect(ctx context.Context, s plugins.Server, vars map[string]string) (mcp.Transport, error) {
	if s.URL != "" {
		headers := http.Header{}
		for name, value := range s.Headers {
			headers.Set(name, plugins.Expand(value, vars))
		}
		client := &http.Client{Transport: withHeaders{headers, http.DefaultTransport}}
		return &mcp.StreamableClientTransport{Endpoint: plugins.Expand(s.URL, vars), HTTPClient: client}, nil
	}
	args := make([]string, len(s.Args))
	for i, a := range s.Args {
		args[i] = plugins.Expand(a, vars)
	}
	cmd := exec.CommandContext(ctx, plugins.Expand(s.Command, vars), args...)
	cmd.Dir = plugins.Expand(s.Cwd, vars)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
	for name, value := range s.Env {
		cmd.Env = append(cmd.Env, name+"="+plugins.Expand(value, vars))
	}
	return &mcp.CommandTransport{Command: cmd}, nil
}

type withHeaders struct {
	headers http.Header
	next    http.RoundTripper
}

func (w withHeaders) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	for name, values := range w.headers {
		r.Header[name] = values
	}
	return w.next.RoundTrip(r)
}
