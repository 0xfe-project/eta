package adk

import (
	"context"
	"fmt"
	"iter"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	plugins "github.com/akarachen/axp/packages/plugins-go"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/genai"
)

// The test binary is the test plugin's MCP server when this is set.
const serverEnv = "AXP_TEST_MCP_SERVER"

func TestMain(m *testing.M) {
	if os.Getenv(serverEnv) != "" {
		serve()
		return
	}
	os.Exit(m.Run())
}

type echoIn struct {
	Text string `json:"text"`
}

// serve is a stdio MCP server whose echo tool answers with its input, the
// variable it was given, and whether it sees this process's environment.
func serve() {
	_ = os.WriteFile("pid", []byte(strconv.Itoa(os.Getpid())), 0o644)
	server := mcp.NewServer(&mcp.Implementation{Name: "echo"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "echo", Description: "Echo the text."},
		func(_ context.Context, _ *mcp.CallToolRequest, in echoIn) (*mcp.CallToolResult, any, error) {
			text := in.Text + " " + os.Getenv("ECHO_KEY") + " leaked=" + os.Getenv("SECRET")
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil, nil
		})
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		os.Exit(1)
	}
}

func plugin(t *testing.T, mcpJSON string) *plugins.Plugin {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "echo")
	if err := os.MkdirAll(filepath.Join(dir, "skills", "echoing"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"plugin.json":             `{"name":"echo","version":"1","description":"Echo.","targets":["routine"]}`,
		"mcp.json":                mcpJSON,
		"skills/echoing/SKILL.md": "---\nname: echoing\ndescription: How to echo.\n---\n\nCall echo.\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p, err := plugins.Read(dir)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// scripted is a model that calls echo once, then answers with what it got.
type scripted struct{ calls int }

func (m *scripted) Name() string { return "scripted" }

func (m *scripted) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.calls++
		if m.calls == 1 {
			if _, ok := req.Tools["load_skill"]; !ok {
				yield(nil, fmt.Errorf("no skill tools in %v", req.Tools))
				return
			}
			yield(&model.LLMResponse{Content: genai.NewContentFromFunctionCall("echo", map[string]any{"text": "hi"}, genai.RoleModel)}, nil)
			return
		}
		last := req.Contents[len(req.Contents)-1].Parts[0].FunctionResponse
		yield(&model.LLMResponse{Content: genai.NewContentFromText(fmt.Sprint(last.Response["output"]), genai.RoleModel)}, nil)
	}
}

func TestStdioServerAndSkills(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SECRET", "from the service")
	p := plugin(t, `{"mcpServers":{"echo":{"command":"`+self+`","env":{"`+serverEnv+`":"1","ECHO_KEY":"${AXP_AGENT_KEY}"},"cwd":"${PLUGIN_ROOT}"}}}`)
	ctx, cancel := context.WithCancel(context.Background())
	loaded, err := Load(ctx, []*plugins.Plugin{p}, map[string]string{"AXP_AGENT_KEY": "key-1", "AXP_WORKSPACE_DIR": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	config := llmagent.Config{Name: "test", Model: &scripted{}}
	loaded.Install(&config)
	a, err := llmagent.New(config)
	if err != nil {
		t.Fatal(err)
	}
	r, err := runner.NewInMemory("test", a)
	if err != nil {
		t.Fatal(err)
	}
	var answer string
	for event, err := range r.Run(ctx, "u", "s", genai.NewContentFromText("go", genai.RoleUser), agent.RunConfig{}) {
		if err != nil {
			t.Fatal(err)
		}
		if event.Content != nil && event.Content.Parts[0].Text != "" {
			answer = event.Content.Parts[0].Text
		}
	}
	// The server got the agent key and nothing of this process's environment.
	if answer != "hi key-1 leaked=" {
		t.Fatalf("answer %q", answer)
	}
	// It ran from the plugin and ends with the run.
	data, err := os.ReadFile(filepath.Join(p.Dir, "pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(string(data))
	cancel()
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatal("the server outlived its run")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// akhook is AKHOOK_BIN, the one turbo builds (@axp/akhook), or akhook on
// PATH. Locally its tests wait for it; in CI (CI set) a missing akhook fails.
func akhookBinary(t *testing.T) string {
	if bin := os.Getenv("AKHOOK_BIN"); bin != "" {
		return bin
	}
	if built, err := filepath.Abs("../../akhook/out/akhook"); err == nil {
		if _, err := os.Stat(built); err == nil {
			return built
		}
	}
	bin, err := exec.LookPath("akhook")
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatal("CI: akhook is not built (turbo run build --filter=@axp/akhook)")
		}
		t.Skip("set AKHOOK_BIN or put akhook on PATH")
	}
	return bin
}

// A plugin's hooks run through akhook: prompt_submit's context reaches the
// model, with the agent's key in the command's environment.
func TestHooksRunThroughAkhook(t *testing.T) {
	bin := akhookBinary(t)
	t.Setenv("PATH", filepath.Dir(bin)+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := plugin(t, `{"mcpServers":{}}`)
	hooks := "version: 1\nrules:\n  - id: hello\n    on: prompt_submit\n    run:\n      argv: [sh, '${PLUGIN_ROOT}/hello']\n"
	if err := os.WriteFile(filepath.Join(p.Dir, "akhook.yml"), []byte(hooks), 0o644); err != nil {
		t.Fatal(err)
	}
	script := `printf '{"context": "key is %s"}' "$AXP_AGENT_KEY"`
	if err := os.WriteFile(filepath.Join(p.Dir, "hello"), []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	p, err := plugins.Read(p.Dir)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(context.Background(), []*plugins.Plugin{p}, map[string]string{"AXP_AGENT_KEY": "key-1", "AXP_WORKSPACE_DIR": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	model := &recording{}
	config := llmagent.Config{Name: "test", Model: model}
	loaded.Install(&config)
	a, err := llmagent.New(config)
	if err != nil {
		t.Fatal(err)
	}
	r, err := runner.NewInMemory("test", a)
	if err != nil {
		t.Fatal(err)
	}
	for _, err := range r.Run(context.Background(), "u", "s", genai.NewContentFromText("hi", genai.RoleUser), agent.RunConfig{}) {
		if err != nil {
			t.Fatal(err)
		}
	}
	system := model.request.Config.SystemInstruction
	if system == nil || !strings.Contains(fmt.Sprint(system.Parts[len(system.Parts)-1].Text), "key is key-1") {
		t.Fatalf("system %+v", system)
	}
}

// recording answers once and keeps the request.
type recording struct{ request *model.LLMRequest }

func (m *recording) Name() string { return "recording" }

func (m *recording) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	m.request = req
	return func(yield func(*model.LLMResponse, error) bool) {
		yield(&model.LLMResponse{Content: genai.NewContentFromText("done", genai.RoleModel)}, nil)
	}
}
