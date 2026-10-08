package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// trustRoot marks the task root as trusted for Claude Code, so an agent
// Herdr launches in a new task workspace does not stop at Claude's "do you
// trust this folder" screen: the mark covers the folders under it. The root
// holds only AXP's task workspaces, which the user chose to let agents work
// in. Paseo runs Claude through its SDK, which never asks.
func trustRoot(root string) error {
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".claude.json")
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	config := map[string]any{}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &config); err != nil {
			return err
		}
	}
	projects, _ := config["projects"].(map[string]any)
	if projects == nil {
		projects = map[string]any{}
		config["projects"] = projects
	}
	project, _ := projects[root].(map[string]any)
	if project == nil {
		project = map[string]any{}
		projects[root] = project
	}
	if project["hasTrustDialogAccepted"] == true {
		return nil
	}
	project["hasTrustDialogAccepted"] = true
	out, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".axp-tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
