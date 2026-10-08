// Package container runs agent runtimes as Docker containers. Only the
// controller holds the Docker socket.
//
// Development and production share the daemon; their networks, images and
// names never overlap.
package container

import (
	"context"
	"fmt"
	"net/netip"
	"sort"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

const (
	Label  = "dev.axp.runtime"
	memory = 2 << 30 // 2 GiB
	cpus   = 1
	// DevSubnet is fixed in development, where host processes listen on its
	// gateway address (172.30.0.1); deploy/deploy.sh creates production's.
	DevSubnet   = "172.30.0.0/24"
	devGateway  = "172.30.0.1"
	stopSeconds = 10
)

// Spec is a runtime to start.
type Spec struct {
	AgentID    string
	InstanceID string
	Generation int64
	Name       string
	Env        map[string]string
	// Instead of the image's command (an agent's runtime).
	Command []string
}

type Started struct {
	ContainerID string
	ImageDigest string
}

// States of a container.
const (
	Running = "running"
	Exited  = "exited"
	Missing = "missing"
)

// Driver starts, inspects and stops runtimes.
type Driver interface {
	// Name is a container name in this environment.
	Name(suffix string) string
	Start(ctx context.Context, spec Spec) (Started, error)
	// State is Running, Exited or Missing.
	State(ctx context.Context, containerID string) (string, error)
	// Stop stops and removes; it returns once the container cannot write.
	Stop(ctx context.Context, containerID string) error
}

// Docker is this machine's Docker (DOCKER_HOST and the other DOCKER_*
// variables are honoured).
type Docker struct {
	dev     bool
	network string
	image   string
	client  *client.Client
}

func NewDocker(dev bool) (*Docker, error) {
	c, err := client.New(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	d := &Docker{dev: dev, network: "axp-prod-runtime", image: "axp-agent-runtime:production", client: c}
	if dev {
		d.network, d.image = "axp-runtime", "axp-agent-runtime:dev"
	}
	return d, nil
}

func (d *Docker) Name(suffix string) string {
	if d.dev {
		return "axp-dev-" + suffix
	}
	return "axp-" + suffix
}

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

func (d *Docker) Start(ctx context.Context, spec Spec) (Started, error) {
	if err := d.EnsureNetwork(ctx); err != nil {
		return Started{}, err
	}
	env := make([]string, 0, len(spec.Env))
	for k, v := range spec.Env {
		env = append(env, k+"="+v)
	}
	sort.Strings(env)
	created, err := d.client.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name: spec.Name,
		Config: &container.Config{
			Image: d.image,
			Cmd:   spec.Command,
			Env:   env,
			Labels: map[string]string{
				Label:                 "runtime",
				Label + ".agent":      spec.AgentID,
				Label + ".instance":   spec.InstanceID,
				Label + ".generation": fmt.Sprint(spec.Generation),
			},
		},
		HostConfig: &container.HostConfig{
			NetworkMode:   container.NetworkMode(d.network),
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
			Resources:     container.Resources{Memory: memory, NanoCPUs: cpus * 1_000_000_000},
		},
	})
	if err != nil {
		return Started{}, err
	}
	if _, err := d.client.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		return Started{}, err
	}
	inspected, err := d.client.ContainerInspect(ctx, created.ID, client.ContainerInspectOptions{})
	if err != nil {
		return Started{}, err
	}
	return Started{ContainerID: created.ID, ImageDigest: inspected.Container.Image}, nil
}

func (d *Docker) State(ctx context.Context, containerID string) (string, error) {
	if containerID == "" {
		return Missing, nil
	}
	inspected, err := d.client.ContainerInspect(ctx, containerID, client.ContainerInspectOptions{})
	if cerrdefs.IsNotFound(err) {
		return Missing, nil
	}
	if err != nil {
		return "", err
	}
	if s := inspected.Container.State; s != nil && (s.Running || s.Restarting) {
		return Running, nil
	}
	return Exited, nil
}

func (d *Docker) Stop(ctx context.Context, containerID string) error {
	if containerID == "" {
		return nil
	}
	timeout := stopSeconds
	_, err := d.client.ContainerStop(ctx, containerID, client.ContainerStopOptions{Timeout: &timeout})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	wait, cancel := context.WithTimeout(ctx, (stopSeconds+30)*time.Second)
	defer cancel()
	waited := d.client.ContainerWait(wait, containerID, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case <-waited.Result:
	case err := <-waited.Error:
		if !cerrdefs.IsNotFound(err) {
			return err
		}
	}
	_, err = d.client.ContainerRemove(ctx, containerID, client.ContainerRemoveOptions{Force: true})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	return err
}
