package bundles

import (
	"reflect"
	"strings"
	"testing"
)

func str(p ConfigProperty) ConfigProperty { p.Type = "string"; return p }

func TestSchemaNamesEnvironmentVariablesABundleMaySet(t *testing.T) {
	ok := &ConfigSchema{Type: "object", Properties: map[string]ConfigProperty{"OO_API_KEY": str(ConfigProperty{WriteOnly: true})}, Required: []string{"OO_API_KEY"}}
	if err := ok.check(); err != nil {
		t.Fatal(err)
	}
	for name, s := range map[string]*ConfigSchema{
		"lower case": {Type: "object", Properties: map[string]ConfigProperty{"api_key": str(ConfigProperty{})}},
		"AXP's":      {Type: "object", Properties: map[string]ConfigProperty{"AXP_AGENT_KEY": str(ConfigProperty{})}},
		"PATH":       {Type: "object", Properties: map[string]ConfigProperty{"PATH": str(ConfigProperty{})}},
		"not string": {Type: "object", Properties: map[string]ConfigProperty{"PORT": {Type: "number"}}},
		"required":   {Type: "object", Properties: map[string]ConfigProperty{"A": str(ConfigProperty{})}, Required: []string{"B"}},
		"empty":      {Type: "object"},
	} {
		if err := s.check(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestEnvironmentGivesReadyBundlesTheirValues(t *testing.T) {
	weather := Bundle{Name: "weather", Plugins: []string{"weather", "shared"}, Config: &ConfigSchema{Type: "object",
		Properties: map[string]ConfigProperty{"WEATHER_KEY": str(ConfigProperty{}), "WEATHER_CITY": str(ConfigProperty{})}, Required: []string{"WEATHER_KEY"}}}
	plain := Bundle{Name: "tasks", Plugins: []string{"tasks"}}
	other := Bundle{Name: "other", Plugins: []string{"shared"}}

	env, disabled := Environment([]Bundle{plain, weather}, nil)
	if len(env) != 0 || !reflect.DeepEqual(disabled, []string{"shared", "weather"}) {
		t.Fatalf("unset: %v %v", env, disabled)
	}
	// A plugin another bundle adds stays.
	_, disabled = Environment([]Bundle{other, weather}, nil)
	if !reflect.DeepEqual(disabled, []string{"weather"}) {
		t.Fatalf("shared: %v", disabled)
	}
	configs := map[string]map[string]string{"weather": {"WEATHER_KEY": "k", "STALE": "x"}}
	env, disabled = Environment([]Bundle{plain, weather}, configs)
	if !reflect.DeepEqual(env, map[string]string{"WEATHER_KEY": "k"}) || disabled != nil {
		t.Fatalf("ready: %v %v", env, disabled)
	}
}

func TestStateLeavesSecretsOut(t *testing.T) {
	s := &ConfigSchema{Type: "object", Properties: map[string]ConfigProperty{"KEY": str(ConfigProperty{WriteOnly: true}), "TEAM": str(ConfigProperty{})}, Required: []string{"KEY", "TEAM"}}
	got := state(s, map[string]string{"KEY": "secret-value", "TEAM": "a"}, nil)
	if !got.Ready || !reflect.DeepEqual(got.Set, []string{"KEY", "TEAM"}) || !reflect.DeepEqual(got.Values, map[string]string{"TEAM": "a"}) {
		t.Fatalf("%+v", got)
	}
	if strings.Contains(strings.Join(mapValues(got.Values), ","), "secret") {
		t.Fatal("secret shown")
	}
}

func mapValues(m map[string]string) []string {
	var out []string
	for _, v := range m {
		out = append(out, v)
	}
	return out
}
