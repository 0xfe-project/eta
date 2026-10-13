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
)

type Config struct {
	// Development: its own runtime network, image and container names.
	Dev bool `env:"AXP_DEV"`
	// Signs runtime tokens and cursors; every control plane process must
	// share it. Without it, a key generated once per checkout is used.
	SecretKey   string `env:"AXP_SECRET_KEY"`
	DatabaseURL string `env:"DATABASE_URL" default:"postgres://axp:axp@127.0.0.1:15432/axp"`
	APIAddr     string `env:"AXP_API_ADDR" default:":8000"`
	// The internal API, for runtimes (through the runtime gateway).
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
	// The forge service, for remote computers' GitHub credentials.
	ForgeURL string `env:"AXP_FORGE_URL" prod:"http://axp-forge:8330"`
	// Directories (colon-separated) with what remote computers download: the
	// axp binaries and the agenvo connectors built from the pinned commit.
	RemoteDist string `env:"AXP_REMOTE_DIST" default:"../remote/out/dist:../agenvo/out/dist"`
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
