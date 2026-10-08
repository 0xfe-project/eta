// Command axp runs on a remote computer that works on AXP's tasks
// (docs/architecture/tasks.md). One binary, two users:
//
// The computer's owner installs it with the command AXP shows
// (`curl … /remote/install.sh | sh -s -- <code>`), which runs `axp setup`:
// it checks the runtimes here (Paseo, Herdr), installs the agenvo connectors,
// enrolls with AXP and registers `axp daemon` as a user service. The daemon
// keeps the connectors running and paired with AXP's relay, heartbeats to
// AXP, and creates task workspaces (<root>/<task id>/) when AXP asks.
//
// Agents working in a task workspace use the rest: `axp task …`,
// `axp repo checkout`, `axp gh …`.
package main

import (
	"fmt"
	"os"
	"strings"
)

const usage = `axp — AXP on this computer

Agents, in a task's workspace:
  axp task show                       the task, its status and comments
  axp task comment <text> | --file F  reply on the task (ends your turn)
  axp task status in_progress|in_review|blocked
  axp repo checkout <owner/name> [--ref REF]
                                      clone into the task workspace on a new branch
  axp gh <args…>                      gh as AXP's GitHub App; PRs become deliverables

This computer:
  axp setup --url URL --code CODE [--root DIR]   connect it to AXP (the install command)
  axp daemon                          run the connectors (the user service runs this)
  axp status                          what AXP and the relay see
  axp uninstall                       stop the service and forget the credentials
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
	case "daemon":
		err = daemon()
	case "status":
		err = status()
	case "uninstall":
		err = uninstall()
	case "task":
		err = taskCommand(args[1:])
	case "repo":
		err = repoCommand(args[1:])
	case "gh":
		err = ghCommand(args[1:])
	case "git-credential":
		err = gitCredential(args[1:])
	default:
		err = fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "axp:", strings.TrimSpace(err.Error()))
		os.Exit(1)
	}
}
