package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// The daemon as a user service: systemd on Linux, launchd on macOS.

const (
	unitName   = "axp.service"
	agentLabel = "moe.akr.axp"
)

func unitPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user", unitName)
}

func plistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", agentLabel+".plist")
}

// servicePath is the PATH the service runs with: this shell's, so it finds
// node, paseo, herdr, git and gh as the user does.
func servicePath() string { return os.Getenv("PATH") }

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return nil
}

func installService() error {
	switch runtime.GOOS {
	case "linux":
		unit := fmt.Sprintf(`[Unit]
Description=AXP remote computer (agenvo connectors)
After=network-online.target

[Service]
ExecStart=%s daemon
Environment=PATH=%s
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`, self(), servicePath())
		if err := os.MkdirAll(filepath.Dir(unitPath()), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(unitPath(), []byte(unit), 0o644); err != nil {
			return err
		}
		if err := run("systemctl", "--user", "daemon-reload"); err != nil {
			return err
		}
		if err := run("systemctl", "--user", "enable", unitName); err != nil {
			return err
		}
		if err := run("systemctl", "--user", "restart", unitName); err != nil {
			return err
		}
		if user := os.Getenv("USER"); user != "" {
			if out, _ := exec.Command("loginctl", "show-user", user, "--property=Linger").Output(); strings.Contains(string(out), "Linger=no") {
				fmt.Printf("提示：要在退出登录后继续运行，执行 `loginctl enable-linger %s`。\n", user)
			}
		}
		return nil
	case "darwin":
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>%s</string>
	<key>ProgramArguments</key><array><string>%s</string><string>daemon</string></array>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, agentLabel, self(), servicePath(), filepath.Join(configDir(), "daemon.log"))
		if err := os.MkdirAll(filepath.Dir(plistPath()), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(plistPath(), []byte(plist), 0o644); err != nil {
			return err
		}
		domain := fmt.Sprintf("gui/%d", os.Getuid())
		_ = run("launchctl", "bootout", domain+"/"+agentLabel)
		return run("launchctl", "bootstrap", domain, plistPath())
	}
	return fmt.Errorf("unsupported system %s", runtime.GOOS)
}

func uninstall() error {
	switch runtime.GOOS {
	case "linux":
		_ = run("systemctl", "--user", "disable", "--now", unitName)
		_ = os.Remove(unitPath())
		_ = run("systemctl", "--user", "daemon-reload")
	case "darwin":
		_ = run("launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), agentLabel))
		_ = os.Remove(plistPath())
	}
	if c, err := loadConfig(); err == nil {
		for _, kind := range c.kinds() {
			cmd := exec.Command(c.connectorBin(kind), "disconnect")
			cmd.Env = c.env(kind)
			_ = cmd.Run()
		}
	}
	if err := os.Remove(configPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Println("已停止并移除这台电脑上的 AXP 服务和凭据；任务工作区保留。")
	return nil
}
