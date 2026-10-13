package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestCurrentTaskComesFromTheFlagTheTabOrAXP(t *testing.T) {
	asked := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Query().Get("dir")
		_, _ = w.Write([]byte(`{"task_id":"from-dir"}`))
	}))
	defer srv.Close()
	c := &Config{URL: srv.URL, Token: "t"}
	dir := t.TempDir()
	t.Chdir(dir)
	if id, _ := currentTask(c, "12"); id != "12" {
		t.Fatal(id)
	}
	t.Setenv("AXP_TASK_ID", "")
	if id, err := currentTask(c, ""); err != nil || id != "from-dir" || asked != dir {
		t.Fatalf("%q %v asked %q", id, err, asked)
	}
	t.Setenv("AXP_TASK_ID", "from-tab")
	if id, _ := currentTask(c, ""); id != "from-tab" {
		t.Fatal(id)
	}
}

func TestTaskArgsTakeOnlyTheirFlags(t *testing.T) {
	for _, tc := range []struct {
		args       []string
		task, file string
		text       []string
	}{
		{args: []string{"- a", "--task", "3"}, task: "3", text: []string{"- a"}},
		{args: []string{"-task=3", "- [x] 完成", "-v"}, task: "3", text: []string{"- [x] 完成", "-v"}},
		{args: []string{"--file", "-", "--task", "#4"}, task: "#4", file: "-"},
		{args: []string{"--task", "3", "--", "--file", "x", "--"}, task: "3", text: []string{"--file", "x", "--"}},
	} {
		a, err := parseArgs(tc.args, "task", "file")
		if err != nil || a.flags["task"] != tc.task || a.flags["file"] != tc.file || !slices.Equal(a.positional, tc.text) {
			t.Errorf("%q: %+v %v", tc.args, a, err)
		}
	}
	if _, err := parseArgs([]string{"text", "--task"}, "task"); err == nil {
		t.Error("--task without its value")
	}
}

// remoteAXP is AXP's /remote API for a test, recording what it was sent;
// the CLI's configuration points at it.
func remoteAXP(t *testing.T, handle func(w http.ResponseWriter, path string, body map[string]any)) *Config {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		handle(w, r.URL.Path, body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AXP_CONFIG_DIR", t.TempDir())
	c := &Config{URL: srv.URL, Token: "old", ComputerID: "c1", Name: "laptop", Home: t.TempDir()}
	if err := c.save(); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCommentMayStartWithADash(t *testing.T) {
	var got string
	remoteAXP(t, func(w http.ResponseWriter, path string, body map[string]any) {
		got = path + " " + fmt.Sprint(body["body"])
		w.WriteHeader(http.StatusNoContent)
	})
	if err := taskCommand([]string{"comment", "- a", "--task", "3"}); err != nil {
		t.Fatal(err)
	}
	if got != "/remote/v1/tasks/3/comments - a" {
		t.Fatal(got)
	}
	if err := taskCommand([]string{"comment", "--task", "3", "--", "--help", "me"}); err != nil {
		t.Fatal(err)
	}
	if got != "/remote/v1/tasks/3/comments --help me" {
		t.Fatal(got)
	}
}

func TestSetupWithACodeEnrollsAgain(t *testing.T) {
	var enrolledWith any
	c := remoteAXP(t, func(w http.ResponseWriter, path string, body map[string]any) {
		switch path {
		case "/remote/v1/enroll":
			enrolledWith = body["code"]
			_, _ = w.Write([]byte(`{"computer_id":"c2","name":"laptop","token":"new","relay_url":"https://axp/remote/relay","connector_version":"0.2.0"}`))
		default: // The computer was removed: its token is gone.
			w.WriteHeader(http.StatusUnauthorized)
		}
	})
	// A connector paired under the removed computer's label.
	marker := filepath.Join(t.TempDir(), "calls")
	bin := c.connectorBin("paseo")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho \"$@\" >> "+marker+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	err := connect(c, "")
	if err == nil || !strings.Contains(err.Error(), "安装命令") {
		t.Fatalf("a rejected token should ask for the install command: %v", err)
	}
	if err := connect(c, "code-2"); err != nil {
		t.Fatal(err)
	}
	if enrolledWith != "code-2" || c.ConnectorVersion != "0.2.0" {
		t.Fatalf("enrolled with %v, to install %q", enrolledWith, c.ConnectorVersion)
	}
	saved, err := loadConfig()
	if err != nil || saved.Token != "new" || saved.ComputerID != "c2" || saved.RelayURL != "https://axp/remote/relay" {
		t.Fatalf("%+v %v", saved, err)
	}
	if calls, _ := os.ReadFile(marker); string(calls) != "disconnect\n" {
		t.Fatalf("the old pairing should be dropped, connector got %q", calls)
	}
}

func TestSetupWithACodeForTheSameComputerKeepsItsPairings(t *testing.T) {
	c := remoteAXP(t, func(w http.ResponseWriter, path string, body map[string]any) {
		_, _ = w.Write([]byte(`{"computer_id":"c1","name":"laptop","token":"new","relay_url":"https://axp/remote/relay"}`))
	})
	marker := filepath.Join(t.TempDir(), "calls")
	bin := c.connectorBin("paseo")
	_ = os.MkdirAll(filepath.Dir(bin), 0o755)
	_ = os.WriteFile(bin, []byte("#!/bin/sh\necho \"$@\" >> "+marker+"\n"), 0o755)
	if err := connect(c, "code-2"); err != nil || c.Token != "new" {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("pairings under the same computer's label should stay")
	}
}

// Setup run again learns the relay's new address from AXP and moves the
// paired connectors to it, keeping the rest of their configuration.
func TestSetupMovesPairedConnectorsToTheRelaysAddress(t *testing.T) {
	c := remoteAXP(t, func(w http.ResponseWriter, path string, body map[string]any) {
		_, _ = w.Write([]byte(`{"relay_url":"https://axp/remote/relay"}`))
	})
	c.RelayURL = "https://relay.old"
	c.Paseo, c.Herdr = &PaseoConfig{}, &HerdrConfig{}
	write := func(kind, data string) {
		_ = os.MkdirAll(c.connectorDir(kind), 0o700)
		_ = os.WriteFile(filepath.Join(c.connectorDir(kind), "config.json"), []byte(data), 0o600)
	}
	write("paseo", `{"relay":"https://relay.old","deviceId":"d1","instances":[{"id":"paseo"}]}`)
	write("herdr", `{"instances":[{"id":"herdr"}]}`) // not paired yet
	if err := connect(c, ""); err != nil {
		t.Fatal(err)
	}
	if err := followRelay(c); err != nil {
		t.Fatal(err)
	}
	var paseo map[string]any
	data, _ := os.ReadFile(filepath.Join(c.connectorDir("paseo"), "config.json"))
	_ = json.Unmarshal(data, &paseo)
	if paseo["relay"] != "https://axp/remote/relay" || paseo["deviceId"] != "d1" || len(paseo["instances"].([]any)) != 1 {
		t.Fatalf("paseo %s", data)
	}
	if data, _ := os.ReadFile(filepath.Join(c.connectorDir("herdr"), "config.json")); strings.Contains(string(data), "relay") {
		t.Fatalf("herdr %s", data)
	}
	if saved, _ := loadConfig(); saved.RelayURL != "https://axp/remote/relay" {
		t.Fatalf("saved %+v", saved)
	}
}

func TestSetupInstallsTheConnectorsAXPServesAtTheRelaysVersion(t *testing.T) {
	bin := t.TempDir()
	args := filepath.Join(t.TempDir(), "args")
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\necho \"$@\" > "+args+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	c := &Config{URL: "https://axp", Home: t.TempDir(), Paseo: &PaseoConfig{}, Herdr: &HerdrConfig{}}
	if err := installConnectors(c); err == nil {
		t.Fatal("without the relay's version there is nothing to install")
	}
	c.ConnectorVersion = "0.2.0+5ec6084157f7"
	if err := installConnectors(c); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(args)
	want := "install --global --prefix " + filepath.Join(c.Home, "agenvo") + " --no-audit --no-fund --loglevel=error" +
		" https://axp/remote/dl/agenvo-paseo-0.2.0+5ec6084157f7.tgz https://axp/remote/dl/agenvo-herdr-0.2.0+5ec6084157f7.tgz\n"
	if string(got) != want {
		t.Fatalf("npm %s", got)
	}
}
