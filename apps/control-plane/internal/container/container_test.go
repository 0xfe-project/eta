package container

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/hashicorp/nomad/api"
)

func TestAnAgentsJob(t *testing.T) {
	n := &Nomad{Namespace: "test-agents"}
	job := n.job(Spec{AgentID: "a1", Image: "axp-agent:1", Env: map[string]string{"A": "1"}, Config: "c1"})
	if *job.ID != "agent-a1" || *job.Namespace != "test-agents" || job.Meta[configMeta] != "c1" {
		t.Fatalf("job %+v", job)
	}
	group := job.TaskGroups[0]
	if group.Volumes["home"].Source != "agent-a1" || group.Networks[0].Mode != "bridge" {
		t.Fatalf("group %+v", group)
	}
	task := group.Tasks[0]
	if task.Config["image"] != "axp-agent:1" || task.Env["A"] != "1" || *task.VolumeMounts[0].Destination != home || !*task.LogConfig.Disabled {
		t.Fatalf("task %+v", task)
	}
}

// The shape is what agents' jobs have in common, not their spec.
func TestTheShapeIsTheJobWithoutItsSpec(t *testing.T) {
	n := &Nomad{Namespace: "test-agents"}
	job := n.job(Spec{AgentID: "a1", Image: "axp-agent:1", Config: "c1"})
	if job.Meta[shapeMeta] == "" || job.Meta[shapeMeta] != n.job(Spec{AgentID: "a2", Image: "axp-agent:2", Config: "c2"}).Meta[shapeMeta] {
		t.Fatalf("shape %v", job.Meta)
	}
	if other := (&Nomad{Namespace: "elsewhere"}).shape(); other == n.shape() {
		t.Fatal("another shape has the same digest")
	}
}

// Against this machine's Nomad and Docker (scripts/dev.sh's): AXP_TEST_NOMAD=1 go test ./internal/container/
func TestBuildAndRunOnNomad(t *testing.T) {
	if os.Getenv("AXP_TEST_NOMAD") == "" {
		t.Skip("AXP_TEST_NOMAD is not set")
	}
	ctx := context.Background()
	client, err := api.NewClient(api.DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	namespace := "axp-test-" + uuid.NewString()[:8]
	if _, err := client.Namespaces().Register(&api.Namespace{Name: namespace}, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = client.Namespaces().Delete(namespace, nil) })
	n := &Nomad{Client: client, Namespace: namespace}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM busybox:1.37\nCMD [\"httpd\", \"-f\", \"-p\", \"8080\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tag := ImageTag("test-" + uuid.NewString()[:8])
	if failure, err := n.Build(ctx, dir, tag); err != nil {
		t.Fatalf("build: %v\n%s", err, failure)
	}
	t.Cleanup(func() { _ = n.Prune(context.Background(), nil) })
	if ok, err := n.HasImage(ctx, tag); err != nil || !ok {
		t.Fatalf("image %v %v", ok, err)
	}
	agent := uuid.NewString()
	if err := n.Run(ctx, Spec{AgentID: agent, Image: tag, Config: "c1"}); err != nil {
		t.Fatal(err)
	}
	for {
		list, err := n.List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(list) == 1 && list[0].State == Running && list[0].Config == "c1" && list[0].URL != "" {
			t.Log(list[0].URL)
			break
		}
	}
	// Run again replaces it; the volume stays.
	if err := n.Run(ctx, Spec{AgentID: agent, Image: tag, Config: "c2"}); err != nil {
		t.Fatal(err)
	}
	if list, _ := n.List(ctx); len(list) != 1 || list[0].Config != "c2" {
		t.Fatalf("replaced %+v", list)
	}
	if err := n.Remove(ctx, agent); err != nil {
		t.Fatal(err)
	}
	if list, _ := n.List(ctx); len(list) != 0 {
		t.Fatalf("still there: %+v", list)
	}
	volumes, _, err := client.HostVolumes().List(&api.HostVolumeListRequest{}, &api.QueryOptions{Namespace: namespace})
	if err != nil || len(volumes) != 1 || volumes[0].Name != "agent-"+agent {
		t.Fatalf("volumes %+v %v", volumes, err)
	}
	_, _, _ = client.HostVolumes().Delete(&api.HostVolumeDeleteRequest{ID: volumes[0].ID}, &api.WriteOptions{Namespace: namespace})
}
