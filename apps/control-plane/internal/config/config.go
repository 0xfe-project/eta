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
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	// Development: its own runtime network, image and container names.
	Dev bool
	// Signs runtime tokens and cursors; every control plane process must
	// share it.
	SecretKey   []byte
	DatabaseURL string
	// The runtime gateway (apps/gateway): runtimes' only route to the internal
	// API and the LLM gateway.
	RuntimeGatewayURL string
	// The LLM gateway (apps/llm-gateway), for its model catalog.
	LLMGatewayURL string
	// SeaweedFS's S3 API, holding agent snapshots. Runtimes reach it at the
	// same address through presigned URLs.
	S3Endpoint        string
	S3AccessKeyID     string
	S3SecretAccessKey string
	// NATS JetStream, the agent queue. Runtimes reach it at the same address.
	NATSURL string
	// The runtime image's Codex plugins (apps/agent-runtime/plugins), for the
	// catalog agents choose from; the production image copies them alongside.
	PluginsDir string
	// Test hook: runtimes run this instead of the Codex app-server.
	CodexLaunch string
}

// Load reads the environment. Without AXP_SECRET_KEY, a key generated once
// per checkout is used (var/secret_key).
func Load() (Config, error) {
	dev := strings.EqualFold(os.Getenv("AXP_DEV"), "true")
	pick := func(devValue, prodValue string) string {
		if dev {
			return devValue
		}
		return prodValue
	}
	secret := os.Getenv("AXP_SECRET_KEY")
	if secret == "" {
		var err error
		if secret, err = localSecretKey("var/secret_key"); err != nil {
			return Config{}, err
		}
	}
	return Config{
		Dev:               dev,
		SecretKey:         []byte(secret),
		DatabaseURL:       env("DATABASE_URL", "postgres://axp:axp@127.0.0.1:15432/axp"),
		RuntimeGatewayURL: env("AXP_RUNTIME_GATEWAY_URL", pick("http://172.30.0.1:8090", "http://axp-runtime-gateway:8090")),
		LLMGatewayURL:     env("AXP_LLM_GATEWAY_URL", pick("http://127.0.0.1:8317", "http://axp-llm:8317")),
		S3Endpoint:        env("AXP_S3_ENDPOINT", pick("http://172.30.0.1:8333", "http://axp-s3:8333")),
		S3AccessKeyID:     env("AXP_S3_ACCESS_KEY_ID", pick("axp-dev", "")),
		S3SecretAccessKey: env("AXP_S3_SECRET_ACCESS_KEY", pick("axp-dev-secret", "")),
		NATSURL:           env("AXP_NATS_URL", pick("nats://172.30.0.1:4222", "nats://axp-nats:4222")),
		PluginsDir:        env("AXP_PLUGINS_DIR", "../agent-runtime/plugins"),
		CodexLaunch:       os.Getenv("AXP_CODEX_LAUNCH"),
	}, nil
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
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
	if _, err := rand.Read(key); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	secret := hex.EncodeToString(key)
	return secret, os.WriteFile(path, []byte(secret), 0o600)
}
