// Command axp-plugins prepares plugins when an image is built:
//
//	axp-plugins chat <plugins> <codex config dir> <image root>
//	    sets up the chat plugins and compiles them for Codex, in place
//	    (the agent runtime image; <image root> is where agents see them)
//	axp-plugins compile <plugins> <codex config dir> <image root>
//	    only compiles them (tests)
//	axp-plugins setup <target> <plugins> <bin dir>
//	    sets up the target's plugins, their executables into <bin dir>
//
// Setup scripts keep downloads in AXP_PLUGIN_CACHE (default
// /var/cache/axp-plugins).
package main

import (
	"fmt"
	"os"

	plugins "github.com/akarachen/axp/packages/plugins-go"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "axp-plugins:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cache := os.Getenv("AXP_PLUGIN_CACHE")
	if cache == "" {
		cache = "/var/cache/axp-plugins"
	}
	switch {
	case len(args) == 4 && args[0] == "chat":
		list, err := plugins.List(args[1], plugins.TargetChat)
		if err != nil {
			return err
		}
		if err := plugins.SetUp(list, cache, "/usr/local/bin"); err != nil {
			return err
		}
		return plugins.Chat(args[1], args[2], args[3])
	case len(args) == 4 && args[0] == "compile":
		return plugins.Chat(args[1], args[2], args[3])
	case len(args) == 4 && args[0] == "setup":
		list, err := plugins.List(args[2], args[1])
		if err != nil {
			return err
		}
		if err := os.MkdirAll(args[3], 0o755); err != nil {
			return err
		}
		return plugins.SetUp(list, cache, args[3])
	}
	return fmt.Errorf("usage: axp-plugins chat|compile <plugins> <codex dir> <image root> | setup <target> <plugins> <bin dir>")
}
