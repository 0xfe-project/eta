package container

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/moby/moby/client"
)

// Against this machine's Docker: AXP_TEST_DOCKER=1 go test ./internal/container/
func TestBuildRunListRemove(t *testing.T) {
	if os.Getenv("AXP_TEST_DOCKER") == "" {
		t.Skip("AXP_TEST_DOCKER is not set")
	}
	ctx := context.Background()
	d, err := NewDocker(true, "busybox:1.37")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM busybox:1.37\nCMD [\"sleep\", \"60\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tag := d.ImageTag("test-" + uuid.NewString()[:8])
	if failure, err := d.Build(ctx, dir, tag); err != nil {
		t.Fatalf("build: %v\n%s", err, failure)
	}
	t.Cleanup(func() { _ = d.Prune(context.Background(), nil) })
	if ok, err := d.HasImage(ctx, tag); err != nil || !ok {
		t.Fatalf("image %v %v", ok, err)
	}
	agent := uuid.NewString()
	t.Cleanup(func() { _ = d.Remove(context.Background(), agent) })
	if err := d.Run(ctx, Spec{AgentID: agent, Image: tag, Env: map[string]string{"A": "1"}, Config: "c1"}); err != nil {
		t.Fatal(err)
	}
	find := func() *Runtime {
		list, err := d.List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range list {
			if r.AgentID == agent {
				return &r
			}
		}
		return nil
	}
	r := find()
	if r == nil || r.State != Running || r.Config != "c1" || r.URL == "" {
		t.Fatalf("listed %+v", r)
	}
	// Run again replaces it; the volume stays.
	if err := d.Run(ctx, Spec{AgentID: agent, Image: tag, Config: "c2"}); err != nil {
		t.Fatal(err)
	}
	if r = find(); r == nil || r.Config != "c2" {
		t.Fatalf("replaced %+v", r)
	}
	if err := d.Remove(ctx, agent); err != nil {
		t.Fatal(err)
	}
	if r = find(); r != nil {
		t.Fatalf("still there: %+v", r)
	}
	t.Cleanup(func() {
		_, _ = d.client.VolumeRemove(context.Background(), d.name(agent), client.VolumeRemoveOptions{})
	})
}
