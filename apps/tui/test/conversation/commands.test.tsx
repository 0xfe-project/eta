/**
 * Which conversation `/open` picks from what was typed, what the commands say about themselves,
 * and the keys section `/help` gains. The commands' calls to the host are in `commands-host.test.tsx`.
 */
import type { ConversationSummary } from "@eta/client-contracts";
import type { KeyBinding } from "../../src/config/types";
import type { ShellContext } from "../../src/extensions/types";
import { afterEach, describe, expect, it } from "vitest";
import { conversationCommands } from "../../src/ext/conversation/commands";
import { matchConversation } from "../../src/ext/conversation/open-match";
import { renderApp } from "../ui-support/app";
import { testConfig } from "../ui-support/config";
import { fakeWire } from "../ui-support/fake-wire";
import { KEYS, plain } from "../ui-support/render";

const open: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

function summary(id: string, name: string, archived = false) {
  return { id, name, archived } as ConversationSummary;
}

const LIST = [
  summary("aaaa1111", "Release notes"),
  summary("bbbb2222", "Release planning"),
  summary("cccc3333", "Bug triage"),
  summary("dddd4444", "release"),
  summary("eeee5555", "Old archive", true),
  summary("ffff6666", "Weekly sync"),
  summary("gggg7777", "Old release notes"),
  summary("hhhh8888", "Debug log"),
];

describe("/open picks a conversation", () => {
  it("by its exact id first, even when a name would match too", () => {
    const list = [summary("notes", "Something"), summary("x1", "notes")];
    expect(matchConversation(list, "notes")).toEqual({
      kind: "found",
      conversation: list[0],
    });
  });

  it("by a name equal to it, case aside, before any prefix", () => {
    expect(matchConversation(LIST, "RELEASE")).toEqual({
      kind: "found",
      conversation: LIST[3],
    });
  });

  it("by the one name that starts with it, over the names that only hold it", () => {
    expect(matchConversation(LIST, "bug")).toEqual({
      kind: "found",
      conversation: LIST[2],
    });
  });

  it("by the one name that holds it, when no name starts with it", () => {
    expect(matchConversation(LIST, "sync")).toEqual({
      kind: "found",
      conversation: LIST[5],
    });
  });

  it("archived conversations too", () => {
    expect(matchConversation(LIST, "old ar")).toEqual({
      kind: "found",
      conversation: LIST[4],
    });
  });

  it("asks for more when several names start with it, without trying the names that hold it", () => {
    expect(matchConversation(LIST, "release ")).toEqual({
      kind: "ambiguous",
      names: ["Release notes", "Release planning"],
    });
  });

  it("asks for more when several names hold it", () => {
    expect(matchConversation(LIST, "e")).toEqual({
      kind: "ambiguous",
      names: [
        "Release notes",
        "Release planning",
        "Bug triage",
        "release",
        "Old archive",
      ],
    });
  });

  it("names at most five of them", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      summary(`id${i}`, `Topic ${i}`),
    );
    const match = matchConversation(many, "topic");
    expect(match.kind).toBe("ambiguous");
    expect(match.kind === "ambiguous" && match.names).toEqual([
      "Topic 0",
      "Topic 1",
      "Topic 2",
      "Topic 3",
      "Topic 4",
    ]);
  });

  it("finds nothing when nothing matches", () => {
    expect(matchConversation(LIST, "zebra")).toEqual({ kind: "none" });
  });

  it("tells conversations of the same name apart by their id, which /open takes", () => {
    const list = [
      summary("1234567890ab", "Plan"),
      summary("abcdefghijkl", "Plan"),
      summary("zzzz", "Planning"),
    ];
    expect(matchConversation(list, "plan")).toEqual({
      kind: "ambiguous",
      names: ["Plan (1234567890ab)", "Plan (abcdefghijkl)"],
    });
    expect(matchConversation(list, "pla")).toEqual({
      kind: "ambiguous",
      names: ["Plan (1234567890ab)", "Plan (abcdefghijkl)", "Planning"],
    });
    // What the list shows in the brackets is what opens that one.
    expect(matchConversation(list, "abcdefghijkl")).toMatchObject({
      kind: "found",
      conversation: { id: "abcdefghijkl" },
    });
  });

  it("counts names that differ only in case as the same", () => {
    const list = [summary("11112222x", "Notes"), summary("33334444y", "notes")];
    expect(matchConversation(list, "note")).toEqual({
      kind: "ambiguous",
      names: ["Notes (11112222x)", "notes (33334444y)"],
    });
  });

  it("marks a listed name whose twin is past the five listed", () => {
    const many = [
      ...Array.from({ length: 5 }, (_, i) =>
        summary(`id${i}-long`, `Topic ${i}`),
      ),
      summary("twin-of-0", "Topic 0"),
    ];
    const match = matchConversation(many, "topic");
    expect(match.kind === "ambiguous" && match.names).toEqual([
      "Topic 0 (id0-long)",
      "Topic 1",
      "Topic 2",
      "Topic 3",
      "Topic 4",
    ]);
  });
});

describe("with another kind of tab in front", () => {
  it.each([
    ["queue", "hello"],
    ["steer", "hello"],
    ["stop", ""],
  ])(
    "/%s says to open a conversation first and asks nothing of the host",
    async (name, argText) => {
      const wire = fakeWire({
        ops: ["conversations.send", "conversations.stop"],
      });
      const notices: string[] = [];
      const ctx = {
        wire,
        locale: "en",
        activeTab: { kind: "chat", id: "x" },
        notify: (text: string) => notices.push(text),
      } as unknown as ShellContext;
      const command = conversationCommands.find((c) => c.name === name)!;
      await command.run(ctx, argText);
      expect(notices).toEqual(["Open a conversation first"]);
      expect(wire.calls).toEqual([]);
    },
  );
});

describe("/help lists the conversation keys", () => {
  const bind = (key: string, mods: Partial<KeyBinding> = {}): KeyBinding => ({
    key,
    ctrl: false,
    alt: false,
    shift: false,
    ...mods,
  });

  async function helpLines(config = testConfig()) {
    const r = await renderApp({ config, columns: 100, rows: 50 });
    open.push(r);
    await r.type("/help");
    await r.press(KEYS.enter);
    return plain(r)
      .split("\n")
      .map((line) => line.replace(/^│ /, "").replace(/\s*│\s*$/, ""));
  }

  it("one kind a line, with the keys the settings bind, after the commands", async () => {
    const lines = await helpLines();
    const at = (prefix: string) =>
      lines.findIndex((line) => line.startsWith(prefix));
    expect(lines[at("Scroll")]).toMatch(
      /^Scroll\s+pageup pagedown shift\+up shift\+down ctrl\+home ctrl\+end$/,
    );
    expect(lines[at("Search")]).toMatch(/^Search\s+ctrl\+f$/);
    expect(lines[at("Select lines")]).toMatch(/^Select lines\s+alt\+v$/);
    expect(lines[at("Expand all")]).toMatch(/^Expand all\s+ctrl\+o$/);
    expect(lines[at("New line")]).toMatch(/^New line\s+alt\+enter$/);
    expect(lines[at("Steer")]).toMatch(/^Steer\s+tab$/);
    expect(lines[at("Stop the reply")]).toMatch(/^Stop the reply\s+escape$/);
    expect(
      lines.some((line) =>
        line.includes(
          "To select with the mouse, use your terminal's own selection",
        ),
      ),
    ).toBe(true);
    expect(at("Scroll")).toBeGreaterThan(at("/help"));
    expect(at("Scroll")).toBeGreaterThan(at("/stop"));
  });

  it("follows rebinding", async () => {
    const config = testConfig();
    const lines = await helpLines({
      ...config,
      keybindings: {
        ...config.keybindings,
        "transcript.search": [bind("g", { ctrl: true, shift: true })],
        "reply.stop": [bind("x", { ctrl: true })],
      },
    });
    expect(lines.find((l) => l.startsWith("Search"))).toMatch(
      /^Search\s+ctrl\+shift\+g$/,
    );
    expect(lines.find((l) => l.startsWith("Stop the reply"))).toMatch(
      /^Stop the reply\s+ctrl\+x$/,
    );
  });

  it("says it in Chinese when the settings say so", async () => {
    const lines = await helpLines(testConfig({ locale: "zh" }));
    expect(lines.some((l) => /^滚动\s+pageup/.test(l))).toBe(true);
    expect(
      lines.some((l) =>
        l.includes(
          "要用鼠标选取，直接用终端自己的选取（不少终端要按住 Shift 拖动）",
        ),
      ),
    ).toBe(true);
  });
});
