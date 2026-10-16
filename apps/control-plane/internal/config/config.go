// Package config reads the control plane's settings from the environment.
//
// Each field declares its defaults: development's (development's
// infrastructure, Nomad jobs on fixed ports, or loopback; only
// scripts/dev.sh sets AXP_DEV) and production's (deploy/nomad). The
// control plane's processes run on the host's network; agents and bundles'
// services run on Nomad's bridge network and reach the host at AllocHost.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/akarachen/axp/packages/service-go/config"
	"github.com/akarachen/axp/packages/service-go/pg"
)

type Config struct {
	// Development: development's services, namespaces and image tags.
	Dev bool `env:"AXP_DEV"`
	// Signs runtime tokens and cursors; every control plane process must
	// share it. Without it, a key generated once per checkout is used.
	SecretKey   string `env:"AXP_SECRET_KEY"`
	DatabaseURL string `env:"DATABASE_URL" dev:"postgres://axp:axp@127.0.0.1:24433/axp" prod:"postgres://axp@127.0.0.1:24432/axp"`
	// Routines keep their own database (and its migration history); by
	// default axp_routines on DATABASE_URL's server.
	RoutinesDatabaseURL string `env:"AXP_ROUTINES_DATABASE_URL"`
	// The public API, for the browser (through the gateway).
	APIAddr string `env:"AXP_API_ADDR" default:"127.0.0.1:24000"`
	// The internal API, for runtimes (through the runtime gateway), served
	// by the same process on a listener of its own.
	InternalAddr string `env:"AXP_INTERNAL_ADDR" default:"127.0.0.1:24001"`
	// The browser's gateway, as the control plane reaches it: the agenvo
	// relay (a bundle's service) is behind it at /remote/relay.
	PublicGatewayURL string `env:"AXP_PUBLIC_GATEWAY_URL" dev:"http://127.0.0.1:3000" prod:"http://127.0.0.1:24180"`
	// The runtime gateway (apps/gateway), as runtimes and bundles' services
	// reach it: their only route to AXP's services and the LLM gateway.
	RuntimeGatewayURL string `env:"AXP_RUNTIME_GATEWAY_URL" dev:"http://172.26.64.1:3005" prod:"http://172.26.64.1:24090"`
	// The host, as runtimes and bundles' services reach it: Nomad's bridge
	// network's gateway. NATS and the database are given to them there.
	AllocHost string `env:"AXP_ALLOC_HOST" default:"172.26.64.1"`
	// AXP's Nomad namespace, where bundles' services run; agents run in
	// <AXP_NAMESPACE>-agents.
	Namespace string `env:"AXP_NAMESPACE" dev:"dev-axp" prod:"axp"`
	// The tag of AXP's own images in Docker (axp-memory, axp-relay), which
	// bundles' services name without one.
	ImageTag string `env:"AXP_IMAGE_TAG" dev:"dev"`
	// The runtime image agents' images are built on (apps/agent-runtime),
	// in Docker.
	RuntimeImage string `env:"AXP_RUNTIME_IMAGE" dev:"axp-agent-runtime:dev" prod:"axp-agent-runtime:production"`
	// Where this process's Sentry SDK sends (internal/telemetry reads it
	// too); bundles' services send to the same project through the runtime
	// gateway. Empty: nothing is sent.
	SentryDSN string `env:"SENTRY_DSN"`
	// The LLM gateway (internal/llm) runs in the process serving the APIs,
	// with its credentials, catalog and usage in LLMStateDir (production:
	// the volume llm). The controller and the routine worker reach it on
	// the internal listener at LLMGatewayURL.
	LLMStateDir   string `env:"AXP_LLM_STATE_DIR" default:"var/llm-gateway"`
	LLMGatewayURL string `env:"AXP_LLM_GATEWAY_URL" dev:"http://127.0.0.1:8001" prod:"http://127.0.0.1:24001"`
	// NATS JetStream, where runtimes publish their events (runtimes reach it
	// at AllocHost) and routines' schedules live.
	NATSURL string `env:"AXP_NATS_URL" dev:"nats://127.0.0.1:24223" prod:"nats://127.0.0.1:24222"`
	// The built-in bundles and the plugins bundles add
	// (the repository's bundles/ and plugins/), which agents' images are
	// built from; the production image copies them alongside.
	BundlesDir string `env:"AXP_BUNDLES_DIR" default:"../../bundles"`
	PluginsDir string `env:"AXP_PLUGINS_DIR" default:"../../plugins"`
	// Where remote computers reach AXP (install commands), and their
	// connectors the agenvo relay (the agenvo bundle's service) under
	// /remote/relay. Empty: install commands name the browser's address,
	// and the relay is not used.
	PublicURL string `env:"AXP_PUBLIC_URL"`
	// The GitHub App's credentials and the user's authorization
	// (internal/github); production keeps them on the volume forge.
	ForgeStateDir string `env:"AXP_FORGE_STATE_DIR" default:"var/forge"`
	// Directories (colon-separated) with what remote computers download: the
	// axp binaries and the agenvo connectors built from the pinned commit.
	RemoteDist string `env:"AXP_REMOTE_DIST" default:"../remote/out/dist:../agenvo/out/dist"`
	// S3-compatible object storage for artifacts: development's SeaweedFS
	// (scripts/dev.sh), production's built-in one or any external service
	// (deploy/README.md). Artifacts are off without an endpoint.
	S3Endpoint        string `env:"AXP_S3_ENDPOINT" dev:"http://127.0.0.1:24334"`
	S3Bucket          string `env:"AXP_S3_BUCKET" default:"axp-artifacts"`
	S3Region          string `env:"AXP_S3_REGION" default:"us-east-1"`
	S3AccessKeyID     string `env:"AXP_S3_ACCESS_KEY_ID" dev:"axp-dev"`
	S3SecretAccessKey string `env:"AXP_S3_SECRET_ACCESS_KEY" dev:"axp-dev-secret"`
}

// Load reads the settings from the environment (service-go/config).
func Load() (Config, error) {
	c, err := config.Load[Config]()
	if err != nil {
		return Config{}, err
	}
	if c.SecretKey == "" {
		if c.SecretKey, err = localSecretKey("var/secret_key"); err != nil {
			return Config{}, err
		}
	}
	if c.RoutinesDatabaseURL == "" {
		if c.RoutinesDatabaseURL, err = pg.WithDatabase(c.DatabaseURL, "axp_routines"); err != nil {
			return Config{}, err
		}
	}
	return c, nil
}

// AtAllocHost is the URL (of a service on the host's network) as runtimes
// and bundles' services reach it.
func (c Config) AtAllocHost(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	if port := u.Port(); port != "" {
		u.Host = c.AllocHost + ":" + port
	} else {
		u.Host = c.AllocHost
	}
	return u.String(), nil
}

func localSecretKey(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		return strings.TrimSpace(string(data)), nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	secret := hex.EncodeToString(key)
	return secret, os.WriteFile(path, []byte(secret), 0o600)
}
