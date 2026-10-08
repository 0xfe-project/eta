package main

import (
	"os/exec"
	"syscall"
)

// orphanless makes the child stop when the daemon dies, however it dies.
func orphanless(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}
