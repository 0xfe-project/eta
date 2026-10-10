package control

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
)

type tags struct{ container.Driver }

func (tags) ImageTag(hash string) string { return "agent:" + hash }

func builtin(t *testing.T, name string) bundles.Bundle {
	t.Helper()
	all, err := (&bundles.Catalog{Dir: "../../../agent-runtime/bundles"}).Builtin()
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range all {
		if b.Name == name {
			return b
		}
	}
	t.Fatalf("no bundle %s", name)
	return bundles.Bundle{}
}

func TestAnImageIsItsBundlesAndPlugins(t *testing.T) {
	c := &Controller{Driver: tags{}, PluginsDir: "../../../agent-runtime/plugins"}
	custom := bundles.Bundle{Name: "python", Script: "apt-get install -y python3", Plugins: []string{"memory"}}
	chosen := []bundles.Bundle{builtin(t, "grok"), custom}
	img, err := c.plan("sha256:a", "runtime:dev", chosen)
	if err != nil {
		t.Fatal(err)
	}
	if again, _ := c.plan("sha256:a", "runtime:dev", chosen); again.Tag != img.Tag {
		t.Fatal("the same content has another tag")
	}
	for name, other := range map[string][]any{
		"another runtime image": {"sha256:b", chosen},
		"another script":        {"sha256:a", []bundles.Bundle{chosen[0], {Name: "python", Script: "true", Plugins: []string{"memory"}}}},
		"fewer bundles":         {"sha256:a", chosen[:1]},
	} {
		changed, err := c.plan(other[0].(string), "runtime:dev", other[1].([]bundles.Bundle))
		if err != nil || changed.Tag == img.Tag {
			t.Errorf("%s: same tag (%v)", name, err)
		}
	}
	expectSame(t, strings.Join(img.plugins, " "), "grok memory")

	dir := t.TempDir()
	if err := c.context(dir, "runtime:dev", img); err != nil {
		t.Fatal(err)
	}
	dockerfile, _ := os.ReadFile(filepath.Join(dir, "Dockerfile"))
	expectSame(t, string(dockerfile), `# syntax=docker/dockerfile:1
FROM runtime:dev
ARG TARGETARCH
COPY bundles/grok /opt/axp/bundles/grok
COPY bundles/python /opt/axp/bundles/python
RUN cd /opt/axp/bundles/python && BUNDLE_ROOT=/opt/axp/bundles/python ./setup
COPY plugins /opt/axp/plugins
RUN --mount=type=cache,target=/var/cache/axp-plugins axp-plugins chat /opt/axp/plugins /etc/codex /opt/axp/plugins
`)
	script, _ := os.ReadFile(filepath.Join(dir, "bundles", "python", "setup"))
	expectSame(t, string(script), "#!/bin/sh\nset -eu\napt-get install -y python3")
	if info, err := os.Stat(filepath.Join(dir, "bundles", "python", "setup")); err != nil || info.Mode()&0o111 == 0 {
		t.Fatal("the script is not executable")
	}
	for _, path := range []string{"bundles/grok/bundle.json", "plugins/grok/plugin.json", "plugins/grok/setup", "plugins/memory/akhook.yml"} {
		if _, err := os.Stat(filepath.Join(dir, path)); err != nil {
			t.Errorf("%s: %v", path, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "plugins", "tasks")); err == nil {
		t.Error("a plugin no bundle adds is in the image")
	}
}

func expectSame(t *testing.T, got, want string) {
	t.Helper()
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}
