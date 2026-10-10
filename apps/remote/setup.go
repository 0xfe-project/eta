package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// setup connects this computer to AXP: it is what the install command runs,
// and running it again picks up changed runtimes. It enrolls, installs the
// axp skill for the agents here and an agenvo connector per runtime found here, pairs each with AXP's relay
// (waiting for the user to approve it in AXP) and runs it as the
// connector's own user service.
func setup(args []string) error {
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	url := flags.String("url", "", "AXP's address")
	code := flags.String("code", "", "the install command's code")
	caFile := flags.String("ca-file", os.Getenv("NODE_EXTRA_CA_CERTS"), "extra CA certificates (development)")
	noService := flags.Bool("no-service", false, "do not register the connectors as user services; run them yourself")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *code == "" && flags.NArg() > 0 {
		*code = flags.Arg(0)
	}

	step("检查 Node.js")
	if err := checkNode(); err != nil {
		return err
	}
	step("寻找这台电脑上的运行时（Paseo、Herdr）")
	c, err := loadConfig()
	if err != nil {
		if *url == "" || *code == "" {
			return errors.New("usage: axp setup --url URL --code CODE")
		}
		c = &Config{Home: configDir()}
	}
	if *url != "" {
		c.URL = strings.TrimRight(*url, "/")
	}
	if *caFile != "" {
		c.CAFile = *caFile
	}
	c.Paseo, c.Herdr = nil, nil
	if endpoint, err := findPaseo(); err == nil {
		c.Paseo = &PaseoConfig{Endpoint: endpoint}
		fmt.Printf("  Paseo: %s\n", endpoint)
	} else {
		fmt.Printf("  Paseo: %v\n", err)
	}
	if configRoot, err := findHerdr(); err == nil {
		c.Herdr = &HerdrConfig{ConfigRoot: configRoot}
		fmt.Printf("  Herdr: %s\n", configRoot)
	} else {
		fmt.Printf("  Herdr: %v\n", err)
	}
	if c.Paseo == nil && c.Herdr == nil {
		return errors.New("这台电脑上没有可用的运行时：先启动 Paseo daemon（paseo daemon start）或安装 Herdr，再运行一次安装命令")
	}

	step("连接 AXP")
	if err := connect(c, *code); err != nil {
		return err
	}

	step("为这里的智能体安装 axp skill")
	if err := installSkill(); err != nil {
		return err
	}

	step("安装 agenvo connector")
	if err := installConnectors(c); err != nil {
		return err
	}
	if err := configureConnectors(c); err != nil {
		return err
	}
	if err := followRelay(c); err != nil {
		return err
	}

	step("与 AXP 的中继配对")
	if err := pairConnectors(c); err != nil {
		return err
	}

	if *noService {
		for _, kind := range c.kinds() {
			fmt.Printf("没有注册服务：用 AGENVO_CONFIG_DIR=%s %s run 运行 %s connector。\n", c.connectorDir(kind), c.connectorBin(kind), kind)
		}
	} else {
		step("注册为开机启动的服务")
		// Installing again restarts a running service, so it runs the
		// connector just installed, with its current relay address.
		for _, kind := range c.kinds() {
			if out, err := c.connector(kind, "service", "uninstall").CombinedOutput(); err != nil {
				return fmt.Errorf("停止 %s connector 服务失败：%s", kind, out)
			}
			if out, err := c.connector(kind, "service", "install").CombinedOutput(); err != nil {
				return fmt.Errorf("注册 %s connector 服务失败：%s", kind, out)
			}
		}
		if runtime.GOOS == "linux" {
			if user := os.Getenv("USER"); user != "" {
				if out, _ := exec.Command("loginctl", "show-user", user, "--property=Linger").Output(); strings.Contains(string(out), "Linger=no") {
					fmt.Printf("提示：要在退出登录后继续运行，执行 `loginctl enable-linger %s`。\n", user)
				}
			}
		}
	}
	fmt.Printf("\n已接入 AXP，这台电脑叫「%s」。现在可以把任务指派给它上面的 %s 了。\n", c.Name, runtimesText(c))
	return nil
}

func step(s string) { fmt.Println("==>", s) }

// connect enrolls with the install command's code, or reports with the
// token setup has. A code always enrolls: it is how a computer AXP removed
// (its token deleted, its pairings revoked) comes back, and AXP may have
// given the same computer a new code. Enrolled as another computer, the
// connectors' pairings were under the old one's label: they pair again.
func connect(c *Config, code string) error {
	if code == "" {
		if c.Token == "" {
			return errors.New("usage: axp setup --url URL --code CODE")
		}
		var reported struct {
			RelayURL string `json:"relay_url"`
		}
		err := c.call("POST", "/remote/v1/report", c.report(), &reported)
		if e, ok := errors.AsType[*apiError](err); ok && e.Status == http.StatusUnauthorized {
			return errors.New("AXP 不再认识这台电脑（可能已被移除）：在 AXP 的 设置 → 远程电脑 中复制新的安装命令，再运行一次")
		}
		if err != nil {
			return err
		}
		if reported.RelayURL != "" {
			c.RelayURL = reported.RelayURL
		}
		return c.save()
	}
	var enrolled struct {
		ComputerID string `json:"computer_id"`
		Name       string `json:"name"`
		Token      string `json:"token"`
		RelayURL   string `json:"relay_url"`
	}
	report := c.report()
	report["code"] = code
	if err := call(c.URL, "", "POST", "/remote/v1/enroll", report, &enrolled); err != nil {
		return err
	}
	if c.ComputerID != "" && c.ComputerID != enrolled.ComputerID {
		c.unpair()
	}
	c.Token, c.ComputerID, c.Name, c.RelayURL = enrolled.Token, enrolled.ComputerID, enrolled.Name, enrolled.RelayURL
	return c.save()
}

// unpair forgets the connectors' pairings (revoking them where the relay
// still has them) and stops their services, so that they pair again.
func (c *Config) unpair() {
	for _, kind := range []string{"paseo", "herdr"} {
		if _, err := os.Stat(c.connectorBin(kind)); err == nil {
			_ = c.connector(kind, "disconnect").Run()
		}
	}
}

// report is what AXP is told about this computer.
func (c *Config) report() map[string]any {
	hostname, _ := os.Hostname()
	runtimes := []map[string]any{}
	if c.Paseo != nil {
		runtimes = append(runtimes, map[string]any{"kind": "paseo", "providers": orEmpty(paseoProviders())})
	}
	if c.Herdr != nil {
		runtimes = append(runtimes, map[string]any{"kind": "herdr", "providers": orEmpty(herdrKinds())})
	}
	return map[string]any{"hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH, "cli": self(), "runtimes": runtimes}
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func runtimesText(c *Config) string {
	var kinds []string
	if c.Paseo != nil {
		kinds = append(kinds, "Paseo")
	}
	if c.Herdr != nil {
		kinds = append(kinds, "Herdr")
	}
	return strings.Join(kinds, " 和 ")
}

// self is this binary's path, symbolic links resolved.
func self() string {
	path, err := os.Executable()
	if err != nil {
		return "axp"
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return path
}

var nodeVersion = regexp.MustCompile(`^v(\d+)\.(\d+)`)

func checkNode() error {
	out, err := exec.Command("node", "--version").Output()
	if err != nil {
		return errors.New("需要 Node.js 24.13 或更新版本（agenvo connector 运行在 Node 上），但没有找到 node")
	}
	m := nodeVersion.FindStringSubmatch(strings.TrimSpace(string(out)))
	if m == nil {
		return fmt.Errorf("无法识别 Node.js 版本 %q", out)
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	if major < 24 || (major == 24 && minor < 13) {
		return fmt.Errorf("需要 Node.js 24.13 或更新版本，这里是 %s", strings.TrimSpace(string(out)))
	}
	if _, err := exec.LookPath("npm"); err != nil {
		return errors.New("没有找到 npm")
	}
	return nil
}

// findPaseo is the running Paseo daemon's WebSocket endpoint.
func findPaseo() (string, error) {
	if _, err := exec.LookPath("paseo"); err != nil {
		return "", errors.New("没有安装")
	}
	out, err := exec.Command("paseo", "daemon", "status", "--json").Output()
	if err != nil {
		return "", errors.New("daemon 没有运行（paseo daemon start）")
	}
	var st struct {
		Listen      string `json:"listen"`
		LocalDaemon string `json:"localDaemon"`
	}
	if json.Unmarshal(out, &st) != nil || st.Listen == "" {
		return "", errors.New("无法读取 daemon 的地址")
	}
	if st.LocalDaemon != "" && st.LocalDaemon != "running" {
		return "", errors.New("daemon 没有运行（paseo daemon start）")
	}
	conn, err := net.DialTimeout("tcp", st.Listen, 2*time.Second)
	if err != nil {
		return "", fmt.Errorf("连不上 daemon（%s）", st.Listen)
	}
	conn.Close()
	return "ws://" + st.Listen + "/ws", nil
}

// paseoProviders are the providers Paseo can run with full access here.
func paseoProviders() []string {
	out, err := exec.Command("paseo", "provider", "ls", "--json").Output()
	if err != nil {
		return nil
	}
	var list []struct {
		Provider string `json:"provider"`
		Status   string `json:"status"`
	}
	if json.Unmarshal(out, &list) != nil {
		return nil
	}
	var providers []string
	for _, p := range list {
		// The connector runs only these with full access.
		if p.Status == "available" && (p.Provider == "codex" || p.Provider == "claude") {
			providers = append(providers, p.Provider)
		}
	}
	return providers
}

var herdrSocket = regexp.MustCompile(`socket:\s*(\S+herdr\.sock)`)

// findHerdr is Herdr's configuration root (the directory of its socket).
func findHerdr() (string, error) {
	if _, err := exec.LookPath("herdr"); err != nil {
		return "", errors.New("没有安装")
	}
	out, _ := exec.Command("herdr", "status").CombinedOutput()
	if m := herdrSocket.FindSubmatch(out); m != nil {
		return filepath.Dir(string(m[1])), nil
	}
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "herdr"), nil
	}
	return filepath.Join(home, ".config", "herdr"), nil
}

// herdrKinds are the agents Herdr can launch with full access here.
func herdrKinds() []string {
	var kinds []string
	for _, k := range []string{"codex", "claude", "devin"} {
		if _, err := exec.LookPath(k); err == nil {
			kinds = append(kinds, k)
		}
	}
	return kinds
}

func (c *Config) kinds() []string {
	var kinds []string
	if c.Paseo != nil {
		kinds = append(kinds, "paseo")
	}
	if c.Herdr != nil {
		kinds = append(kinds, "herdr")
	}
	return kinds
}

// installConnectors installs the connectors AXP serves (its pinned agenvo)
// under the installation, away from any global one.
func installConnectors(c *Config) error {
	args := []string{"install", "--global", "--prefix", filepath.Join(c.Home, "agenvo"), "--no-audit", "--no-fund", "--loglevel=error"}
	for _, kind := range c.kinds() {
		args = append(args, c.URL+"/remote/dl/agenvo-"+kind+".tgz")
	}
	cmd := exec.Command("npm", args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.Env = c.env("")
	return cmd.Run()
}

// configureConnectors gives each connector its one instance, named after
// its kind (AXP calls it by that name).
func configureConnectors(c *Config) error {
	home, _ := os.UserHomeDir()
	for _, kind := range c.kinds() {
		if _, err := os.Stat(filepath.Join(c.connectorDir(kind), "config.json")); err == nil {
			continue
		}
		var args []string
		switch kind {
		case "paseo":
			args = []string{"instance", "add", "--id", "paseo", "--endpoint", c.Paseo.Endpoint}
		case "herdr":
			args = []string{"instance", "add", "--id", "herdr", "--config-root", c.Herdr.ConfigRoot, "--cwd", home}
		}
		if err := os.MkdirAll(c.connectorDir(kind), 0o700); err != nil {
			return err
		}
		if out, err := c.connector(kind, args...).CombinedOutput(); err != nil {
			return fmt.Errorf("配置 %s connector 失败：%s", kind, out)
		}
	}
	return nil
}

// followRelay points paired connectors at the relay's current base URL.
// The relay keeps its devices when its address changes (its state moves
// with it), so they need the new address, not a new pairing.
func followRelay(c *Config) error {
	for _, kind := range c.kinds() {
		if c.RelayURL == "" || c.paired(kind) == "" {
			continue
		}
		path := filepath.Join(c.connectorDir(kind), "config.json")
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var cfg map[string]any
		if err := json.Unmarshal(data, &cfg); err != nil {
			return err
		}
		if cfg["relay"] == c.RelayURL {
			continue
		}
		cfg["relay"] = c.RelayURL
		data, _ = json.MarshalIndent(cfg, "", "  ")
		if err := os.WriteFile(path+".tmp", data, 0o600); err != nil {
			return err
		}
		if err := os.Rename(path+".tmp", path); err != nil {
			return err
		}
		fmt.Printf("  %s：中继地址改为 %s\n", kind, c.RelayURL)
	}
	return nil
}

// paired is the device a connector's own configuration has, if any.
func (c *Config) paired(kind string) string {
	data, err := os.ReadFile(filepath.Join(c.connectorDir(kind), "config.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		DeviceID string `json:"deviceId"`
	}
	_ = json.Unmarshal(data, &cfg)
	return cfg.DeviceID
}

// pairConnectors pairs every unpaired connector under this computer's label
// and waits until the user approves each in AXP.
func pairConnectors(c *Config) error {
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, kind := range c.kinds() {
		if c.paired(kind) != "" {
			fmt.Printf("  %s：已配对\n", kind)
			continue
		}
		wg.Go(func() {
			cmd := c.connector(kind, "connect", c.RelayURL, "--name", "axp:"+c.ComputerID+":"+kind, "--no-browser")
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				errs <- err
				return
			}
			var stderr strings.Builder
			cmd.Stderr = &stderr
			if err := cmd.Start(); err != nil {
				errs <- err
				return
			}
			decoder := json.NewDecoder(stdout)
			for {
				var out struct {
					Fingerprint string `json:"fingerprint"`
					Paired      bool   `json:"paired"`
				}
				if err := decoder.Decode(&out); err != nil {
					if !errors.Is(err, io.EOF) {
						fmt.Fprintln(os.Stderr, "axp:", kind, "connector 输出无法识别：", err)
					}
					break
				}
				if out.Fingerprint != "" {
					fmt.Printf("  %s：在 AXP 的 设置 → 远程电脑 中核对指纹后批准\n      %s\n", kind, out.Fingerprint)
				}
				if out.Paired {
					fmt.Printf("  %s：已批准\n", kind)
				}
			}
			if err := cmd.Wait(); err != nil {
				errs <- fmt.Errorf("%s 配对没有完成：%s", kind, strings.TrimSpace(stderr.String()))
			}
		})
	}
	wg.Wait()
	close(errs)
	return <-errs
}

// connector runs a connector command with its configuration directory.
func (c *Config) connector(kind string, args ...string) *exec.Cmd {
	cmd := exec.Command(c.connectorBin(kind), args...)
	cmd.Env = c.env(kind)
	return cmd
}

// env is the environment for a connector (kind) or npm.
func (c *Config) env(kind string) []string {
	env := os.Environ()
	if kind != "" {
		env = append(env, "AGENVO_CONFIG_DIR="+c.connectorDir(kind))
	}
	if c.CAFile != "" {
		env = append(env, "NODE_EXTRA_CA_CERTS="+c.CAFile)
	}
	return env
}

// uninstall stops the connectors' services, revokes their pairings, removes
// the skill and forgets AXP's credentials.
func uninstall() error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	c.unpair()
	uninstallSkill()
	if err := os.Remove(configPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Println("已停止这台电脑上的 connector，并移除了 axp skill 和 AXP 的凭据。")
	return nil
}
