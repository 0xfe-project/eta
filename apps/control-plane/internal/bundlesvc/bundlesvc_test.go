package bundlesvc

import (
	"testing"

	"github.com/hashicorp/nomad/api"
)

func memoryJob() *api.Job {
	task := api.NewTask("memory", "docker")
	task.Config = map[string]any{"image": "axp-memory"}
	task.Env = map[string]string{"OWN": "1", "AXP_VERSION": "theirs"}
	other := api.NewTask("other", "docker")
	other.Config = map[string]any{"image": "example.com/axp-x:1"}
	group := api.NewTaskGroup("memory", 1)
	group.Services = []*api.Service{{Name: "memory", Provider: "nomad", PortLabel: "8320", AddressMode: "alloc"}}
	group.Tasks = []*api.Task{task, other}
	job := api.NewServiceJob("whatever", "whatever", "", 50)
	job.TaskGroups = []*api.TaskGroup{group}
	return job
}

func TestPrepareMakesTheJobTheBundles(t *testing.T) {
	r := &Reconciler{Namespace: "axp", ImageTag: "abc"}
	job := memoryJob()
	if err := r.prepare(job, "memory", map[string]string{"AXP_VERSION": "abc", "DATABASE_URL": "postgres://x"}, "rev1"); err != nil {
		t.Fatal(err)
	}
	if *job.ID != "bundle-memory" || *job.Namespace != "axp" || job.Meta[bundleMeta] != "memory" || job.Meta[revisionMeta] != "rev1" {
		t.Fatalf("job %+v", job)
	}
	tasks := job.TaskGroups[0].Tasks
	if got := tasks[0].Config["image"]; got != "axp-memory:abc" {
		t.Fatalf("AXP's image %v", got)
	}
	if got := tasks[1].Config["image"]; got != "example.com/axp-x:1" {
		t.Fatalf("another registry's image %v", got)
	}
	// AXP's values win; the job's own stay.
	if tasks[0].Env["AXP_VERSION"] != "abc" || tasks[0].Env["OWN"] != "1" || tasks[1].Env["DATABASE_URL"] != "postgres://x" {
		t.Fatalf("env %v %v", tasks[0].Env, tasks[1].Env)
	}
	if !*tasks[0].LogConfig.Disabled || !*tasks[1].LogConfig.Disabled {
		t.Fatal("Nomad collects the service's logs")
	}
}

func TestOnlyServiceJobsWithTheBundlesService(t *testing.T) {
	r := &Reconciler{Namespace: "axp", ImageTag: "abc"}
	batch := memoryJob()
	batch.Type = new(api.JobTypeBatch)
	if err := r.prepare(batch, "memory", nil, "rev1"); err == nil {
		t.Error("accepted a batch job")
	}
	unnamed := memoryJob()
	unnamed.TaskGroups[0].Services[0].Name = "other"
	if err := r.prepare(unnamed, "memory", nil, "rev1"); err == nil {
		t.Error("accepted a job without the bundle's service")
	}
	consul := memoryJob()
	consul.TaskGroups[0].Services[0].Provider = "consul"
	if err := r.prepare(consul, "memory", nil, "rev1"); err == nil {
		t.Error("accepted a Consul service")
	}
}

func TestServicesReportThroughTheRuntimeGateway(t *testing.T) {
	got := gatewayDSN("http://abc@127.0.0.1:24080/1", "http://172.26.64.1:24090")
	if want := "http://abc@172.26.64.1:24090/sentry/1"; got != want {
		t.Fatalf("gatewayDSN = %q, want %q", got, want)
	}
	if got := gatewayDSN("", "http://runtime-gateway:8090"); got != "" {
		t.Fatalf("without a DSN, got %q", got)
	}
}
