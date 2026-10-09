package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSetupInstallsTheSkillForClaudeAndCodex(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := installSkill(); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{".claude/skills/axp", ".agents/skills/axp"} {
		got, err := os.ReadFile(filepath.Join(home, dir, "SKILL.md"))
		if err != nil || !bytes.Equal(got, skill) {
			t.Fatalf("%s: %v", dir, err)
		}
	}
	if !bytes.HasPrefix(skill, []byte("---\nname: axp\n")) {
		t.Fatal("the skill has no front matter")
	}
	uninstallSkill()
	if _, err := os.Stat(filepath.Join(home, ".agents/skills/axp")); !os.IsNotExist(err) {
		t.Fatal(err)
	}
}
