package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
)

const weatherKey = "wk-secret-123456"

// withWeather swaps the built-in bundles for tasks and weather, whose
// config is a secret key (required) and a city; weather adds grok.
func withWeather(t *testing.T, e *env) {
	dir := t.TempDir()
	write := func(name, manifest string) {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name, "bundle.json"), []byte(manifest), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("tasks", `{"name": "tasks", "description": "任务", "plugins": ["tasks"]}`)
	write("weather", `{"name": "weather", "description": "天气", "plugins": ["grok"], "config": {
		"type": "object", "required": ["WEATHER_KEY"], "properties": {
			"WEATHER_KEY": {"type": "string", "title": "Key", "writeOnly": true},
			"WEATHER_CITY": {"type": "string", "title": "城市", "maxLength": 20}}}}`)
	catalog := &bundles.Catalog{Dir: dir, Plugins: &plugins.Catalog{Dir: repoPlugins}}
	e.chat.Bundles, e.controller.Bundles = catalog, catalog
}

func TestBundleConfigBecomesTheAgentsEnvironment(t *testing.T) {
	e := newEnv(t)
	withWeather(t, e)
	r := e.post("/agents", map[string]any{"name": "a", "model": testModel, "bundles": []string{"tasks", "weather"}})
	expect(t, r.status, 201)
	agent := r.m(t)["id"].(string)
	var listed []bundles.Bundle
	e.get("/bundles").json(t, &listed)
	expect(t, listed[1].Config.Properties["WEATHER_KEY"].WriteOnly, true)

	// Nothing set: the agent goes without the bundle's plugins.
	expect(t, e.get("/bundles/weather/config").m(t)["ready"], any(false))
	e.settle()
	runs := e.driver.runsOf(agent)
	expect(t, runs[0].Env["AXP_DISABLED_PLUGINS"], "grok")
	run := func(n int) map[string]string {
		t.Helper()
		e.tick()
		runs := e.driver.runsOf(agent)
		expect(t, len(runs), n)
		return runs[n-1].Env
	}

	set := func(values map[string]any) response {
		return do(t, e.public, http.MethodPatch, "/api/v1/bundles/weather/config", map[string]any{"values": values}, nil)
	}
	r = set(map[string]any{"WEATHER_KEY": weatherKey, "WEATHER_CITY": " Paris "})
	expect(t, r.status, 200)
	if strings.Contains(string(r.body), weatherKey) || strings.Contains(string(e.get("/bundles/weather/config").body), weatherKey) {
		t.Fatal("the secret came back")
	}
	expect(t, r.m(t)["ready"], any(true))
	expect(t, r.m(t)["values"].(map[string]any)["WEATHER_CITY"], any("Paris"))
	expect(t, len(r.m(t)["set"].([]any)), 2)
	var sealed []byte
	if err := e.db.QueryRow(e.ctx, "SELECT sealed FROM bundle_config").Scan(&sealed); err != nil || strings.Contains(string(sealed), weatherKey) {
		t.Fatalf("stored in the clear (%v)", err)
	}
	env := run(2)
	expect(t, env["WEATHER_KEY"], weatherKey)
	expect(t, env["WEATHER_CITY"], "Paris")
	expect(t, env["AXP_DISABLED_PLUGINS"], "")

	// Left out stays, null clears.
	expect(t, set(map[string]any{"WEATHER_CITY": nil}).status, 200)
	env = run(3)
	expect(t, env["WEATHER_KEY"], weatherKey)
	expect(t, env["WEATHER_CITY"], "")

	expectError(t, set(map[string]any{"PATH": "/tmp"}), 422, "CONFIG_UNKNOWN")
	expectError(t, set(map[string]any{"WEATHER_CITY": strings.Repeat("长", 21)}), 422, "CONFIG_INVALID")
	expectError(t, e.get("/bundles/tasks/config"), 404, "NOT_FOUND")

	expect(t, e.delete("/bundles/weather/config").status, 204)
	env = run(4)
	expect(t, env["WEATHER_KEY"], "")
	expect(t, env["AXP_DISABLED_PLUGINS"], "grok")
}
