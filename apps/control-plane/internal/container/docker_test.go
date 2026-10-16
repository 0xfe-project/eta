package container

import (
	"os"
	"strings"
	"testing"
)

// Agents' Dockerfiles cache downloads with RUN --mount, which only BuildKit
// builds: the controller's image (deploy/Dockerfile) carries docker's buildx
// plugin, without which `docker build` refuses them.
func TestTheControllerCanBuildWithBuildKit(t *testing.T) {
	dockerfile, err := os.ReadFile("../../../../deploy/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dockerfile), "/usr/local/libexec/docker/cli-plugins/docker-buildx") {
		t.Fatal("deploy/Dockerfile does not install docker's buildx plugin")
	}
}
