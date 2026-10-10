package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
)

// An agent's image: the runtime image, then each of its bundles (its files
// and its script), then its bundles' plugins, compiled for Codex. Its tag is
// a hash of all of that, so agents with the same bundles share an image, and
// changing a bundle, a plugin or the runtime image builds a new one.

type image struct {
	Tag     string
	bundles []bundles.Bundle
	plugins []string
}

// plan is the image for the bundles on the runtime image baseID (named
// baseRef).
func (c *Controller) plan(baseID, baseRef string, chosen []bundles.Bundle) (image, error) {
	h := sha256.New()
	dockerfile := c.dockerfile(baseRef, chosen)
	fmt.Fprintf(h, "%s\n%s\n", baseID, dockerfile)
	for _, b := range chosen {
		if b.Builtin {
			sum, err := c.treeHash(b.Dir)
			if err != nil {
				return image{}, err
			}
			fmt.Fprintf(h, "bundle %s %s\n", b.Name, sum)
		} else {
			fmt.Fprintf(h, "bundle %s %x\n", b.Name, sha256.Sum256([]byte(b.Script)))
		}
	}
	plugins := bundles.PluginsOf(chosen)
	for _, p := range plugins {
		sum, err := c.treeHash(filepath.Join(c.PluginsDir, p))
		if err != nil {
			return image{}, err
		}
		fmt.Fprintf(h, "plugin %s %s\n", p, sum)
	}
	return image{Tag: c.Driver.ImageTag(hex.EncodeToString(h.Sum(nil))[:24]), bundles: chosen, plugins: plugins}, nil
}

func (c *Controller) dockerfile(baseRef string, chosen []bundles.Bundle) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# syntax=docker/dockerfile:1\nFROM %s\nARG TARGETARCH\n", baseRef)
	for _, bundle := range chosen {
		dir := "/opt/axp/bundles/" + bundle.Name
		fmt.Fprintf(&b, "COPY bundles/%s %s\n", bundle.Name, dir)
		if bundle.Script != "" {
			fmt.Fprintf(&b, "RUN cd %s && BUNDLE_ROOT=%s ./%s\n", dir, dir, bundles.SetupFile)
		}
	}
	b.WriteString("COPY plugins /opt/axp/plugins\n")
	// Sets the plugins up (downloads cached across builds) and compiles them
	// into a local marketplace, their tools' approvals and their hooks.
	b.WriteString("RUN --mount=type=cache,target=/var/cache/axp-plugins axp-plugins chat /opt/axp/plugins /etc/codex /opt/axp/plugins\n")
	return b.String()
}

// treeHash is a hash of a directory's files, which do not change while the
// controller runs (they are part of its image), so it is computed once.
func (c *Controller) treeHash(dir string) (string, error) {
	c.treesMu.Lock()
	defer c.treesMu.Unlock()
	if sum, ok := c.trees[dir]; ok {
		return sum, nil
	}
	h := sha256.New()
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		fmt.Fprintf(h, "%s %o %x\n", rel, info.Mode().Perm()&0o111, sha256.Sum256(data))
		return nil
	})
	if err != nil {
		return "", err
	}
	if c.trees == nil {
		c.trees = map[string]string{}
	}
	sum := hex.EncodeToString(h.Sum(nil))
	c.trees[dir] = sum
	return sum, nil
}

// context writes the image's build context into dir.
func (c *Controller) context(dir, baseRef string, img image) error {
	for _, b := range img.bundles {
		target := filepath.Join(dir, "bundles", b.Name)
		if b.Builtin {
			if err := os.CopyFS(target, os.DirFS(b.Dir)); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(target, 0o755); err != nil {
			return err
		}
		if b.Script != "" {
			script := b.Script
			if !strings.HasPrefix(script, "#!") {
				script = "#!/bin/sh\nset -eu\n" + script
			}
			if err := os.WriteFile(filepath.Join(target, bundles.SetupFile), []byte(script), 0o755); err != nil {
				return err
			}
		}
	}
	plugins := filepath.Join(dir, "plugins")
	if err := os.MkdirAll(plugins, 0o755); err != nil {
		return err
	}
	for _, p := range img.plugins {
		if err := os.CopyFS(filepath.Join(plugins, p), os.DirFS(filepath.Join(c.PluginsDir, p))); err != nil {
			return err
		}
	}
	return os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(c.dockerfile(baseRef, img.bundles)), 0o644)
}

// builds runs one image build at a time, in the background.
type builds struct {
	mu       sync.Mutex
	running  string
	failures map[string]string
}

// state is whether the tag is being built, and how its last build failed.
func (b *builds) state(tag string) (building bool, failure string, failed bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	failure, failed = b.failures[tag]
	return b.running == tag, failure, failed
}

// retry forgets the tag's failure.
func (b *builds) retry(tag string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.failures, tag)
}

func (b *builds) busy() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.running
}

// start builds the image unless a build is under way; done runs after it.
func (c *Controller) startBuild(ctx context.Context, baseRef string, img image, done func()) bool {
	b := &c.builds
	b.mu.Lock()
	if b.running != "" {
		b.mu.Unlock()
		return false
	}
	b.running = img.Tag
	b.mu.Unlock()
	go func() {
		failure, err := c.build(ctx, baseRef, img)
		b.mu.Lock()
		b.running = ""
		if err != nil {
			if b.failures == nil {
				b.failures = map[string]string{}
			}
			if failure == "" {
				failure = err.Error()
			}
			b.failures[img.Tag] = failure
		}
		b.mu.Unlock()
		done()
	}()
	return true
}

func (c *Controller) build(ctx context.Context, baseRef string, img image) (string, error) {
	dir, err := os.MkdirTemp("", "axp-agent-image-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	if err := c.context(dir, baseRef, img); err != nil {
		return "", err
	}
	names := make([]string, 0, len(img.bundles))
	for _, b := range img.bundles {
		names = append(names, b.Name)
	}
	sort.Strings(names)
	slog.InfoContext(ctx, "Building an agent image", "image", img.Tag, "bundles", names)
	failure, err := c.Driver.Build(ctx, dir, img.Tag)
	if err != nil {
		slog.ErrorContext(ctx, "Agent image build failed", "image", img.Tag, "error", err)
		return failure, err
	}
	slog.InfoContext(ctx, "Built an agent image", "image", img.Tag)
	return "", nil
}

// keep is the images the agents use or wait for.
func keep(images map[string]string, building string) []string {
	out := []string{}
	for _, tag := range images {
		out = append(out, tag)
	}
	if building != "" {
		out = append(out, building)
	}
	return out
}

var _ container.Driver = (*container.Docker)(nil)
