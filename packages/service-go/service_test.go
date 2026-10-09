package service

import "testing"

func TestCommandsArePickedByName(t *testing.T) {
	commands := []Command{{Name: "serve", Default: true}, {Name: "migrate"}}
	if c, _, ok := pick(commands, nil); !ok || c.Name != "serve" {
		t.Fatal("no default")
	}
	if c, args, ok := pick(commands, []string{"migrate", "x"}); !ok || c.Name != "migrate" || args[0] != "x" {
		t.Fatal("by name")
	}
	if _, _, ok := pick(commands, []string{"nope"}); ok {
		t.Fatal("unknown")
	}
	if _, _, ok := pick(commands[1:], nil); ok {
		t.Fatal("no default command")
	}
	if usage("svc", commands) != "usage: svc serve | migrate" {
		t.Fatal(usage("svc", commands))
	}
}
