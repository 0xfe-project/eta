/** What each composer command does to the state, and what it asks of the screen around it. */
import type { CompletionSources } from "../../src/ext/conversation/composer/completion";
import type {
  ComposerCommand,
  KeyContext,
} from "../../src/ext/conversation/composer/keys";
import type { ComposerState } from "../../src/ext/conversation/composer/state";
import type { SlashCommand } from "../../src/extensions/types";
import { describe, expect, it } from "vitest";
import { menuOf } from "../../src/ext/conversation/composer/completion";
import { insertText } from "../../src/ext/conversation/composer/editing";
import { afterSend } from "../../src/ext/conversation/composer/history";
import {
  applyCommand,
  canSteer,
} from "../../src/ext/conversation/composer/keys";
import { pasteText } from "../../src/ext/conversation/composer/paste";
import {
  emptyComposer,
  placeCursor,
} from "../../src/ext/conversation/composer/state";

function command(name: string): SlashCommand {
  return {
    name,
    args: [],
    summary: { en: `About ${name}`, zh: `关于 ${name}` },
    examples: [],
    requiredOps: [],
    run: () => {},
  };
}

const COMMANDS = ["help", "hello", "new"].map(command);
const sources: CompletionSources = {
  completeCommand: (prefix) =>
    COMMANDS.filter((c) => c.name.startsWith(prefix)),
  members: [
    { id: "a1", name: "Alice" },
    { id: "b1", name: "Bob" },
  ],
  locale: "en",
  files: undefined,
};

const typed = (text: string, cursor = text.length): ComposerState =>
  placeCursor(insertText(emptyComposer(), text), cursor);

function context(
  state: ComposerState,
  replying = false,
  columns = 40,
): KeyContext {
  return { columns, replying, menu: menuOf(state, sources) };
}

function run(
  state: ComposerState,
  command: ComposerCommand,
  replying = false,
  columns = 40,
) {
  return applyCommand(state, command, context(state, replying, columns));
}

describe("the menu open", () => {
  it("moves the highlight with up and down, wrapping, without touching text or history", () => {
    const state = afterSend(insertText(emptyComposer(), "old"));
    const open = insertText(state, "/he");
    const down = run(open, { kind: "down" }).state;
    expect(down.menu.highlight).toBe(1);
    expect(down.text).toBe("/he");
    expect(run(down, { kind: "down" }).state.menu.highlight).toBe(0);
    const up = run(open, { kind: "up" }).state;
    expect(up.menu.highlight).toBe(1);
    expect(up.text).toBe("/he");
    expect(run(down, { kind: "enter" }).state.text).toBe("/hello ");
  });

  it("lets Enter send once Esc has closed it", () => {
    const dismissed = run(typed("hi @a"), { kind: "escape" }).state;
    const result = run(dismissed, { kind: "enter" });
    expect(result.effect).toMatchObject({ kind: "send", text: "hi @a" });
  });
});

describe("history and the cursor on up and down", () => {
  const withHistory = afterSend(insertText(emptyComposer(), "first"));
  const sentTwo = afterSend(insertText(withHistory, "second"));
  const press = (state: ComposerState, kind: "up" | "down", columns = 40) =>
    run(state, { kind }, false, columns).state;

  it("recalls the newest entry on up from an empty input, then older ones, and stays on the oldest", () => {
    const back1 = press(sentTwo, "up");
    expect(back1.text).toBe("second");
    expect(back1.cursor).toBe("second".length);
    const back2 = press(back1, "up");
    expect(back2.text).toBe("first");
    expect(press(back2, "up").text).toBe("first");
  });

  it("goes forward on down while browsing, and past the newest comes back to an empty input", () => {
    const back2 = press(press(sentTwo, "up"), "up");
    const forward = press(back2, "down");
    expect(forward.text).toBe("second");
    const home = press(forward, "down");
    expect(home.text).toBe("");
    expect(home.browsing).toBeUndefined();
    // Not browsing any more: down has nothing to go to.
    expect(press(home, "down")).toEqual(home);
  });

  it("keeps browsing through a recalled entry of several rows instead of moving between its rows", () => {
    const sent = afterSend(insertText(withHistory, "x\nyz"));
    const recalled = press(sent, "up");
    expect(recalled.text).toBe("x\nyz");
    // The cursor is on the last row; up goes to the entry before, not to the row above.
    expect(press(recalled, "up").text).toBe("first");
    // On the first row, down goes to the entry after, not to the row below.
    const top = placeCursor(recalled, 0);
    const down = press(top, "down");
    expect(down.text).toBe("");
    expect(down.browsing).toBeUndefined();
  });

  it("keeps browsing after the cursor moves inside a recalled entry without changing it", () => {
    const moved = run(press(sentTwo, "up"), { kind: "left" }).state;
    expect(moved.text).toBe("second");
    expect(press(moved, "up").text).toBe("first");
  });

  it("leaves history alone on up and down while the input holds typed text on one row", () => {
    const draft = insertText(sentTwo, "draft");
    expect(press(draft, "up")).toEqual(draft);
    expect(press(draft, "down")).toEqual(draft);
    const atStart = placeCursor(draft, 0);
    expect(press(atStart, "up")).toEqual(atStart);
  });

  it("only moves the cursor between rows of typed text, and stops at the first and last rows", () => {
    const twoLines = insertText(sentTwo, "a\nb");
    const up = press(twoLines, "up");
    expect(up.text).toBe("a\nb");
    expect(up.cursor).toBe(1);
    expect(press(up, "up")).toEqual(up);
    const down = press(up, "down");
    expect(down.text).toBe("a\nb");
    expect(down.cursor).toBe(3);
    expect(press(down, "down")).toEqual(down);
  });

  it("treats a recalled entry that was edited as typed text", () => {
    const edited = insertText(press(sentTwo, "up"), "!");
    expect(edited.text).toBe("second!");
    expect(press(edited, "up").text).toBe("second!");
    expect(press(edited, "down").text).toBe("second!");
  });

  it("starts again from the newest entry when an edited recalled entry is cleared", () => {
    const back2 = press(press(sentTwo, "up"), "up");
    const edited = insertText(back2, "x");
    const cleared = run(edited, { kind: "deleteToLineStart" }).state;
    expect(cleared.text).toBe("");
    expect(press(cleared, "up").text).toBe("second");
  });

  it("treats a recalled entry whose folded paste changed as typed text, even with the same text", () => {
    const sentPaste = afterSend(pasteText(withHistory, "1\n2\n3\n4\n5\n6"));
    const recalled = press(sentPaste, "up");
    expect(recalled.pastes).toHaveLength(1);
    const changed: ComposerState = {
      ...recalled,
      pastes: recalled.pastes.map((paste) => ({
        ...paste,
        content: `${paste.content}\n7`,
      })),
    };
    expect(changed.text).toBe(recalled.text);
    expect(press(changed, "up").text).toBe(recalled.text);
    expect(press(changed, "down").text).toBe(recalled.text);
  });

  it("does not open the menu on a recalled command or mention, and keeps browsing past it", () => {
    for (const entry of ["/he", "hi @Al"]) {
      const sent = afterSend(insertText(withHistory, entry));
      const recalled = press(sent, "up");
      expect(recalled.text).toBe(entry);
      expect(menuOf(recalled, sources)).toBeUndefined();
      expect(press(recalled, "up").text).toBe("first");
      const back = press(press(recalled, "up"), "down");
      expect(back.text).toBe(entry);
      expect(menuOf(back, sources)).toBeUndefined();
    }
  });

  it("opens the menu again once a recalled command is edited", () => {
    const recalled = press(afterSend(insertText(withHistory, "/he")), "up");
    const edited = insertText(recalled, "l");
    expect(menuOf(edited, sources)).toBeDefined();
    expect(press(edited, "down").menu.highlight).toBe(1);
  });

  it("does nothing on up with no history and an empty input", () => {
    const state = emptyComposer();
    expect(run(state, { kind: "up" }).state).toEqual(state);
  });
});

describe("steer, stop and panel", () => {
  it("does not steer without a reply, with blank text, with a command, or with the menu open", () => {
    for (const [state, replying] of [
      [typed("faster"), false],
      [typed("   "), true],
      [typed("/new x"), true],
      [typed("hi @a"), true],
    ] as const) {
      expect(canSteer(state, context(state, replying))).toBe(false);
      const result = run(state, { kind: "steer" }, replying);
      expect(result.effect).toBeUndefined();
      expect(result.state).toBe(state);
    }
  });
});
