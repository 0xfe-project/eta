package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The daemon keeps each connector paired and running, tells AXP what it
// sees every few seconds, and creates the task workspaces AXP asks for.

const (
	heartbeatEvery = 3 * time.Second
	restartAfter   = 5 * time.Second
	providersEvery = time.Minute
)

// connector is one agenvo connector the daemon supervises.
type connector struct {
	kind string
	c    *Config

	mu          sync.Mutex
	pairingCode string
	fingerprint string
	deviceID    string
	lastError   string
	providers   []string
	checkedAt   time.Time
}

type report struct {
	Kind      string   `json:"kind"`
	Providers []string `json:"providers"`
	Pairing   *pairing `json:"pairing,omitempty"`
	DeviceID  *string  `json:"device_id,omitempty"`
	Error     *string  `json:"error,omitempty"`
}

type pairing struct {
	Code        string `json:"code"`
	Fingerprint string `json:"fingerprint"`
}

func (k *connector) report() report {
	if time.Since(k.checkedAt) > providersEvery {
		var providers []string
		if k.kind == "paseo" {
			providers = paseoProviders()
		} else {
			providers = herdrKinds()
		}
		k.mu.Lock()
		k.providers, k.checkedAt = providers, time.Now()
		k.mu.Unlock()
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	r := report{Kind: k.kind, Providers: k.providers}
	if r.Providers == nil {
		r.Providers = []string{}
	}
	if k.deviceID != "" {
		id := k.deviceID
		r.DeviceID = &id
	} else if k.pairingCode != "" {
		r.Pairing = &pairing{k.pairingCode, k.fingerprint}
	}
	if k.lastError != "" {
		e := k.lastError
		r.Error = &e
	}
	return r
}

func (k *connector) fail(message string) {
	k.mu.Lock()
	k.lastError = message
	k.mu.Unlock()
	slog.Warn("Connector problem", "kind", k.kind, "error", message)
}

// pairedDevice is the device the connector's own configuration has, if any.
func (k *connector) pairedDevice() string {
	data, err := os.ReadFile(filepath.Join(k.c.connectorDir(k.kind), "config.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		DeviceID string `json:"deviceId"`
	}
	_ = json.Unmarshal(data, &cfg)
	return cfg.DeviceID
}

func (k *connector) command(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, k.c.connectorBin(k.kind), args...)
	cmd.Env = k.c.env(k.kind)
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 10 * time.Second
	orphanless(cmd)
	return cmd
}

// supervise pairs the connector when it is not, then keeps it running.
func (k *connector) supervise(ctx context.Context) {
	for ctx.Err() == nil {
		device := k.pairedDevice()
		k.mu.Lock()
		k.deviceID = device
		k.mu.Unlock()
		var err error
		if device == "" {
			err = k.pair(ctx)
		} else {
			err = k.run(ctx)
		}
		if err != nil && ctx.Err() == nil {
			k.fail(err.Error())
		}
		select {
		case <-ctx.Done():
		case <-time.After(restartAfter):
		}
	}
}

// pair runs `connect`, which prints the pairing (code and fingerprint) and
// waits until the user approves it in AXP. A pending pairing survives
// restarts: running connect again picks it up.
func (k *connector) pair(ctx context.Context) error {
	name := k.c.Name + " · " + k.kind
	cmd := k.command(ctx, "connect", k.c.RelayOrigin, "--name", name, "--no-browser")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	decoder := json.NewDecoder(stdout)
	for {
		var out struct {
			Code        string `json:"code"`
			Fingerprint string `json:"fingerprint"`
			Paired      bool   `json:"paired"`
			DeviceID    string `json:"deviceId"`
		}
		if err := decoder.Decode(&out); err != nil {
			if !errors.Is(err, io.EOF) {
				slog.Warn("Unreadable connector output", "kind", k.kind, "error", err)
			}
			break
		}
		k.mu.Lock()
		if out.Code != "" {
			k.pairingCode, k.fingerprint, k.lastError = out.Code, out.Fingerprint, ""
			slog.Info("Waiting for approval in AXP", "kind", k.kind, "fingerprint", out.Fingerprint)
		}
		if out.Paired {
			k.deviceID, k.pairingCode, k.fingerprint = out.DeviceID, "", ""
			slog.Info("Paired", "kind", k.kind, "device", out.DeviceID)
		}
		k.mu.Unlock()
	}
	if err := cmd.Wait(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("配对没有完成：%s", lastLine(stderr.String(), err))
	}
	return nil
}

func (k *connector) run(ctx context.Context) error {
	// A connector that died uncleanly leaves its lock; doctor removes it only
	// when that process is gone. The daemon is the only one starting it.
	_ = k.command(ctx, "doctor", "--recover-lock").Run()
	cmd := k.command(ctx, "run")
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	k.mu.Lock()
	k.lastError = ""
	k.mu.Unlock()
	// The connector logs JSON lines; the daemon's own log keeps them.
	var last string
	scanner := bufio.NewScanner(stderr)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Fprintf(os.Stderr, "[%s] %s\n", k.kind, line)
		var entry struct {
			Level    any    `json:"level"`
			Message  string `json:"msg"`
			Message2 string `json:"message"`
		}
		if json.Unmarshal([]byte(line), &entry) == nil && (entry.Level == "error" || entry.Level == float64(50)) {
			last = entry.Message + entry.Message2
		}
	}
	err = cmd.Wait()
	if ctx.Err() != nil {
		return nil
	}
	if last == "" && err != nil {
		last = err.Error()
	}
	return fmt.Errorf("connector 退出了：%s", last)
}

func lastLine(s string, err error) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if l := strings.TrimSpace(lines[len(lines)-1]); l != "" {
		return l
	}
	return err.Error()
}

func daemon() error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	slog.Info("AXP daemon started", "computer", c.Name, "axp", c.URL, "relay", c.RelayOrigin, "root", c.Root)
	if c.Herdr != nil {
		if err := trustRoot(c.Root); err != nil {
			slog.Warn("Cannot mark the task root trusted for Claude Code", "error", err)
		}
	}

	var connectors []*connector
	var wg sync.WaitGroup
	for _, kind := range c.kinds() {
		k := &connector{kind: kind, c: c}
		connectors = append(connectors, k)
		wg.Go(func() { k.supervise(ctx) })
	}
	hostname, _ := os.Hostname()
	prepared := map[string]bool{}
	for ctx.Err() == nil {
		reports := make([]report, 0, len(connectors))
		for _, k := range connectors {
			reports = append(reports, k.report())
		}
		var reply struct {
			RelayOrigin string `json:"relay_origin"`
			Prepare     []struct {
				RunID  string `json:"run_id"`
				TaskID string `json:"task_id"`
			} `json:"prepare"`
		}
		err := c.call("POST", "/remote/v1/heartbeat", map[string]any{
			"hostname": hostname, "os": goos(), "arch": goarch(), "workspace_root": c.Root, "cli": self(),
			"runtimes": reports,
		}, &reply)
		var apiErr *apiError
		if errors.As(err, &apiErr) && apiErr.Status == 401 {
			// Removed in AXP: stop rather than keep a revoked computer alive.
			stop()
			wg.Wait()
			return errors.New("AXP 不再认可这台电脑（已被移除）；重新运行安装命令以再次接入")
		}
		if err != nil {
			slog.Warn("Heartbeat failed", "error", err)
		}
		for _, p := range reply.Prepare {
			if prepared[p.RunID] {
				continue
			}
			if err := prepare(c, p.RunID, p.TaskID); err != nil {
				slog.Warn("Cannot prepare a workspace", "task", p.TaskID, "error", err)
				continue
			}
			prepared[p.RunID] = true
		}
		select {
		case <-ctx.Done():
		case <-time.After(heartbeatEvery):
		}
	}
	wg.Wait()
	return nil
}

// prepare creates <root>/<task id>/ and tells AXP it is ready.
func prepare(c *Config, runID, taskID string) error {
	if strings.ContainsAny(taskID, `/\.`) || taskID == "" {
		return fmt.Errorf("invalid task id %q", taskID)
	}
	workspace := filepath.Join(c.Root, taskID)
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		return err
	}
	err := c.call("POST", "/remote/v1/runs/"+runID+"/prepared", map[string]string{"workspace": workspace}, nil)
	var apiErr *apiError
	if errors.As(err, &apiErr) && apiErr.Status == 409 {
		return nil
	}
	if err == nil {
		slog.Info("Workspace ready", "task", taskID, "workspace", workspace)
	}
	return err
}
