// Package config reads the control plane's settings from the environment.
//
// Each field declares its defaults: development's (services in the
// cluster's axp-dev namespace, or loopback; only scripts/dev.sh sets
// AXP_DEV) and production's (Services in the axp namespace, deploy/k3s).
// scripts/dev.sh sets the ones that move with its port block, deploy/k3s
// the production credentials.
package config

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"net"
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
	DatabaseURL string `env:"DATABASE_URL" dev:"postgres://axp:axp@postgres.axp-dev.svc.cluster.local:5432/axp"`
	// Routines keep their own database (and its migration history); by
	// default axp_routines on DATABASE_URL's server.
	RoutinesDatabaseURL string `env:"AXP_ROUTINES_DATABASE_URL"`
	// The public API, for the browser (through the gateway).
	APIAddr string `env:"AXP_API_ADDR" default:":8000"`
	// The internal API, for runtimes (through the runtime gateway), served
	// by the same process on a listener of its own.
	InternalAddr string `env:"AXP_INTERNAL_ADDR" default:":8001"`
	// The runtime gateway (apps/gateway): runtimes' only route to AXP's
	// services and the LLM gateway.
	RuntimeGatewayURL string `env:"AXP_RUNTIME_GATEWAY_URL" dev:"http://10.42.0.1:8090" prod:"http://runtime-gateway.axp.svc.cluster.local:8090"`
	// Agents run in <AXP_NAMESPACE>-agents, bundles' services in
	// <AXP_NAMESPACE>-bundles.
	Namespace string `env:"AXP_NAMESPACE" dev:"dev-axp" prod:"axp"`
	// The tag of AXP's own images in the registry (axp-memory, axp-relay),
	// which bundles' services name without one.
	ImageTag string `env:"AXP_IMAGE_TAG" dev:"dev"`
	// The cluster's registry and BuildKit daemon (deploy/k3s), at fixed
	// addresses: the node pulls from the registry by that name.
	Registry string `env:"AXP_REGISTRY" dev:"10.43.100.11:5000" prod:"10.43.100.1:5000"`
	BuildKit string `env:"AXP_BUILDKIT" dev:"tcp://10.43.100.12:1234" prod:"tcp://10.43.100.2:1234"`
	// The runtime image agents' images are built on (apps/agent-runtime), in
	// the registry.
	RuntimeImage string `env:"AXP_RUNTIME_IMAGE" dev:"10.43.100.11:5000/axp-agent-runtime:dev" prod:"10.43.100.1:5000/axp-agent-runtime:production"`
	// The OpenTelemetry Collector runtimes export to without credentials.
	RuntimeOTLPURL string `env:"AXP_RUNTIME_OTLP_URL" dev:"http://otel-collector.axp-dev.svc.cluster.local:4318" prod:"http://otel-collector.axp.svc.cluster.local:4318"`
	// Development's processes run outside the cluster: this is its DNS
	// server, for the cluster's names (*.svc.cluster.local) and every other.
	ClusterDNS string `env:"AXP_CLUSTER_DNS" dev:"10.43.0.10:53"`
	// The LLM gateway (internal/llm) runs in the process serving the APIs,
	// with its credentials, catalog and usage in LLMStateDir (production:
	// the volume llm). The controller and the routine worker reach it on
	// the internal listener at LLMGatewayURL.
	LLMStateDir   string `env:"AXP_LLM_STATE_DIR" default:"var/llm-gateway"`
	LLMGatewayURL string `env:"AXP_LLM_GATEWAY_URL" dev:"http://127.0.0.1:8001" prod:"http://api.axp.svc.cluster.local:8001"`
	// NATS JetStream, where runtimes publish their events (runtimes reach it
	// at the same address) and routines' schedules live.
	NATSURL string `env:"AXP_NATS_URL" dev:"nats://nats.axp-dev.svc.cluster.local:4222" prod:"nats://nats.axp.svc.cluster.local:4222"`
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
	S3Endpoint        string `env:"AXP_S3_ENDPOINT" dev:"http://s3.axp-dev.svc.cluster.local:8333"`
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
	if c.ClusterDNS != "" {
		net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, c.ClusterDNS)
		}}
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
