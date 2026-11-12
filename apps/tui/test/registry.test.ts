import type { SlashCommand } from "../src/extensions/types";
import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../src/extensions/command-line";
import { createRegistry } from "../src/extensions/registry";

function command(
  name: string,
  extra: Partial<SlashCommand> = {},
): SlashCommand {
  return {
    name,
    args: [],
    summary: { en: `${name} summary`, zh: `${name} 说明` },
    examples: [],
    requiredOps: [],
    run: () => {},
    ...extra,
  };
}

function view(kind: string) {
  return { kind, Component: () => null, useTitle: () => kind };
}

function pinned(id: string) {
  return { id, useLabel: () => "", onSelect: () => {} };
}

describe("createRegistry", () => {
  it("lists commands sorted by name across extensions", () => {
    const registry = createRegistry([
      { id: "b", commands: [command("zeta"), command("alpha")] },
      { id: "a", commands: [command("mid")] },
    ]);
    expect(registry.commands.map((c) => c.name)).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);
    expect(registry.command("mid")?.name).toBe("mid");
    expect(registry.command("nope")).toBeUndefined();
  });

  it("rejects two extensions with one id, naming it", () => {
    expect(() => createRegistry([{ id: "same" }, { id: "same" }])).toThrow(
      /"same"/,
    );
  });

  it("rejects one command name in two extensions, naming the command and both extensions", () => {
    const run = () =>
      createRegistry([
        { id: "first", commands: [command("dup")] },
        { id: "second", commands: [command("dup")] },
      ]);
    expect(run).toThrow(/\/dup/);
    expect(run).toThrow(/first/);
    expect(run).toThrow(/second/);
  });

  it.each(["Help", "1go", "-x", "go_now", "go now", "", "帮助", "a/b"])(
    "rejects the command name %j",
    (name) => {
      expect(() =>
        createRegistry([{ id: "x", commands: [command(name)] }]),
      ).toThrow(/command name/i);
    },
  );

  it.each(["a", "help", "install-service", "a1-b2"])(
    "accepts the command name %j",
    (name) => {
      expect(
        createRegistry([{ id: "x", commands: [command(name)] }]).command(name),
      ).toBeDefined();
    },
  );

  it("rejects a tab kind registered twice, naming it", () => {
    expect(() =>
      createRegistry([
        { id: "a", views: [view("chat")] },
        { id: "b", views: [view("chat")] },
      ]),
    ).toThrow(/"chat"/);
  });

  it("rejects a pinned tab id registered twice, naming it", () => {
    expect(() =>
      createRegistry([
        { id: "a", pinnedTabs: [pinned("pending")] },
        { id: "b", pinnedTabs: [pinned("pending")] },
      ]),
    ).toThrow(/"pending"/);
  });

  it("completes by English name prefix only, in name order", () => {
    const registry = createRegistry([
      {
        id: "x",
        commands: [
          command("new", { summary: { en: "Start", zh: "帮助新建" } }),
          command("history"),
          command("help"),
        ],
      },
    ]);
    expect(registry.complete("h").map((c) => c.name)).toEqual([
      "help",
      "history",
    ]);
    expect(registry.complete("he").map((c) => c.name)).toEqual(["help"]);
    expect(registry.complete("").map((c) => c.name)).toEqual([
      "help",
      "history",
      "new",
    ]);
    // Text in a summary, in either language, is never a name to complete on.
    expect(registry.complete("帮")).toEqual([]);
    expect(registry.complete("Start")).toEqual([]);
    expect(registry.complete("x")).toEqual([]);
  });
});

describe("parseCommandLine", () => {
  it("splits the name from the trimmed rest", () => {
    expect(parseCommandLine("/help   config  ")).toEqual({
      name: "help",
      argText: "config",
    });
    expect(parseCommandLine("/new a b  c")).toEqual({
      name: "new",
      argText: "a b  c",
    });
    expect(parseCommandLine("/config")).toEqual({
      name: "config",
      argText: "",
    });
  });
});
