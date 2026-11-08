import type { Locale, TuiConfig } from "../../src/config/types";
/** The composer on screen: real key sequences in, the frame and the callbacks out. */
import type { ComposerProps } from "../../src/ext/conversation/composer";
import type { ComposerState } from "../../src/ext/conversation/composer/state";
import type { SlashCommand } from "../../src/extensions/types";
import { EventEmitter } from "node:events";
import { Box, render as inkRender, Text } from "ink";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, emptyComposer } from "../../src/ext/conversation/composer";
import { insertText } from "../../src/ext/conversation/composer/editing";
import { composerMessages } from "../../src/ext/conversation/composer/messages";
import { InputScope } from "../../src/extensions/input-scope";
import { ConfigContext } from "../../src/extensions/react";
import { LocaleContext } from "../../src/i18n/react";
import { testConfig } from "../ui-support/config";
import { flush, KEYS, plain, realDelay, renderInk } from "../ui-support/render";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const INVERSE = "\u001B[7m";
const CSI = "\u001B[";
const SHOW_CURSOR = "\u001B[?25h";
const KEY = {
  home: "\u001B[H",
  end: "\u001B[F",
  delete: "\u001B[3~",
  ctrlA: "\u0001",
  ctrlE: "\u0005",
  ctrlK: "\u000B",
  ctrlU: "\u0015",
  altEnter: "\u001B\r",
};

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
const MEMBERS = [
  { id: "a1", name: "Alice" },
  { id: "b1", name: "Bob" },
];

interface Setup {
  initial?: ComposerState;
  width?: number;
  replying?: boolean;
  active?: boolean;
  scopeActive?: boolean;
  locale?: Locale;
  config?: TuiConfig;
  loadFiles?: () => Promise<string[]>;
  members?: { id: string; name: string }[];
}

const open: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

function setup(options: Setup = {}) {
  const calls = {
    send: vi.fn<ComposerProps["onSend"]>(),
    command: vi.fn<ComposerProps["onCommand"]>(),
    stop: vi.fn<ComposerProps["onStop"]>(),
    panel: vi.fn<ComposerProps["onPanel"]>(),
    loadFiles: vi.fn(options.loadFiles ?? (async () => [] as string[])),
  };
  const latest: { state: ComposerState } = {
    state: options.initial ?? emptyComposer(),
  };
  function Harness() {
    const [state, setState] = useState(latest.state);
    return (
      <ConfigContext value={options.config ?? testConfig()}>
        <LocaleContext value={options.locale ?? "en"}>
          <InputScope active={options.scopeActive ?? true}>
            <Composer
              state={state}
              onState={(next) => {
                latest.state = next;
                setState(next);
              }}
              width={options.width ?? 40}
              active={options.active ?? true}
              replying={options.replying ?? false}
              completeCommand={(prefix) =>
                COMMANDS.filter((c) => c.name.startsWith(prefix))
              }
              members={options.members ?? MEMBERS}
              loadFiles={calls.loadFiles}
              onSend={calls.send}
              onCommand={calls.command}
              onStop={calls.stop}
              onPanel={calls.panel}
            />
          </InputScope>
        </LocaleContext>
      </ConfigContext>
    );
  }
  const r = renderInk(<Harness />, { columns: options.width ?? 40, rows: 30 });
  open.push(r);
  // The cursor's cell at the end of a row is a drawn space; rows are compared without it.
  const lines = () =>
    plain(r)
      .split("\n")
      .map((line) => line.trimEnd());
  return { r, calls, latest, lines, text: () => plain(r) };
}

/** The frame's lines with colours, for finding the inverse cursor cell. */
const rawLines = (r: { lastFrame: () => string }) => r.lastFrame().split("\n");

describe("editing on screen", () => {
  it("shows the prompt and a muted hint while empty, in either language", async () => {
    const en = setup({ width: 60 });
    await flush();
    expect(en.lines()[0]).toBe(`› ${composerMessages.en.hint}`);
    const zh = setup({ locale: "zh", width: 60 });
    await flush();
    expect(zh.lines()[0]).toBe(`› ${composerMessages.zh.hint}`);
    expect(composerMessages.en.hint).toContain("/");
    expect(composerMessages.en.hint).toContain("@");
  });

  it("shows what is typed after the prompt with the cursor as an inverse cell", async () => {
    const s = setup();
    await s.r.type("hello");
    expect(s.lines()[0]).toBe("› hello");
    expect(rawLines(s.r)[0]).toContain(`${INVERSE} `);
    await s.r.press(KEYS.left);
    expect(rawLines(s.r)[0]).toContain(`${INVERSE}o`);
    expect(s.latest.state.cursor).toBe(4);
  });

  it("wraps Chinese at the width, indents the rows after the first, and moves up by display column", async () => {
    // Width 7 leaves 5 columns: rows 你好, 世界, 再见.
    const s = setup({ width: 7 });
    await s.r.type("你好世界再见");
    expect(s.lines().slice(0, 3)).toEqual(["› 你好", "  世界", "  再见"]);
    await s.r.press(KEYS.left);
    expect(rawLines(s.r)[2]).toContain(`${INVERSE}见`);
    await s.r.press(KEYS.up);
    expect(s.latest.state.cursor).toBe(3);
    expect(rawLines(s.r)[1]).toContain(`${INVERSE}界`);
    await s.r.press(KEYS.up);
    expect(s.latest.state.cursor).toBe(1);
    expect(rawLines(s.r)[0]).toContain(`${INVERSE}好`);
    await s.r.press(KEYS.down);
    expect(s.latest.state.cursor).toBe(3);
  });

  it("moves and deletes with Home, End, Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+K, Ctrl+W and Delete", async () => {
    const s = setup();
    await s.r.type("one two");
    await s.r.press(KEY.ctrlA);
    expect(s.latest.state.cursor).toBe(0);
    await s.r.press(KEY.ctrlE);
    expect(s.latest.state.cursor).toBe(7);
    await s.r.press(KEY.home);
    expect(s.latest.state.cursor).toBe(0);
    await s.r.press(KEY.end);
    expect(s.latest.state.cursor).toBe(7);
    await s.r.press(KEYS.ctrlW);
    expect(s.latest.state.text).toBe("one ");
    await s.r.type("x");
    await s.r.press(KEY.ctrlA);
    await s.r.press(KEY.delete);
    expect(s.latest.state.text).toBe("ne x");
    await s.r.press(KEY.ctrlK);
    expect(s.latest.state.text).toBe("");
    await s.r.type("abc");
    await s.r.press(KEY.ctrlU);
    expect(s.latest.state.text).toBe("");
    await s.r.type("ab");
    await s.r.press(KEYS.backspace);
    expect(s.lines()[0]).toBe("› a");
  });

  it("breaks the line with Alt+Enter and with a backslash before Enter, without sending", async () => {
    const s = setup();
    await s.r.type("one");
    await s.r.press(KEY.altEnter);
    await s.r.type("two\\");
    await s.r.press(KEYS.enter);
    await s.r.type("three");
    expect(s.latest.state.text).toBe("one\ntwo\nthree");
    expect(s.lines().slice(0, 3)).toEqual(["› one", "  two", "  three"]);
    expect(s.calls.send).not.toHaveBeenCalled();
  });

  it("grows up to 10 rows and then scrolls, keeping the cursor row in view", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i}`);
    const s = setup({ initial: insertText(emptyComposer(), lines.join("\n")) });
    await flush();
    const shown = s.lines().filter((line) => line.trim() !== "");
    expect(shown).toHaveLength(10);
    expect(shown.at(-1)).toBe("  line11");
    expect(s.text()).not.toContain("line1\n");
    expect(s.text()).not.toContain("line0");
    for (let i = 0; i < 11; i += 1) await s.r.press(KEYS.up);
    const top = s.lines().filter((line) => line.trim() !== "");
    expect(top).toHaveLength(10);
    expect(top[0]).toBe("› line0");
    // Up keeps the display column, so the cursor ends at the end of the shorter line0.
    expect(rawLines(s.r)[0]).toContain(`line0${INVERSE} `);
  });

  it("takes no keys while inactive or while its input scope is off", async () => {
    for (const options of [{ active: false }, { scopeActive: false }]) {
      const s = setup(options);
      await s.r.type("x");
      await s.r.press(KEYS.paste("pasted"));
      expect(s.latest.state.text).toBe("");
    }
  });
});

describe("pasting on screen", () => {
  it("inserts a short paste as written, CRLF turned into LF", async () => {
    const s = setup();
    await s.r.press(KEYS.paste("a\r\nb"));
    expect(s.latest.state.text).toBe("a\nb");
  });

  it("folds a long paste, deletes it whole with Backspace, and sends it expanded", async () => {
    const s = setup();
    const long = "1\n2\n3\n4\n5\n6";
    await s.r.type("x ");
    await s.r.press(KEYS.paste(long));
    expect(s.lines()[0]).toBe("› x [Pasted text #1 +6 lines]");
    await s.r.press(KEYS.backspace);
    expect(s.latest.state.text).toBe("x ");
    await s.r.press(KEYS.paste(long));
    await s.r.type(" y");
    await s.r.press(KEYS.enter);
    expect(s.calls.send).toHaveBeenCalledExactlyOnceWith({
      text: `x ${long} y`,
      pastes: [[2, 2 + long.length]],
      mentions: [],
      mode: "queue",
    });
  });
});

describe("completion on screen", () => {
  it("lists commands with their summaries above the input and accepts with Tab", async () => {
    const s = setup();
    await s.r.type("/he");
    const text = s.text();
    expect(text).toContain("/help  About help");
    expect(text).toContain("/hello  About hello");
    expect(text).not.toContain("/new");
    await s.r.press(KEYS.tab);
    expect(s.latest.state.text).toBe("/help ");
    expect(s.text()).not.toContain("About hello");
  });

  it("shows summaries in the reader's language", async () => {
    const s = setup({ locale: "zh" });
    await s.r.type("/ne");
    expect(s.text()).toContain("/new  关于 new");
  });

  it("runs the command on Enter when the text is exactly the highlighted /<name>", async () => {
    const s = setup();
    await s.r.type("/help");
    await s.r.press(KEYS.enter);
    expect(s.calls.command).toHaveBeenCalledExactlyOnceWith("/help");
    expect(s.latest.state.text).toBe("");
    expect(s.latest.state.history.at(-1)?.text).toBe("/help");
  });

  it("moves the highlight with down and accepts the highlighted one with Enter", async () => {
    const s = setup();
    await s.r.type("/he");
    await s.r.press(KEYS.down);
    await s.r.press(KEYS.enter);
    expect(s.latest.state.text).toBe("/hello ");
    expect(s.calls.command).not.toHaveBeenCalled();
  });

  it("completes a member and sends with their id in mentions", async () => {
    const s = setup();
    await s.r.type("hi @al");
    expect(s.text()).toContain("@Alice");
    await s.r.press(KEYS.enter);
    expect(s.latest.state.text).toBe("hi @Alice ");
    await s.r.type("go");
    await s.r.press(KEYS.enter);
    expect(s.calls.send).toHaveBeenCalledExactlyOnceWith({
      text: "hi @Alice go",
      pastes: [],
      mentions: ["a1"],
      mode: "queue",
    });
  });

  it("loads files the first time the @ menu opens, once, and lists them after members", async () => {
    const s = setup({ loadFiles: async () => ["src/app.ts", "README.md"] });
    await s.r.type("hello");
    expect(s.calls.loadFiles).not.toHaveBeenCalled();
    await s.r.type(" @");
    await flush();
    expect(s.calls.loadFiles).toHaveBeenCalledOnce();
    expect(s.text()).toContain("@everyone");
    expect(s.text()).toContain("src/app.ts");
    await s.r.type("rea");
    expect(s.text()).toContain("README.md");
    expect(s.text()).not.toContain("src/app.ts");
    await s.r.press(KEYS.tab);
    expect(s.latest.state.text).toBe("hello @README.md ");
    await s.r.type("@");
    await flush();
    expect(s.calls.loadFiles).toHaveBeenCalledOnce();
  });

  it("lists members and everyone while files load, and keeps quiet when loading fails", async () => {
    let fail: (error: Error) => void = () => {};
    const s = setup({
      loadFiles: () =>
        new Promise<string[]>((_, reject) => {
          fail = reject;
        }),
    });
    await s.r.type("@");
    expect(s.text()).toContain("@Alice");
    expect(s.text()).toContain("@everyone");
    fail(new Error("no project"));
    await flush();
    expect(s.text()).toContain("@Alice");
    expect(s.text()).toContain("@everyone");
  });

  it("closes the menu on Esc until the text changes, without stopping the reply", async () => {
    const s = setup({ replying: true });
    await s.r.type("/he");
    await s.r.press(KEYS.escape);
    expect(s.text()).not.toContain("About help");
    expect(s.calls.stop).not.toHaveBeenCalled();
    await s.r.type("l");
    expect(s.text()).toContain("About help");
  });
});

describe("sending, steering and stopping on screen", () => {
  it("sends on Enter to queue and clears the input", async () => {
    const s = setup({ width: 60 });
    await s.r.type("hello");
    await s.r.press(KEYS.enter);
    expect(s.calls.send).toHaveBeenCalledExactlyOnceWith({
      text: "hello",
      pastes: [],
      mentions: [],
      mode: "queue",
    });
    expect(s.lines()[0]).toBe(`› ${composerMessages.en.hint}`);
  });

  it("does nothing on Enter with only spaces", async () => {
    const s = setup();
    await s.r.type("   ");
    await s.r.press(KEYS.enter);
    expect(s.calls.send).not.toHaveBeenCalled();
    expect(s.calls.command).not.toHaveBeenCalled();
  });

  it("runs a / line as a command", async () => {
    const s = setup();
    await s.r.type("/new my chat");
    await s.r.press(KEYS.enter);
    expect(s.calls.command).toHaveBeenCalledExactlyOnceWith("/new my chat");
    expect(s.calls.send).not.toHaveBeenCalled();
  });

  it("recalls the last message with up, and gets back to the draft with down", async () => {
    const s = setup();
    await s.r.type("one");
    await s.r.press(KEYS.enter);
    await s.r.type("draft");
    await s.r.press(KEYS.up);
    expect(s.lines()[0]).toBe("› one");
    await s.r.press(KEYS.down);
    expect(s.lines()[0]).toBe("› draft");
  });

  it("steers with Tab while a reply runs", async () => {
    const s = setup({ replying: true });
    await s.r.type("faster");
    await s.r.press(KEYS.tab);
    expect(s.calls.send).toHaveBeenCalledExactlyOnceWith({
      text: "faster",
      pastes: [],
      mentions: [],
      mode: "steer",
    });
    expect(s.latest.state.text).toBe("");
  });

  it("stops the reply with Esc while one runs, and keeps the draft", async () => {
    const s = setup({ replying: true });
    await s.r.type("draft");
    await s.r.press(KEYS.escape);
    expect(s.calls.stop).toHaveBeenCalledOnce();
    expect(s.latest.state.text).toBe("draft");
  });

  it("does nothing on Esc with no reply", async () => {
    const s = setup();
    await s.r.type("draft");
    await s.r.press(KEYS.escape);
    expect(s.calls.stop).not.toHaveBeenCalled();
    expect(s.latest.state.text).toBe("draft");
  });

  it("opens the panel with Left from an empty input, and moves the cursor otherwise", async () => {
    const s = setup();
    await s.r.press(KEYS.left);
    expect(s.calls.panel).toHaveBeenCalledOnce();
    await s.r.type("ab");
    await s.r.press(KEYS.left);
    expect(s.calls.panel).toHaveBeenCalledOnce();
    expect(s.latest.state.cursor).toBe(1);
  });

  it("follows rebound keys for steer and newline", async () => {
    const base = testConfig();
    const config = testConfig({
      keybindings: {
        ...base.keybindings,
        "message.steer": [{ key: "s", ctrl: true, alt: false, shift: false }],
        "message.newline": [{ key: "n", ctrl: true, alt: false, shift: false }],
      },
    });
    const s = setup({ replying: true, config });
    await s.r.type("a");
    await s.r.press("\u000E");
    await s.r.type("b");
    expect(s.latest.state.text).toBe("a\nb");
    await s.r.press(KEYS.tab);
    expect(s.calls.send).not.toHaveBeenCalled();
    await s.r.press("\u0013");
    expect(s.calls.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "a\nb", mode: "steer" }),
    );
  });
});

describe("the terminal cursor", () => {
  class TtyStdout extends EventEmitter {
    readonly writes: string[] = [];
    isTTY = true;
    columns = 40;
    rows = 10;
    write = (data: string): boolean => {
      this.writes.push(data);
      return true;
    };
  }

  /** Renders the composer between two lines on a terminal-like stdout; the writes that showed the cursor. */
  async function cursorWrites(text: string): Promise<string | undefined> {
    const stdout = new TtyStdout();
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setEncoding() {},
      setRawMode() {},
      resume() {},
      pause() {},
      ref() {},
      unref() {},
      read: () => null,
    });
    const instance = inkRender(
      <ConfigContext value={testConfig()}>
        <Box flexDirection="column">
          <Text>above</Text>
          <Composer
            state={insertText(emptyComposer(), text)}
            onState={() => {}}
            width={40}
            active
            replying={false}
            completeCommand={(prefix) =>
              COMMANDS.filter((c) => c.name.startsWith(prefix))
            }
            members={[]}
            loadFiles={async () => []}
            onSend={() => {}}
            onCommand={() => {}}
            onStop={() => {}}
            onPanel={() => {}}
          />
          <Text>below</Text>
        </Box>
      </ConfigContext>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
      },
    );
    try {
      await realDelay(50);
      await flush();
      return stdout.writes.filter((w) => w.includes(SHOW_CURSOR)).at(-1);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }

  it("is put on the cursor cell, so an input method's window follows it", async () => {
    // Prompt (2) + "ab" (2) + 中 (2) = column 6, which is `CSI 7 G`. The frame is "above", the
    // input row, "below" and an empty line; the cursor goes up two rows from that last line.
    const placement = `${CSI}2A${CSI}7G${SHOW_CURSOR}`;
    expect((await cursorWrites("ab中"))?.slice(-placement.length)).toBe(
      placement,
    );
  });

  it("is put below the completion menu when the menu pushes the input down", async () => {
    // "above", /help, /hello, the input row, "below", an empty line: the input is row 3.
    const placement = `${CSI}2A${CSI}6G${SHOW_CURSOR}`;
    expect((await cursorWrites("/he"))?.slice(-placement.length)).toBe(
      placement,
    );
  });
});
