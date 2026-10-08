package main

import (
	"net/http"
	"net/http/httptest"
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
