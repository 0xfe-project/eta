package bundles

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func parse(t *testing.T, text string) (*ConfigSchema, error) {
	t.Helper()
	var raw map[string]any
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		t.Fatal(err)
	}
	return parseConfig(raw)
}

func mustParse(t *testing.T, text string) *ConfigSchema {
	t.Helper()
	s, err := parse(t, text)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

const weather = `{"type": "object", "additionalProperties": false, "required": ["WEATHER_KEY"], "properties": {
	"WEATHER_KEY": {"type": "string", "writeOnly": true, "maxLength": 64},
	"WEATHER_CITY": {"type": "string", "title": "城市", "maxLength": 5}}}`

func TestConfigSchemaIsCheckedAgainstTheMetaSchema(t *testing.T) {
	mustParse(t, weather)
	for name, text := range map[string]string{
		"lower case":   `{"type": "object", "additionalProperties": false, "properties": {"api_key": {"type": "string", "maxLength": 9}}}`,
		"AXP's":        `{"type": "object", "additionalProperties": false, "properties": {"AXP_AGENT_KEY": {"type": "string", "maxLength": 9}}}`,
		"PATH":         `{"type": "object", "additionalProperties": false, "properties": {"PATH": {"type": "string", "maxLength": 9}}}`,
		"not a string": `{"type": "object", "additionalProperties": false, "properties": {"PORT": {"type": "number", "maxLength": 9}}}`,
		"no maxLength": `{"type": "object", "additionalProperties": false, "properties": {"A": {"type": "string"}}}`,
		"open":         `{"type": "object", "properties": {"A": {"type": "string", "maxLength": 9}}}`,
		"other words":  `{"type": "object", "additionalProperties": false, "properties": {"A": {"type": "string", "maxLength": 9, "default": "x"}}}`,
		"empty":        `{"type": "object", "additionalProperties": false, "properties": {}}`,
	} {
		if _, err := parse(t, text); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestValuesAreCheckedAgainstTheBundlesSchema(t *testing.T) {
	s := mustParse(t, weather)
	if s.ready(map[string]string{"WEATHER_CITY": "Paris"}) || !s.ready(map[string]string{"WEATHER_KEY": "k"}) {
		t.Fatal("ready")
	}
	if s.partial.Validate(instance(map[string]string{"WEATHER_CITY": "Paris"})) != nil {
		t.Fatal("a save without the required value")
	}
	err := s.invalid(map[string]string{"WEATHER_KEY": strings.Repeat("s", 65), "WEATHER_CITY": "Paris", "OTHER": "x"})
	if got := err.Error(); !strings.Contains(got, "OTHER、WEATHER_KEY") || strings.Contains(got, "sss") {
		t.Fatal(got)
	}
}

func TestEnvironmentGivesReadyBundlesTheirValues(t *testing.T) {
	w := Bundle{Name: "weather", Plugins: []string{"weather", "shared"}, config: mustParse(t, weather)}
	plain := Bundle{Name: "tasks", Plugins: []string{"tasks"}}
	other := Bundle{Name: "other", Plugins: []string{"shared"}}

	env, disabled := Environment([]Bundle{plain, w}, nil)
	if len(env) != 0 || !reflect.DeepEqual(disabled, []string{"shared", "weather"}) {
		t.Fatalf("unset: %v %v", env, disabled)
	}
	// A plugin another bundle adds stays.
	_, disabled = Environment([]Bundle{other, w}, nil)
	if !reflect.DeepEqual(disabled, []string{"weather"}) {
		t.Fatalf("shared: %v", disabled)
	}
	configs := map[string]map[string]string{"weather": {"WEATHER_KEY": "k", "STALE": "x"}}
	env, disabled = Environment([]Bundle{plain, w}, configs)
	if !reflect.DeepEqual(env, map[string]string{"WEATHER_KEY": "k"}) || disabled != nil {
		t.Fatalf("ready: %v %v", env, disabled)
	}
}

func TestStateLeavesSecretsOut(t *testing.T) {
	got := state(mustParse(t, weather), map[string]string{"WEATHER_KEY": "secret-value", "WEATHER_CITY": "a"}, nil)
	if !got.Ready || !reflect.DeepEqual(got.Set, []string{"WEATHER_CITY", "WEATHER_KEY"}) || !reflect.DeepEqual(got.Values, map[string]string{"WEATHER_CITY": "a"}) {
		t.Fatalf("%+v", got)
	}
}
