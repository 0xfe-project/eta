package plugins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
	"gopkg.in/yaml.v3"
)

// The repository's plugins and Codex configuration.
var (
	repoPlugins = filepath.Join("..", "..", "apps", "agent-runtime", "plugins")
	repoCodex   = filepath.Join("..", "..", "apps", "agent-runtime", "codex")
)

func names(list []*Plugin) []string {
	out := []string{}
	for _, p := range list {
		out = append(out, p.Name)
	}
	return out
}

func expect[T any](t *testing.T, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestTargets(t *testing.T) {
	chat, err := List(repoPlugins, TargetChat)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, names(chat), []string{"approval", "github", "grok", "memory", "tasks"})
	routine, err := List(repoPlugins, TargetRoutine)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, names(routine), []string{"grok"})
}

func writePlugin(t *testing.T, root, name, manifest, mcp string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if mcp != "" {
		if err := os.WriteFile(filepath.Join(dir, "mcp.json"), []byte(mcp), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRefusesWhatNoTargetUnderstands(t *testing.T) {
	for name, c := range map[string][2]string{
		"unknown variable": {`{"name":"p","targets":["chat"]}`, `{"mcpServers":{"s":{"command":"x","args":["${HOME}"]}}}`},
		"no targets":       {`{"name":"p","targets":[]}`, ""},
		"unknown target":   {`{"name":"p","targets":["codex"]}`, ""},
		"other name":       {`{"name":"q","targets":["chat"]}`, ""},
		"no command":       {`{"name":"p","targets":["chat"]}`, `{"mcpServers":{"s":{}}}`},
	} {
		root := t.TempDir()
		writePlugin(t, root, "p", c[0], c[1])
		if _, err := List(root, ""); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestExpandLeavesUnknownValues(t *testing.T) {
	expect(t, Expand("${PLUGIN_ROOT}/x ${AXP_GATEWAY_URL}", map[string]string{"PLUGIN_ROOT": "/p"}), "/p/x ${AXP_GATEWAY_URL}")
}

func TestSetUpRunsFromThePluginWithItsCacheAndBin(t *testing.T) {
	root := t.TempDir()
	writePlugin(t, root, "p", `{"name":"p","targets":["routine"]}`, "")
	script := "#!/bin/sh\nset -eu\npwd > \"$AXP_PLUGIN_BIN/ran\"\necho \"$AXP_PLUGIN_CACHE\" >> \"$AXP_PLUGIN_BIN/ran\"\n"
	if err := os.WriteFile(filepath.Join(root, "p", "setup"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	list, err := List(root, TargetRoutine)
	if err != nil {
		t.Fatal(err)
	}
	cache, bin := t.TempDir(), t.TempDir()
	if err := SetUp(list, cache, bin); err != nil {
		t.Fatal(err)
	}
	ran, _ := os.ReadFile(filepath.Join(bin, "ran"))
	expect(t, string(ran), filepath.Join(root, "p")+"\n"+filepath.Join(cache, "p")+"\n")
	if err := os.WriteFile(filepath.Join(root, "p", "setup"), []byte("#!/bin/sh\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := SetUp(list, cache, bin); err == nil {
		t.Fatal("a failed setup passed")
	}
}

func TestSetupScriptsAreExecutable(t *testing.T) {
	list, err := List(repoPlugins, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range list {
		if p.Setup == "" {
			continue
		}
		info, err := os.Stat(p.Setup)
		if err != nil || info.Mode()&0o111 == 0 {
			t.Errorf("%s: setup is not executable", p.Name)
		}
	}
}

// --- the chat target --------------------------------------------------------------

// compiled is the repository's plugins compiled for Codex, in a copy.
func compiled(t *testing.T) (root, codex string) {
	t.Helper()
	root, codex = filepath.Join(t.TempDir(), "plugins"), filepath.Join(t.TempDir(), "codex")
	if err := os.CopyFS(root, os.DirFS(repoPlugins)); err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(codex, os.DirFS(repoCodex)); err != nil {
		t.Fatal(err)
	}
	if err := Chat(root, codex, "/opt/axp/plugins"); err != nil {
		t.Fatal(err)
	}
	return root, codex
}

func readTOML(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := toml.Unmarshal(data, &out); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return out
}

func readMCP(t *testing.T, root, plugin string) map[string]map[string]any {
	t.Helper()
	var file struct {
		Servers map[string]map[string]any `json:"mcpServers"`
	}
	data, err := os.ReadFile(filepath.Join(root, plugin, ".mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	return file.Servers
}

func TestMarketplaceListsTheChatPlugins(t *testing.T) {
	root, _ := compiled(t)
	var catalog struct {
		Name    string `json:"name"`
		Plugins []struct {
			Name   string `json:"name"`
			Source struct {
				Path string `json:"path"`
			} `json:"source"`
		} `json:"plugins"`
	}
	data, err := os.ReadFile(filepath.Join(root, ".agents/plugins/marketplace.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	expect(t, catalog.Name, "axp")
	var listed []string
	for _, p := range catalog.Plugins {
		listed = append(listed, p.Name)
		var manifest map[string]string
		data, err := os.ReadFile(filepath.Join(root, p.Source.Path, ".codex-plugin", "plugin.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &manifest); err != nil {
			t.Fatal(err)
		}
		expect(t, manifest["name"], p.Name)
	}
	chat, err := List(repoPlugins, TargetChat)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, listed, names(chat))
}

func TestCodexGetsTheAgentKeyItsWay(t *testing.T) {
	root, _ := compiled(t)
	expect(t, readMCP(t, root, "memory")["memory"], map[string]any{
		"type": "streamable-http", "url": "${AXP_GATEWAY_URL}/memory/mcp", "bearer_token_env_var": "AXP_RUNTIME_LLM_KEY",
	})
	// Codex passes the key on by name; the server wants it as XAI_API_KEY.
	expect(t, readMCP(t, root, "grok")["grok"], map[string]any{
		"command": "sh",
		"args": []any{"-c", `export XAI_API_KEY="$AXP_RUNTIME_LLM_KEY"; exec "$0" "$@"`,
			"grok-api", "--base-url", "${AXP_GATEWAY_URL}/v1", "--non-interactive", "mcp"},
		"cwd":      "${AXP_WORKSPACE_DIR}",
		"env_vars": []any{"AXP_RUNTIME_LLM_KEY"},
	})
	// The plugin's own files are where the image keeps it.
	expect(t, readMCP(t, root, "approval")["approval"]["cwd"], any("/opt/axp/plugins/approval"))
}

func TestEveryPluginToolIsApproved(t *testing.T) {
	_, codex := compiled(t)
	config := readTOML(t, filepath.Join(codex, "config.toml"))
	expect(t, config["sandbox_mode"], any("danger-full-access"))
	servers := map[string]bool{}
	for plugin, settings := range config["plugins"].(map[string]any) {
		for server, s := range settings.(map[string]any)["mcp_servers"].(map[string]any) {
			servers[plugin+" "+server] = true
			expect(t, s, any(map[string]any{"default_tools_approval_mode": "approve"}))
		}
	}
	chat, err := List(repoPlugins, TargetChat)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for _, p := range chat {
		for server := range p.Servers {
			want[p.Name+"@axp "+server] = true
		}
	}
	expect(t, servers, want)
}

func TestHooksBecomeAkhookRulesThatRunOnlyWhereInstalled(t *testing.T) {
	root, codex := compiled(t)
	data, err := os.ReadFile(filepath.Join(root, ChatHooks))
	if err != nil {
		t.Fatal(err)
	}
	var hooks Hooks
	if err := yaml.Unmarshal(data, &hooks); err != nil {
		t.Fatal(err)
	}
	got := map[string][]string{}
	for _, rule := range hooks.Rules {
		got[rule.On+" "+rule.ID] = rule.Run.Argv
	}
	guard := `[ -d "$CODEX_HOME/plugins/cache/axp/memory" ] || exit 0; export AXP_AGENT_KEY="$AXP_RUNTIME_LLM_KEY"; exec "$0" "$@"`
	expect(t, got, map[string][]string{
		"prompt_submit memory/recall": {"sh", "-c", guard, "python", "/opt/axp/plugins/memory/hooks/memory.py", "recall"},
		"stop memory/capture":         {"sh", "-c", guard, "python", "/opt/axp/plugins/memory/hooks/memory.py", "capture"},
	})
	// Codex runs akhook for every hook; nothing is generated there.
	requirements := readTOML(t, filepath.Join(codex, "requirements.toml"))
	expect(t, requirements["allow_managed_hooks_only"], any(true))
	for event, action := range map[string]string{"PreToolUse": "pre_tool_use", "UserPromptSubmit": "prompt_submit", "Stop": "stop"} {
		groups := requirements["hooks"].(map[string]any)[event].([]any)
		if len(groups) != 1 {
			t.Fatalf("%s: %d groups", event, len(groups))
		}
		hook := groups[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)
		expect(t, hook["command"], any("akhook codex hook "+action))
	}
}

func TestPluginHooksAreLifecycleRulesOnly(t *testing.T) {
	for name, hooks := range map[string]string{
		"tool rule":    "version: 1\nrules:\n  - id: r\n    on: shell_exec\n    run: {argv: [x]}\n",
		"no argv":      "version: 1\nrules:\n  - id: r\n    on: stop\n",
		"other field":  "version: 1\nrules:\n  - id: r\n    on: stop\n    run: {argv: [x]}\n    message: m\n",
		"env variable": "version: 1\nrules:\n  - id: r\n    on: stop\n    run: {argv: [x, '${AXP_AGENT_KEY}']}\n",
	} {
		root := t.TempDir()
		writePlugin(t, root, "p", `{"name":"p","targets":["chat"]}`, "")
		if err := os.WriteFile(filepath.Join(root, "p", "akhook.yml"), []byte(hooks), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := List(root, ""); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	root := t.TempDir()
	writePlugin(t, root, "p", `{"name":"p","targets":["chat"]}`, "")
	if err := os.MkdirAll(filepath.Join(root, "p", "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "p", "hooks", "hooks.json"), []byte(`{"hooks":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := List(root, ""); err == nil || !strings.Contains(err.Error(), "akhook.yml") {
		t.Fatalf("hooks.json: %v", err)
	}
}
