// Package adk loads plugins into ADK agents: the routine target.
//
// A plugin's MCP servers become MCP toolsets and its skills one skill
// toolset. Hooks are not supported yet: they move to akhook first
// (aghub-app/akhook#8), so a plugin with hooks is refused rather than run
// without them.
package adk

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"

	plugins "github.com/akarachen/axp/packages/plugins-go"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/mcptoolset"
	"google.golang.org/adk/v2/tool/skilltoolset"
	"google.golang.org/adk/v2/tool/skilltoolset/skill"
)

// Toolsets are the plugins' tools for one agent run. values are the
// variables' values but PLUGIN_ROOT; the MCP servers' processes end with ctx.
// A stdio server gets PATH, HOME and its own env, nothing else of this
// process's.
func Toolsets(ctx context.Context, list []*plugins.Plugin, values map[string]string) ([]tool.Toolset, error) {
	var toolsets []tool.Toolset
	var skills []skill.Source
	for _, p := range list {
		if p.Hooks != "" {
			return nil, fmt.Errorf("plugin %s has hooks, which ADK agents cannot run yet", p.Name)
		}
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
			toolsets = append(toolsets, ts)
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
		toolsets = append(toolsets, ts)
	}
	return toolsets, nil
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
