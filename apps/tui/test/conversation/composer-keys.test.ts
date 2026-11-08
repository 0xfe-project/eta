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

  it("recalls on up from the first row or an empty input, and moves the cursor otherwise", () => {
    const sentTwo = afterSend(insertText(withHistory, "second"));
    expect(run(sentTwo, { kind: "up" }).state.text).toBe("second");
    const twoLines = insertText(sentTwo, "a\nb");
    const up = run(twoLines, { kind: "up" }).state;
    expect(up.text).toBe("a\nb");
    expect(up.cursor).toBe(1);
    expect(run(up, { kind: "up" }).state.text).toBe("second");
  });

  it("goes forward on down from the last row, back to the draft past the newest", () => {
    const draft = insertText(withHistory, "draft");
    const back = run(draft, { kind: "up" }).state;
    expect(back.text).toBe("first");
    expect(run(back, { kind: "down" }).state.text).toBe("draft");
  });

  it("only moves the cursor on down when it is not on the last row", () => {
    const recalled = run(afterSend(insertText(emptyComposer(), "x\nyz")), {
      kind: "up",
    }).state;
    const top = placeCursor(recalled, 0);
    const down = run(top, { kind: "down" }).state;
    expect(down.text).toBe("x\nyz");
    expect(down.cursor).toBe(2);
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
