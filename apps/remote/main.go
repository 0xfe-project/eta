// Command axp connects a computer to AXP's task board
// (docs/architecture/tasks.md). One binary, two users:
//
// The computer's owner installs it with the command AXP shows
// (`curl … /remote/install.sh | sh -s -- <code>`), which runs `axp setup`:
// it checks the runtimes here (Paseo, Herdr), enrolls with AXP, installs
// the agenvo connectors, pairs them with AXP's relay and runs them as their
// own user services.
//
// Agents working on a task use the rest: `axp task …`, `axp gh …`, as the
// axp skill setup installs for them tells them (skills/axp/SKILL.md).
package main

import (
	"fmt"
	"os"
	"strings"
)

const usage = `axp — AXP on this computer

Agents, where they work on a task (or with --task N):
  axp task show                       the task, its status and comments
  axp task comment <text> | --file F  reply on the task (ends your turn)
  axp task status in_progress|in_review|blocked
  axp gh <args…>                      gh as AXP's GitHub App; PRs become deliverables

This computer:
  axp setup --url URL --code CODE     connect it to AXP (the install command);
                                      run again after adding or removing a runtime
  axp status                          the connectors' state
  axp uninstall                       stop the connectors, remove the skill and forget the credentials
`

func main() {
	args := os.Args[1:]
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Print(usage)
		return
	}
	var err error
	switch args[0] {
	case "setup":
		err = setup(args[1:])
	case "status":
		err = status()
	case "uninstall":
		err = uninstall()
	case "task":
		err = taskCommand(args[1:])
	case "gh":
		err = ghCommand(args[1:])
	default:
		err = fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "axp:", strings.TrimSpace(err.Error()))
		os.Exit(1)
	}
}
