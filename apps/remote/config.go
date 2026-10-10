package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config is this computer's connection to AXP, written by setup into the
// installation (<AXP_HOME>/config.json, 0600): the CLI finds it from its own
// binary (<AXP_HOME>/bin/axp), whatever environment an agent runs it in.
type Config struct {
	URL        string `json:"url"`
	Token      string `json:"token"`
	ComputerID string `json:"computer_id"`
	Name       string `json:"name"`
	// The relay's base URL, which the connectors pair and connect with.
	RelayURL string `json:"relay_url"`
	// The relay's agenvo version, which setup installs (the latest when
	// empty); AXP says it on every setup.
	ConnectorVersion string `json:"-"`
	// Where setup installed the connectors.
	Home string `json:"home"`
	// The runtimes setup found, by kind.
	Paseo *PaseoConfig `json:"paseo,omitempty"`
	Herdr *HerdrConfig `json:"herdr,omitempty"`
	// Extra CA certificates for the relay and AXP (development).
	CAFile string `json:"ca_file,omitempty"`
}

type PaseoConfig struct {
	Endpoint string `json:"endpoint"`
}

type HerdrConfig struct {
	ConfigRoot string `json:"config_root"`
}

func configDir() string {
	if dir := os.Getenv("AXP_CONFIG_DIR"); dir != "" {
		return dir
	}
	return filepath.Dir(filepath.Dir(self()))
}

func configPath() string { return filepath.Join(configDir(), "config.json") }

func loadConfig() (*Config, error) {
	data, err := os.ReadFile(configPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("this computer is not connected to AXP; run the install command from AXP's settings (远程电脑)")
	}
	if err != nil {
		return nil, err
	}
	var c Config
	return &c, json.Unmarshal(data, &c)
}

func (c *Config) save() error {
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(c, "", "  ")
	tmp := configPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, configPath())
}

// connectorDir is a connector's own configuration (AGENVO_CONFIG_DIR).
func (c *Config) connectorDir(kind string) string { return filepath.Join(c.Home, "connectors", kind) }

func (c *Config) connectorBin(kind string) string {
	return filepath.Join(c.Home, "agenvo", "bin", "agenvo-"+kind)
}

// --- AXP's /remote API ----------------------------------------------------------------

type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("AXP answered HTTP %d", e.Status)
}

var client = &http.Client{Timeout: 60 * time.Second}

// call is one request to AXP's /remote API.
func call(url, token, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		data, _ := json.Marshal(in)
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, strings.TrimRight(url, "/")+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach AXP: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		return &apiError{resp.StatusCode, e.Error.Code, e.Error.Message}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (c *Config) call(method, path string, in, out any) error {
	return call(c.URL, c.Token, method, path, in, out)
}
