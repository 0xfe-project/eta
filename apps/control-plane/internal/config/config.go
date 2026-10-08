// Package config reads the control plane's settings from the environment.
//
// The defaults are development's (fixed addresses on the runtime network's
// gateway, 172.30.0.1, or loopback; only scripts/dev.sh sets AXP_DEV) and
// production's (Kamal network aliases). scripts/dev.sh sets the ones that
// move with its port block, deploy/deploy.yml the production credentials.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"strings"

	"github.com/caarlos0/env/v11"
)

type Config struct {
	// Development: its own runtime network, image and container names.
	Dev bool `env:"AXP_DEV"`
	// Signs runtime tokens and cursors; every control plane process must
	// share it. Without it, a key generated once per checkout is used.
	SecretKey   string `env:"AXP_SECRET_KEY"`
	DatabaseURL string `env:"DATABASE_URL"`
	APIAddr     string `env:"AXP_API_ADDR"`
	// The internal API, for runtimes (through the runtime gateway).
	InternalAddr string `env:"AXP_INTERNAL_ADDR"`
	// The runtime gateway (apps/gateway): runtimes' only route to the
	// internal API and the LLM gateway.
	RuntimeGatewayURL string `env:"AXP_RUNTIME_GATEWAY_URL"`
	// The LLM gateway (apps/llm-gateway), for its model catalog.
	LLMGatewayURL string `env:"AXP_LLM_GATEWAY_URL"`
	// SeaweedFS's S3 API, holding agent snapshots. Runtimes reach it at the
	// same address through presigned URLs.
	S3Endpoint        string `env:"AXP_S3_ENDPOINT"`
	S3AccessKeyID     string `env:"AXP_S3_ACCESS_KEY_ID"`
	S3SecretAccessKey string `env:"AXP_S3_SECRET_ACCESS_KEY"`
	// NATS JetStream, the agent queue. Runtimes reach it at the same address.
	NATSURL string `env:"AXP_NATS_URL"`
	// The runtime image's Codex plugins (apps/agent-runtime/plugins), for the
	// catalog agents choose from; the production image copies them alongside.
	PluginsDir string `env:"AXP_PLUGINS_DIR"`
	// The agenvo relay (vendor/agenvo), which remote computers' connectors
	// pair with at its public origin; the control plane reaches it at
	// RelayURL. Remote computers are off without the administrator secret.
	RelayURL         string `env:"AXP_RELAY_URL"`
	RelayOrigin      string `env:"AXP_RELAY_ORIGIN"`
	RelayAdminSecret string `env:"AXP_RELAY_ADMIN_SECRET"`
	// The only CA trusted for the relay (development's self-signed one).
	RelayCAFile string `env:"AXP_RELAY_CA_FILE"`
	// Where remote computers reach AXP (install commands); the browser's
	// address when empty.
	PublicURL string `env:"AXP_PUBLIC_URL"`
	// The forge service, for remote computers' GitHub credentials.
	ForgeURL string `env:"AXP_FORGE_URL"`
	// Directories (colon-separated) with what remote computers download: the
	// axp binaries and the agenvo connectors.
	RemoteDist string `env:"AXP_REMOTE_DIST"`
	// Test hook: runtimes run this instead of the Codex app-server.
	CodexLaunch string `env:"AXP_CODEX_LAUNCH"`
}

var defaults = map[string]string{
	"DATABASE_URL":      "postgres://axp:axp@127.0.0.1:15432/axp",
	"AXP_API_ADDR":      ":8000",
	"AXP_INTERNAL_ADDR": ":8001",
	"AXP_PLUGINS_DIR":   "../agent-runtime/plugins",
	"AXP_REMOTE_DIST":   "../remote/out/dist:../relay/out/connectors",
}

var production = map[string]string{
	"AXP_RUNTIME_GATEWAY_URL": "http://axp-runtime-gateway:8090",
	"AXP_LLM_GATEWAY_URL":     "http://axp-llm:8317",
	"AXP_S3_ENDPOINT":         "http://axp-s3:8333",
	"AXP_NATS_URL":            "nats://axp-nats:4222",
	"AXP_RELAY_URL":           "http://axp-relay:8080",
	"AXP_FORGE_URL":           "http://axp-forge:8330",
}

var development = map[string]string{
	"AXP_RUNTIME_GATEWAY_URL":  "http://172.30.0.1:8090",
	"AXP_LLM_GATEWAY_URL":      "http://127.0.0.1:8317",
	"AXP_S3_ENDPOINT":          "http://172.30.0.1:8333",
	"AXP_S3_ACCESS_KEY_ID":     "axp-dev",
	"AXP_S3_SECRET_ACCESS_KEY": "axp-dev-secret",
	"AXP_NATS_URL":             "nats://172.30.0.1:4222",
}

// Load reads the environment over the defaults.
func Load() (Config, error) {
	environment := maps.Clone(defaults)
	if strings.EqualFold(os.Getenv("AXP_DEV"), "true") {
		maps.Copy(environment, development)
	} else {
		maps.Copy(environment, production)
	}
	for k, v := range env.ToMap(os.Environ()) {
		if v != "" {
			environment[k] = v
		}
	}
	var c Config
	if err := env.ParseWithOptions(&c, env.Options{Environment: environment}); err != nil {
		return Config{}, err
	}
	if c.SecretKey == "" {
		var err error
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
