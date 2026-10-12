package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// mcp calls a tool of the routines plugin as agent; it is the tool's result
// (JSON), or its error text.
func (e *env) mcp(agent, tool string, args map[string]any) (map[string]any, string) {
	e.t.Helper()
	v, _, errText := e.mcpResult(agent, tool, args)
	return v, errText
}

// mcpResult is mcp with the result's _meta.
func (e *env) mcpResult(agent, tool string, args map[string]any) (v, meta map[string]any, errText string) {
	e.t.Helper()
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": tool, "arguments": args},
	})
	req, _ := http.NewRequest(http.MethodPost, e.server.URL+"/routines/mcp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if agent != "" {
		req.Header.Set("X-AXP-Agent-Id", agent)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, nil, string(data)
	}
	var out struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			Meta map[string]any `json:"_meta"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &out); err != nil || len(out.Result.Content) == 0 {
		e.t.Fatalf("%s: %s", tool, data)
	}
	if out.Result.IsError {
		return nil, nil, out.Result.Content[0].Text
	}
	_ = json.Unmarshal([]byte(out.Result.Content[0].Text), &v)
	return v, out.Result.Meta, ""
}

// A chat agent sets up a routine from the conversation, reads it and changes
// it, as RFC #23 §6 describes.
func TestAChatAgentManagesRoutines(t *testing.T) {
	e := newEnv(t)
	const agent = "00000000-0000-0000-0000-0000000000a1"
	_, errText := e.mcp(agent, "create_routine", map[string]any{
		"name": "日报", "brief": "整理科技新闻。", "timezone": "Asia/Shanghai",
		"schedule": map[string]any{"kind": "daily", "time": "08:00"},
	})
	if !strings.Contains(errText, "pass a model") {
		t.Fatalf("with no routine to take a model from: %q", errText)
	}
	created, errText := e.mcp(agent, "create_routine", map[string]any{
		"name": "日报", "brief": "整理科技新闻。", "timezone": "Asia/Shanghai", "model": testModel,
		"schedule": map[string]any{"kind": "weekly", "days": []int{1, 5}, "time": "07:30"},
	})
	if errText != "" {
		t.Fatal(errText)
	}
	id := created["id"].(string)
	expect(t, e.schedules.schedules[id], [2]string{"30 7 * * 1,5", "Asia/Shanghai"})
	// The next one takes the latest routine's model.
	if _, errText := e.mcp(agent, "create_routine", map[string]any{
		"name": "周报", "brief": "总结一周。", "timezone": "UTC",
		"schedule": map[string]any{"kind": "hourly", "every": 6},
	}); errText != "" {
		t.Fatal(errText)
	}

	list, _ := e.mcp(agent, "list_routines", map[string]any{})
	expect(t, len(list["routines"].([]any)), 2)
	if _, errText := e.mcp(agent, "update_routine", map[string]any{"routine": id, "brief": "只要 AI 新闻。", "enabled": false}); errText != "" {
		t.Fatal(errText)
	}
	shown, meta, _ := e.mcpResult(agent, "get_routine", map[string]any{"routine": id})
	// The transcript links the call to the routine.
	expect(t, fmt.Sprint(meta["axp/ref"]), fmt.Sprintf("map[id:%s kind:routine title:日报]", id))
	briefs := shown["briefs"].([]any)
	expect(t, briefs[0].(map[string]any)["text"], any("只要 AI 新闻。"))
	expect(t, len(briefs), 2)
	expect(t, shown["enabled"], any(false))
	if _, ok := e.schedules.schedules[id]; ok {
		t.Fatal("a paused routine keeps its schedule")
	}

	e.llm.script = steps(finishCall("# 今日 AI\n\n三条新闻", "交接"))
	if _, errText := e.mcp(agent, "run_routine", map[string]any{"routine": id}); errText != "" {
		t.Fatal(errText)
	}
	e.tick()
	shown, _ = e.mcp(agent, "get_routine", map[string]any{"routine": id})
	run := shown["runs"].([]any)[0].(map[string]any)
	got, errText := e.mcp(agent, "get_run", map[string]any{"routine": id, "run": run["id"]})
	if errText != "" || got["report"] != "# 今日 AI\n\n三条新闻" {
		t.Fatalf("%v %q", got, errText)
	}
}

// Only agents, through the runtime gateway, reach it.
func TestTheRoutinesPluginIsForAgents(t *testing.T) {
	e := newEnv(t)
	_, errText := e.mcp("", "list_routines", map[string]any{})
	if !strings.Contains(errText, "only for agents") {
		t.Fatalf("%q", errText)
	}
}
