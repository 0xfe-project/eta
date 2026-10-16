// Package container runs agents' runtimes on Nomad: one job per agent in
// the agents' namespace, from an image built for it, with its state on a
// host volume of its own. Images are built with this machine's Docker,
// which the Nomad client runs containers from, so there is no registry.
// Only the controller drives this.
package container

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/hashicorp/nomad/api"
)

const (
	configMeta  = "axp.config"
	stopSeconds = 10
	// The runtime's control API (apps/agent-runtime/src/server.ts).
	controlPort = 8080
	// The volume's mount point, the runtime's AXP_HOME.
	home = "/agent"
)

// Spec is an agent's runtime.
type Spec struct {
	AgentID string
	Image   string
	Env     map[string]string
	// What the runtime was created from; a different one replaces it.
	Config string
}

// Runtime is an agent's runtime as it is.
type Runtime struct {
	AgentID string
	Config  string
	// Running or Starting (pulling, starting again after a crash).
	State string
	// The control API, while running.
	URL string
}

const (
	Running  = "running"
	Starting = "starting"
)

// Driver runs agents' runtimes and builds their images.
type Driver interface {
	// List is the agents' runtimes.
	List(ctx context.Context) ([]Runtime, error)
	// Run replaces the agent's runtime (its volume stays) with a new one.
	Run(ctx context.Context, spec Spec) error
	// Remove stops and removes the agent's runtime; its volume stays.
	Remove(ctx context.Context, agentID string) error
	// Base is the digest of the image agents' images are built on, and its
	// name.
	Base(ctx context.Context) (id, ref string, err error)
	HasImage(ctx context.Context, tag string) (bool, error)
	// Build builds dir (with its Dockerfile) as tag; a failure returns the
	// end of the build's output.
	Build(ctx context.Context, dir, tag string) (failure string, err error)
	// Prune removes agent images except keep.
	Prune(ctx context.Context, keep []string) error
}

// Nomad runs agents as jobs in Namespace, on this machine's Docker.
type Nomad struct {
	Client    *api.Client
	Namespace string
	// The runtime image agents' images are built on, in Docker.
	BaseImage string

	// Running allocations' addresses, which do not change.
	addresses map[string]string
}

func jobID(agentID string) string { return "agent-" + agentID }

func (n *Nomad) query(ctx context.Context) *api.QueryOptions {
	return (&api.QueryOptions{Namespace: n.Namespace}).WithContext(ctx)
}

func (n *Nomad) write(ctx context.Context) *api.WriteOptions {
	return (&api.WriteOptions{Namespace: n.Namespace}).WithContext(ctx)
}

func (n *Nomad) List(ctx context.Context) ([]Runtime, error) {
	q := n.query(ctx)
	q.Prefix = "agent-"
	q.Params = map[string]string{"meta": "true"}
	jobs, _, err := n.Client.Jobs().List(q)
	if err != nil {
		return nil, err
	}
	allocs, _, err := n.Client.Allocations().List(n.query(ctx))
	if err != nil {
		return nil, err
	}
	// The allocation whose runtime runs, by job.
	running := map[string]string{}
	for _, a := range allocs {
		if task := a.TaskStates["runtime"]; a.DesiredStatus == api.AllocDesiredStatusRun && task != nil && task.State == "running" {
			running[a.JobID] = a.ID
		}
	}
	for id := range n.addresses {
		if !slices.Contains(slices.Collect(maps.Values(running)), id) {
			delete(n.addresses, id)
		}
	}
	var out []Runtime
	for _, job := range jobs {
		// A job that is stopping is as good as none: the next Run replaces it.
		if job.Stop || job.Status == "dead" {
			continue
		}
		r := Runtime{AgentID: strings.TrimPrefix(job.ID, "agent-"), Config: job.Meta[configMeta], State: Starting}
		if alloc := running[job.ID]; alloc != "" {
			address, err := n.address(ctx, alloc)
			if err != nil {
				return nil, err
			}
			if address != "" {
				r.State = Running
				r.URL = fmt.Sprintf("http://%s:%d", address, controlPort)
			}
		}
		out = append(out, r)
	}
	return out, nil
}

// address is the allocation's address on the bridge network.
func (n *Nomad) address(ctx context.Context, allocID string) (string, error) {
	if address, ok := n.addresses[allocID]; ok {
		return address, nil
	}
	alloc, _, err := n.Client.Allocations().Info(allocID, n.query(ctx))
	if err != nil {
		return "", err
	}
	if alloc.NetworkStatus == nil || alloc.NetworkStatus.Address == "" {
		return "", nil
	}
	if n.addresses == nil {
		n.addresses = map[string]string{}
	}
	n.addresses[allocID] = alloc.NetworkStatus.Address
	return alloc.NetworkStatus.Address, nil
}

func (n *Nomad) Run(ctx context.Context, spec Spec) error {
	if err := n.Remove(ctx, spec.AgentID); err != nil {
		return err
	}
	if err := EnsureVolume(ctx, n.Client, n.Namespace, jobID(spec.AgentID)); err != nil {
		return err
	}
	_, _, err := n.Client.Jobs().Register(n.job(spec), n.write(ctx))
	return err
}

// job is the agent's Nomad job: one Docker task on the bridge network (the
// controller reaches its control API at its address), its volume at
// /agent. The runtime exits when it cannot go on; Nomad starts it again,
// waiting longer each time it fails. The memory limit is above what it
// reserves.
func (n *Nomad) job(spec Spec) *api.Job {
	id := jobID(spec.AgentID)
	task := api.NewTask("runtime", "docker")
	task.Config = map[string]any{"image": spec.Image, "force_pull": false}
	task.Env = spec.Env
	task.Resources = &api.Resources{CPU: new(100), MemoryMB: new(256), MemoryMaxMB: new(2048)}
	task.KillTimeout = new(stopSeconds * time.Second)
	task.VolumeMounts = []*api.VolumeMount{{Volume: new("home"), Destination: new(home)}}
	group := api.NewTaskGroup("runtime", 1)
	group.Networks = []*api.NetworkResource{{Mode: "bridge"}}
	group.Volumes = map[string]*api.VolumeRequest{"home": {Type: "host", Source: id}}
	group.RestartPolicy = &api.RestartPolicy{Attempts: new(10), Interval: new(10 * time.Minute), Delay: new(5 * time.Second), Mode: new("delay")}
	group.Tasks = []*api.Task{task}
	job := api.NewServiceJob(id, id, "", 50)
	job.Namespace = new(n.Namespace)
	job.Meta = map[string]string{configMeta: spec.Config}
	job.TaskGroups = []*api.TaskGroup{group}
	return job
}

// Remove stops and purges the agent's job and waits until its allocation
// ended, giving the runtime time to send its last events.
func (n *Nomad) Remove(ctx context.Context, agentID string) error {
	id := jobID(agentID)
	allocs, _, err := n.Client.Jobs().Allocations(id, false, n.query(ctx))
	if err != nil && !NotFound(err) {
		return err
	}
	if _, _, err := n.Client.Jobs().Deregister(id, true, n.write(ctx)); err != nil && !NotFound(err) {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, (stopSeconds+30)*time.Second)
	defer cancel()
	for _, a := range allocs {
		for {
			alloc, _, err := n.Client.Allocations().Info(a.ID, n.query(ctx))
			if NotFound(err) || (err == nil && terminal(alloc.ClientStatus)) {
				break
			}
			if ctx.Err() != nil {
				return fmt.Errorf("the runtime of agent %s did not stop: %w", agentID, ctx.Err())
			}
			select {
			case <-ctx.Done():
			case <-time.After(500 * time.Millisecond):
			}
		}
	}
	return nil
}

func terminal(clientStatus string) bool {
	switch clientStatus {
	case api.AllocClientStatusComplete, api.AllocClientStatusFailed, api.AllocClientStatusLost, api.AllocClientStatusUnknown:
		return true
	}
	return false
}

// NotFound reports whether Nomad answered 404.
func NotFound(err error) bool {
	var unexpected api.UnexpectedResponseError
	return errors.As(err, &unexpected) && unexpected.StatusCode() == http.StatusNotFound
}

func (n *Nomad) Base(ctx context.Context) (string, string, error) {
	id, err := imageID(ctx, n.BaseImage)
	if err == nil && id == "" {
		err = fmt.Errorf("the runtime image %s is not in Docker", n.BaseImage)
	}
	return id, n.BaseImage, err
}

func (n *Nomad) HasImage(ctx context.Context, tag string) (bool, error) {
	id, err := imageID(ctx, tag)
	return id != "", err
}

func (n *Nomad) Build(ctx context.Context, dir, tag string) (string, error) {
	return build(ctx, dir, tag)
}

func (n *Nomad) Prune(ctx context.Context, keep []string) error {
	return prune(ctx, keep)
}

// EnsureVolume makes sure the namespace has a host volume of this name
// (one directory on this machine, writable by whatever user the container
// runs as, kept when what used it goes), and waits until it is ready.
func EnsureVolume(ctx context.Context, client *api.Client, namespace, name string) error {
	q := (&api.QueryOptions{Namespace: namespace}).WithContext(ctx)
	list, _, err := client.HostVolumes().List(&api.HostVolumeListRequest{}, q)
	if err != nil {
		return err
	}
	id := ""
	for _, v := range list {
		if v.Name == name {
			id = v.ID
		}
	}
	if id == "" {
		created, _, err := client.HostVolumes().Create(&api.HostVolumeCreateRequest{Volume: &api.HostVolume{
			Namespace: namespace, Name: name, PluginID: "mkdir", Parameters: map[string]string{"mode": "0777"},
			RequestedCapabilities: []*api.HostVolumeCapability{{
				AttachmentMode: api.HostVolumeAttachmentModeFilesystem, AccessMode: api.HostVolumeAccessModeSingleNodeWriter,
			}},
		}}, (&api.WriteOptions{Namespace: namespace}).WithContext(ctx))
		if err != nil {
			return fmt.Errorf("creating the volume %s: %w", name, err)
		}
		id = created.Volume.ID
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	for {
		volume, _, err := client.HostVolumes().Get(id, q)
		if err != nil {
			return err
		}
		if volume.State == api.HostVolumeStateReady {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("the volume %s is not ready: %w", name, ctx.Err())
		case <-time.After(500 * time.Millisecond):
		}
	}
}
