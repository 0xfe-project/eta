// Package config reads the control plane's settings from the environment.
//
// Each field declares its defaults: development's (fixed addresses on the
// runtime network's gateway, 172.30.0.1, or loopback; only scripts/dev.sh
// sets AXP_DEV) and production's (Kamal network aliases). scripts/dev.sh
// sets the ones that move with its port block, deploy/deploy.yml the
// production credentials.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/akarachen/axp/packages/service-go/config"
	"github.com/akarachen/axp/packages/service-go/pg"
)

type Config struct {
	// Development: its own runtime network, image and container names.
	Dev bool `env:"AXP_DEV"`
	// Signs runtime tokens and cursors; every control plane process must
	// share it. Without it, a key generated once per checkout is used.
	SecretKey   string `env:"AXP_SECRET_KEY"`
	DatabaseURL string `env:"DATABASE_URL" default:"postgres://axp:axp@127.0.0.1:15432/axp"`
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
	RuntimeGatewayURL string `env:"AXP_RUNTIME_GATEWAY_URL" dev:"http://172.30.0.1:8090" prod:"http://axp-runtime-gateway:8090"`
	// The runtime image agents' images are built on (apps/agent-runtime).
	RuntimeImage string `env:"AXP_RUNTIME_IMAGE" dev:"axp-agent-runtime:dev" prod:"axp-agent-runtime:production"`
	// The LLM gateway (apps/llm-gateway), for its model catalog.
	LLMGatewayURL string `env:"AXP_LLM_GATEWAY_URL" dev:"http://127.0.0.1:8317" prod:"http://axp-llm:8317"`
	// NATS JetStream, where runtimes publish their events. Runtimes reach it
	// at the same address.
	NATSURL string `env:"AXP_NATS_URL" dev:"nats://172.30.0.1:4222" prod:"nats://axp-nats:4222"`
	// The built-in bundles and the plugins bundles add
	// (apps/agent-runtime/bundles and plugins), which agents' images are
	// built from; the production image copies them alongside.
	BundlesDir string `env:"AXP_BUNDLES_DIR" default:"../agent-runtime/bundles"`
	PluginsDir string `env:"AXP_PLUGINS_DIR" default:"../agent-runtime/plugins"`
	// The agenvo relay (@agenvo/server), which remote computers' connectors
	// pair with at its public base URL (production: AXP_PUBLIC_URL under
	// /remote/relay); the control plane reaches it at RelayURL. Remote
	// computers are off without the base URL or the administrator secret.
	RelayURL         string `env:"AXP_RELAY_URL" prod:"http://axp-relay:8080"`
	RelayBaseURL     string `env:"AXP_RELAY_BASE_URL"`
	RelayAdminSecret string `env:"AXP_RELAY_ADMIN_SECRET"`
	// The only CA trusted for the relay (development's self-signed one).
	RelayCAFile string `env:"AXP_RELAY_CA_FILE"`
	// Where remote computers reach AXP (install commands); the browser's
	// address when empty.
	PublicURL string `env:"AXP_PUBLIC_URL"`
	// The GitHub App's credentials and the user's authorization
	// (internal/github); production keeps them on the axp-forge volume.
	ForgeStateDir string `env:"AXP_FORGE_STATE_DIR" default:"var/forge"`
	// Directories (colon-separated) with what remote computers download: the
	// axp binaries and the agenvo connectors built from the pinned commit.
	RemoteDist string `env:"AXP_REMOTE_DIST" default:"../remote/out/dist:../agenvo/out/dist"`
	// S3-compatible object storage for artifacts: development's SeaweedFS
	// (scripts/dev.sh), production's built-in one or any external service
	// (deploy/README.md). Artifacts are off without an endpoint.
	S3Endpoint        string `env:"AXP_S3_ENDPOINT" dev:"http://127.0.0.1:18333"`
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
