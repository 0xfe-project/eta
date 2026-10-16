package container

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

// Agents' images, in this machine's Docker (the Nomad client runs
// containers from it): the docker CLI, which the controller's image
// carries, against the daemon's socket.

// ImageTag is the agent image with this content hash.
func ImageTag(hash string) string { return agentImage + ":" + hash }

const (
	agentImage = "axp-agent"
	// An image build may download a lot (a bundle's script installs tools).
	buildTimeout = 30 * time.Minute
	// A failed build keeps this much of its output.
	buildOutput = 4000
)

// imageID is the image's ID, empty when Docker has no such image.
func imageID(ctx context.Context, ref string) (string, error) {
	out, err := exec.CommandContext(ctx, "docker", "image", "inspect", "--format", "{{.Id}}", ref).Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return "", nil
	}
	return strings.TrimSpace(string(out)), err
}

func build(ctx context.Context, dir, tag string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, buildTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "build", "--progress=plain", "--tag", tag, dir)
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

// prune removes the agent images keep does not name. Nomad is told not to
// remove images itself (gc.image, deploy/README.md).
func prune(ctx context.Context, keep []string) error {
	out, err := exec.CommandContext(ctx, "docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", agentImage).Output()
	if err != nil {
		return err
	}
	kept := map[string]bool{}
	for _, tag := range keep {
		kept[tag] = true
	}
	var remove []string
	for _, tag := range strings.Fields(string(out)) {
		if !kept[tag] {
			remove = append(remove, tag)
		}
	}
	if len(remove) == 0 {
		return nil
	}
	return exec.CommandContext(ctx, "docker", append([]string{"image", "rm", "--force"}, remove...)...).Run()
}
