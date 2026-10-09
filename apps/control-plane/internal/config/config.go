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
	// The runtime gateway (apps/gateway): runtimes' only route to the
	// internal API and the LLM gateway.
	RuntimeGatewayURL string `env:"AXP_RUNTIME_GATEWAY_URL" dev:"http://172.30.0.1:8090" prod:"http://axp-runtime-gateway:8090"`
	// The LLM gateway (apps/llm-gateway), for its model catalog.
	LLMGatewayURL string `env:"AXP_LLM_GATEWAY_URL" dev:"http://127.0.0.1:8317" prod:"http://axp-llm:8317"`
	// SeaweedFS's S3 API, holding agent snapshots. Runtimes reach it at the
	// same address through presigned URLs: in production through s3-proxy,
	// which forwards this port alone (deploy/deploy.yml).
	S3Endpoint        string `env:"AXP_S3_ENDPOINT" dev:"http://172.30.0.1:8333" prod:"http://axp-s3:8333"`
	S3AccessKeyID     string `env:"AXP_S3_ACCESS_KEY_ID" dev:"axp-dev"`
	S3SecretAccessKey string `env:"AXP_S3_SECRET_ACCESS_KEY" dev:"axp-dev-secret"`
	// NATS JetStream, the agent queue. Runtimes reach it at the same address.
	NATSURL string `env:"AXP_NATS_URL" dev:"nats://172.30.0.1:4222" prod:"nats://axp-nats:4222"`
	// The runtime image's Codex plugins (apps/agent-runtime/plugins), for the
	// catalog agents choose from; the production image copies them alongside.
	PluginsDir string `env:"AXP_PLUGINS_DIR" default:"../agent-runtime/plugins"`
	// The agenvo relay (vendor/agenvo), which remote computers' connectors
	// pair with at its public origin; the control plane reaches it at
	// RelayURL. Remote computers are off without the administrator secret.
	RelayURL         string `env:"AXP_RELAY_URL" prod:"http://axp-relay:8080"`
	RelayOrigin      string `env:"AXP_RELAY_ORIGIN"`
	RelayAdminSecret string `env:"AXP_RELAY_ADMIN_SECRET"`
	// The only CA trusted for the relay (development's self-signed one).
	RelayCAFile string `env:"AXP_RELAY_CA_FILE"`
	// Where remote computers reach AXP (install commands); the browser's
	// address when empty.
	PublicURL string `env:"AXP_PUBLIC_URL"`
	// The forge service, for remote computers' GitHub credentials.
	ForgeURL string `env:"AXP_FORGE_URL" prod:"http://axp-forge:8330"`
	// Directories (colon-separated) with what remote computers download: the
	// axp binaries and the agenvo connectors.
	RemoteDist string `env:"AXP_REMOTE_DIST" default:"../remote/out/dist:../relay/out/connectors"`
	// Test hook: runtimes run this instead of the Codex app-server.
	CodexLaunch string `env:"AXP_CODEX_LAUNCH"`
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
