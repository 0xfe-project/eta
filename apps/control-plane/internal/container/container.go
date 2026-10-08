// Package container runs agent runtimes as Docker containers. Only the
// controller holds the Docker socket.
//
// Development and production share the daemon; their networks, images and
// names never overlap.
package container

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	Label  = "dev.axp.runtime"
	memory = 2 << 30 // 2 GiB
	cpus   = 1
	// DevSubnet is fixed in development, where host processes listen on its
	// gateway address (172.30.0.1); deploy/deploy.sh creates production's.
	DevSubnet  = "172.30.0.0/24"
	devGateway = "172.30.0.1"
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

// Docker is the Docker Engine API on this machine's socket.
type Docker struct {
	dev     bool
	network string
	image   string
	client  *http.Client
}

func NewDocker(dev bool) *Docker {
	socket := "/var/run/docker.sock"
	if host := os.Getenv("DOCKER_HOST"); strings.HasPrefix(host, "unix://") {
		socket = strings.TrimPrefix(host, "unix://")
	}
	d := &Docker{
		dev:     dev,
		network: "axp-prod-runtime",
		image:   "axp-agent-runtime:production",
		client: &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			},
		}},
	}
	if dev {
		d.network, d.image = "axp-runtime", "axp-agent-runtime:dev"
	}
	return d
}

func (d *Docker) Name(suffix string) string {
	if d.dev {
		return "axp-dev-" + suffix
	}
	return "axp-" + suffix
}

// call sends a request to the Engine API and decodes a JSON answer into out.
// It returns the status; 404 is not an error.
func (d *Docker) call(ctx context.Context, method, path string, body, out any) (int, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, reader)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return resp.StatusCode, nil
	}
	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotModified {
		var problem struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&problem)
		return resp.StatusCode, fmt.Errorf("docker %s %s: %d %s", method, path, resp.StatusCode, problem.Message)
	}
	if out != nil {
		return resp.StatusCode, json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode, nil
}

// EnsureNetwork creates the runtime network when it is missing (in
// development; deploy/deploy.sh creates production's).
func (d *Docker) EnsureNetwork(ctx context.Context) error {
	status, err := d.call(ctx, http.MethodGet, "/networks/"+url.PathEscape(d.network), nil, nil)
	if err != nil || status != http.StatusNotFound {
		return err
	}
	_, err = d.call(ctx, http.MethodPost, "/networks/create", map[string]any{
		"Name":   d.network,
		"Driver": "bridge",
		"IPAM": map[string]any{
			"Config": []map[string]string{{"Subnet": DevSubnet, "Gateway": devGateway}},
		},
		"Labels": map[string]string{Label: "network"},
	}, nil)
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
	config := map[string]any{
		"Image": d.image,
		"Env":   env,
		"Labels": map[string]string{
			Label:                 "runtime",
			Label + ".agent":      spec.AgentID,
			Label + ".instance":   spec.InstanceID,
			Label + ".generation": fmt.Sprint(spec.Generation),
		},
		"HostConfig": map[string]any{
			"NetworkMode":   d.network,
			"Memory":        memory,
			"NanoCpus":      cpus * 1_000_000_000,
			"RestartPolicy": map[string]string{"Name": "no"},
		},
	}
	if spec.Command != nil {
		config["Cmd"] = spec.Command
	}
	var created struct {
		ID string `json:"Id"`
	}
	status, err := d.call(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(spec.Name), config, &created)
	if err == nil && status == http.StatusNotFound {
		err = fmt.Errorf("docker: image %s not found", d.image)
	}
	if err != nil {
		return Started{}, err
	}
	if _, err := d.call(ctx, http.MethodPost, "/containers/"+created.ID+"/start", nil, nil); err != nil {
		return Started{}, err
	}
	var inspected struct {
		Image string `json:"Image"`
	}
	if _, err := d.call(ctx, http.MethodGet, "/containers/"+created.ID+"/json", nil, &inspected); err != nil {
		return Started{}, err
	}
	return Started{ContainerID: created.ID, ImageDigest: inspected.Image}, nil
}

func (d *Docker) State(ctx context.Context, containerID string) (string, error) {
	if containerID == "" {
		return Missing, nil
	}
	var inspected struct {
		State struct {
			Status string `json:"Status"`
		} `json:"State"`
	}
	status, err := d.call(ctx, http.MethodGet, "/containers/"+url.PathEscape(containerID)+"/json", nil, &inspected)
	if err != nil {
		return "", err
	}
	if status == http.StatusNotFound {
		return Missing, nil
	}
	if s := inspected.State.Status; s == "running" || s == "restarting" {
		return Running, nil
	}
	return Exited, nil
}

const stopSeconds = 10

func (d *Docker) Stop(ctx context.Context, containerID string) error {
	if containerID == "" {
		return nil
	}
	path := "/containers/" + url.PathEscape(containerID)
	status, err := d.call(ctx, http.MethodPost, fmt.Sprintf("%s/stop?t=%d", path, stopSeconds), nil, nil)
	if err != nil || status == http.StatusNotFound {
		return err
	}
	wait, cancel := context.WithTimeout(ctx, (stopSeconds+30)*time.Second)
	defer cancel()
	if _, err := d.call(wait, http.MethodPost, path+"/wait?condition=not-running", nil, nil); err != nil {
		return err
	}
	_, err = d.call(ctx, http.MethodDelete, path+"?force=true", nil, nil)
	return err
}
