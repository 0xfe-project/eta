package main

import (
	_ "embed"
	"os"
	"path/filepath"
)

// skill is how agents use this CLI. It ships with the binary, so it always
// matches it, and is the only place that says so: the prompts AXP sends
// only name it.
//
//go:embed skills/axp/SKILL.md
var skill []byte

// skillDirs are where the agents AXP runs here find the user's skills:
// Claude Code, and Codex (and other Agent Skills readers).
func skillDirs() []string {
	home, _ := os.UserHomeDir()
	return []string{
		filepath.Join(home, ".claude", "skills", "axp"),
		filepath.Join(home, ".agents", "skills", "axp"),
	}
}

func installSkill() error {
	for _, dir := range skillDirs() {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), skill, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func uninstallSkill() {
	for _, dir := range skillDirs() {
		_ = os.RemoveAll(dir)
	}
}
