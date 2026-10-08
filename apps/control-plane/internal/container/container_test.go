package container

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
)

// Against this machine's Docker and development's runtime image:
// AXP_TEST_DOCKER=1 go test ./internal/container/
func TestStartStateStop(t *testing.T) {
	if os.Getenv("AXP_TEST_DOCKER") == "" {
		t.Skip("AXP_TEST_DOCKER is not set")
	}
	ctx := context.Background()
	d, err := NewDocker(true)
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	started, err := d.Start(ctx, Spec{
		AgentID: id, InstanceID: id, Name: d.Name("test-" + id[:8]),
		Env: map[string]string{"A": "1"}, Command: []string{"sleep", "60"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Stop(context.Background(), started.ContainerID) })
	if started.ImageDigest == "" {
		t.Fatal("no image digest")
	}
	if state, err := d.State(ctx, started.ContainerID); err != nil || state != Running {
		t.Fatalf("state %q %v", state, err)
	}
	if err := d.Stop(ctx, started.ContainerID); err != nil {
		t.Fatal(err)
	}
	if state, err := d.State(ctx, started.ContainerID); err != nil || state != Missing {
		t.Fatalf("state after stop %q %v", state, err)
	}
	// Stopping what is gone is fine.
	if err := d.Stop(ctx, started.ContainerID); err != nil {
		t.Fatal(err)
	}
}
