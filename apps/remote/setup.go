package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// setup connects this computer to AXP: it is what the install command runs.
func setup(args []string) error {
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	url := flags.String("url", "", "AXP's address")
	code := flags.String("code", "", "the install command's code")
	root := flags.String("root", "", "where task workspaces go (default ~/axp/tasks)")
	caFile := flags.String("ca-file", os.Getenv("NODE_EXTRA_CA_CERTS"), "extra CA certificates (development)")
	noService := flags.Bool("no-service", false, "do not register the daemon as a user service; run `axp daemon` yourself")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *code == "" && flags.NArg() > 0 {
		*code = flags.Arg(0)
	}
	if *url == "" || *code == "" {
		return errors.New("usage: axp setup --url URL --code CODE [--root DIR]")
	}
	home, _ := os.UserHomeDir()
	if *root == "" {
		*root = filepath.Join(home, "axp", "tasks")
	}
	// The installation this binary is in (the install script puts it in
	// <AXP_HOME>/bin); its configuration goes there too.
	axpHome := configDir()

	step("检查 Node.js")
	if err := checkNode(); err != nil {
		return err
	}
	step("寻找这台电脑上的运行时（Paseo、Herdr）")
	c := &Config{URL: strings.TrimRight(*url, "/"), Root: *root, Home: axpHome, CAFile: *caFile}
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
	var enrolled struct {
		ComputerID  string `json:"computer_id"`
		Name        string `json:"name"`
		Token       string `json:"token"`
		RelayOrigin string `json:"relay_origin"`
	}
	if err := call(c.URL, "", "POST", "/remote/v1/enroll", map[string]string{"code": *code}, &enrolled); err != nil {
		return err
	}
	c.Token, c.ComputerID, c.Name, c.RelayOrigin = enrolled.Token, enrolled.ComputerID, enrolled.Name, enrolled.RelayOrigin
	if err := os.MkdirAll(c.Root, 0o755); err != nil {
		return err
	}
	if err := c.save(); err != nil {
		return err
	}

	step("安装 agenvo connector")
	if err := installConnectors(c); err != nil {
		return err
	}
	if err := configureConnectors(c); err != nil {
		return err
	}

	if *noService {
		fmt.Printf("没有注册服务：运行 `%s daemon` 来启动。\n", self())
	} else {
		step("注册为开机启动的服务")
		if err := installService(); err != nil {
			return fmt.Errorf("%w\n可以先手动运行 `%s daemon`", err, self())
		}
	}
	fmt.Printf(`
已接入 AXP，这台电脑叫「%s」。
打开 AXP 的 设置 → 远程电脑，核对指纹后批准 %s。
任务工作区在 %s。`+"\n", c.Name, runtimesText(c), c.Root)
	return nil
}

func step(s string) { fmt.Println("==>", s) }

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
// under AXP_HOME, away from any global installation.
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
	for _, kind := range c.kinds() {
		var args []string
		switch kind {
		case "paseo":
			args = []string{"instance", "add", "--id", "paseo", "--endpoint", c.Paseo.Endpoint}
		case "herdr":
			args = []string{"instance", "add", "--id", "herdr", "--config-root", c.Herdr.ConfigRoot, "--cwd", c.Root}
		}
		if _, err := os.Stat(filepath.Join(c.connectorDir(kind), "config.json")); err == nil {
			continue
		}
		if err := os.MkdirAll(c.connectorDir(kind), 0o700); err != nil {
			return err
		}
		cmd := exec.Command(c.connectorBin(kind), args...)
		cmd.Env = c.env(kind)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("配置 %s connector 失败：%s", kind, out)
		}
	}
	return nil
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
