//go:build !linux

package main

import "os/exec"

// orphanless: only Linux can tie a child's life to its parent's; elsewhere
// the service manager stops the whole process group.
func orphanless(*exec.Cmd) {}
