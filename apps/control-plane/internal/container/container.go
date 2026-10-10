// Package container runs agents' runtimes: one long-lived Docker container
// per agent, from an image built for it, with its state on a Docker volume
// of its own. Only the controller holds the Docker socket.
//
// Development and production share the daemon; their networks, images,
// containers and volumes never overlap (labels and names say which is
// whose).
package container

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os/exec"
	"sort"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

const (
	Label       = "dev.axp.runtime"
	envLabel    = "dev.axp.env"
	agentLabel  = "dev.axp.agent"
	configLabel = "dev.axp.config"
	memory      = 2 << 30 // 2 GiB
	cpus        = 1
	// DevSubnet is fixed in development, where host processes listen on its
	// gateway address (172.30.0.1); deploy/deploy.sh creates production's.
	DevSubnet   = "172.30.0.0/24"
	devGateway  = "172.30.0.1"
	stopSeconds = 10
	// The runtime's control API (apps/agent-runtime/src/server.ts).
	controlPort = 8080
	// The volume's mount point, the runtime's AXP_HOME.
	home = "/agent"
	// An image build may download a lot (a bundle's script installs tools).
	buildTimeout = 30 * time.Minute
	// A failed build keeps this much of its output.
	buildOutput = 4000
)

// Spec is an agent's runtime container.
type Spec struct {
	AgentID string
	Image   string
	Env     map[string]string
	// What the container was created from; a different one replaces it.
	Config string
}

// Runtime is an agent's runtime container as it is.
type Runtime struct {
	AgentID     string
	ContainerID string
	Config      string
	// Running, Restarting or Stopped.
	State string
	// The control API, while running.
	URL string
}

const (
	Running    = "running"
	Restarting = "restarting"
	Stopped    = "stopped"
)

// Driver runs agents' containers and builds their images.
type Driver interface {
	// List is this environment's agent containers.
	List(ctx context.Context) ([]Runtime, error)
	// Run replaces the agent's container (its volume stays) with a new one
	// and starts it.
	Run(ctx context.Context, spec Spec) error
	// Start starts the agent's stopped container again.
	Start(ctx context.Context, containerID string) error
	// Remove stops and removes the agent's container; its volume stays.
	Remove(ctx context.Context, agentID string) error
	// Base is the ID of the image agents' images are built on, and its name.
	Base(ctx context.Context) (id, ref string, err error)
	// ImageTag is the tag of the agent image with this content hash.
	ImageTag(hash string) string
	HasImage(ctx context.Context, tag string) (bool, error)
	// Build builds dir (with its Dockerfile) as tag; a failure returns the
	// end of the build's output.
	Build(ctx context.Context, dir, tag string) (failure string, err error)
	// Prune removes this environment's agent images no container uses
	// except keep.
	Prune(ctx context.Context, keep []string) error
}

// Docker is this machine's Docker (DOCKER_HOST and the other DOCKER_*
// variables are honoured).
type Docker struct {
	env     string
	prefix  string
	network string
	base    string
	client  *client.Client
}

// NewDocker drives Docker for development or production; base is the
// runtime image agents' images build on.
func NewDocker(dev bool, base string) (*Docker, error) {
	c, err := client.New(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	d := &Docker{env: "production", prefix: "axp-", network: "axp-prod-runtime", base: base, client: c}
	if dev {
		d.env, d.prefix, d.network = "dev", "axp-dev-", "axp-runtime"
	}
	return d, nil
}

func (d *Docker) name(agentID string) string { return d.prefix + "agent-" + agentID }

// EnsureNetwork creates the runtime network when it is missing (in
// development; deploy/deploy.sh creates production's).
func (d *Docker) EnsureNetwork(ctx context.Context) error {
	_, err := d.client.NetworkInspect(ctx, d.network, client.NetworkInspectOptions{})
	if !cerrdefs.IsNotFound(err) {
		return err
	}
	_, err = d.client.NetworkCreate(ctx, d.network, client.NetworkCreateOptions{
		Driver: "bridge",
		IPAM: &network.IPAM{Config: []network.IPAMConfig{{
			Subnet: netip.MustParsePrefix(DevSubnet), Gateway: netip.MustParseAddr(devGateway),
		}}},
		Labels: map[string]string{Label: "network"},
	})
	return err
}

func (d *Docker) filters(kind string) client.Filters {
	return make(client.Filters).Add("label", Label+"="+kind).Add("label", envLabel+"="+d.env)
}

func (d *Docker) List(ctx context.Context) ([]Runtime, error) {
	list, err := d.client.ContainerList(ctx, client.ContainerListOptions{All: true, Filters: d.filters("agent")})
	if err != nil {
		return nil, err
	}
	var out []Runtime
	for _, c := range list.Items {
		r := Runtime{AgentID: c.Labels[agentLabel], ContainerID: c.ID, Config: c.Labels[configLabel], State: Stopped}
		switch c.State {
		case container.StateRunning:
			r.State = Running
		case container.StateRestarting:
			r.State = Restarting
		}
		if c.NetworkSettings != nil && r.State == Running {
			if endpoint := c.NetworkSettings.Networks[d.network]; endpoint != nil && endpoint.IPAddress.IsValid() {
				r.URL = "http://" + netip.AddrPortFrom(endpoint.IPAddress, controlPort).String()
			}
		}
		out = append(out, r)
	}
	return out, nil
}

func (d *Docker) Run(ctx context.Context, spec Spec) error {
	if err := d.EnsureNetwork(ctx); err != nil {
		return err
	}
	if err := d.Remove(ctx, spec.AgentID); err != nil {
		return err
	}
	env := make([]string, 0, len(spec.Env))
	for k, v := range spec.Env {
		env = append(env, k+"="+v)
	}
	sort.Strings(env)
	created, err := d.client.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name: d.name(spec.AgentID),
		Config: &container.Config{
			Image: spec.Image,
			Env:   env,
			Labels: map[string]string{
				Label: "agent", envLabel: d.env, agentLabel: spec.AgentID, configLabel: spec.Config,
			},
		},
		HostConfig: &container.HostConfig{
			NetworkMode: container.NetworkMode(d.network),
			// The runtime exits when it cannot go on; Docker starts it again,
			// waiting longer each time it fails.
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
			Resources:     container.Resources{Memory: memory, NanoCPUs: cpus * 1_000_000_000},
			// Docker creates the volume the first time.
			Mounts: []mount.Mount{{Type: mount.TypeVolume, Source: d.name(spec.AgentID), Target: home}},
		},
	})
	if err != nil {
		return err
	}
	if _, err := d.client.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		// Created, maybe running: nothing records it, so it goes now.
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), (stopSeconds+30)*time.Second)
		defer cancel()
		return errors.Join(err, d.remove(cleanup, created.ID))
	}
	return nil
}

func (d *Docker) Start(ctx context.Context, containerID string) error {
	_, err := d.client.ContainerStart(ctx, containerID, client.ContainerStartOptions{})
	return err
}

func (d *Docker) Remove(ctx context.Context, agentID string) error {
	list, err := d.client.ContainerList(ctx, client.ContainerListOptions{
		All:     true,
		Filters: d.filters("agent").Add("label", agentLabel+"="+agentID),
	})
	if err != nil {
		return err
	}
	for _, c := range list.Items {
		if err := d.remove(ctx, c.ID); err != nil {
			return err
		}
	}
	return nil
}

// remove stops and removes a container, giving the runtime time to send its
// last events.
func (d *Docker) remove(ctx context.Context, containerID string) error {
	timeout := stopSeconds
	_, err := d.client.ContainerStop(ctx, containerID, client.ContainerStopOptions{Timeout: &timeout})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = d.client.ContainerRemove(ctx, containerID, client.ContainerRemoveOptions{Force: true})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	return err
}

func (d *Docker) Base(ctx context.Context) (string, string, error) {
	inspected, err := d.client.ImageInspect(ctx, d.base)
	if err != nil {
		return "", "", fmt.Errorf("the runtime image %s: %w", d.base, err)
	}
	return inspected.ID, d.base, nil
}

func (d *Docker) ImageTag(hash string) string { return d.prefix + "agent:" + hash }

func (d *Docker) HasImage(ctx context.Context, tag string) (bool, error) {
	_, err := d.client.ImageInspect(ctx, tag)
	if cerrdefs.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

func (d *Docker) Build(ctx context.Context, dir, tag string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, buildTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "build", "--progress=plain",
		"--label", Label+"=agent-image", "--label", envLabel+"="+d.env, "--tag", tag, dir)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		tail := output.String()
		if r := []rune(tail); len(r) > buildOutput {
			tail = "…" + string(r[len(r)-buildOutput:])
		}
		return strings.TrimSpace(tail), err
	}
	return "", nil
}

func (d *Docker) Prune(ctx context.Context, keep []string) error {
	list, err := d.client.ImageList(ctx, client.ImageListOptions{Filters: d.filters("agent-image")})
	if err != nil {
		return err
	}
	for _, image := range list.Items {
		kept := false
		for _, tag := range image.RepoTags {
			for _, k := range keep {
				kept = kept || tag == k
			}
		}
		if kept {
			continue
		}
		// One a container still uses stays (Docker refuses).
		if _, err := d.client.ImageRemove(ctx, image.ID, client.ImageRemoveOptions{}); err != nil && !cerrdefs.IsConflict(err) && !cerrdefs.IsNotFound(err) {
			return err
		}
	}
	return nil
}
