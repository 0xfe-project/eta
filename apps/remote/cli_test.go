package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCurrentTaskIsTheWorkspaceUnderTheRoot(t *testing.T) {
	root := t.TempDir()
	c := &Config{Root: root}
	dir := filepath.Join(root, "task-1", "web", "src")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	id, workspace, err := currentTask(c)
	if err != nil || id != "task-1" || workspace != filepath.Join(root, "task-1") {
		t.Fatalf("%q %q %v", id, workspace, err)
	}
	t.Chdir(root)
	if _, _, err := currentTask(c); err == nil {
		t.Fatal("the root itself is no task")
	}
	t.Setenv("AXP_TASK_ID", "task-2")
	if id, _, _ := currentTask(c); id != "task-2" {
		t.Fatal(id)
	}
}

func TestRepositoryNames(t *testing.T) {
	for in, want := range map[string]string{
		"acme/web": "acme/web", "https://github.com/acme/web.git": "acme/web",
		"git@github.com:acme/web.git": "acme/web", "https://github.com/acme/web/": "acme/web",
	} {
		m := repoPattern.FindStringSubmatch(in)
		if m == nil || m[1]+"/"+m[2] != want {
			t.Fatalf("%s: %v", in, m)
		}
	}
	if repoPattern.MatchString("acme") {
		t.Fatal("a name without an owner")
	}
}
