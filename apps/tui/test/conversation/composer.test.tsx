import type { Locale, TuiConfig } from "../../src/config/types";
/** The composer on screen: real key sequences in, the frame and the callbacks out. */
import type { ComposerProps } from "../../src/ext/conversation/composer";
import type { ComposerState } from "../../src/ext/conversation/composer/state";
import type { SlashCommand } from "../../src/extensions/types";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { Box, render as inkRender, Text, useWindowSize } from "ink";
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
import { hasBackground } from "../ui-support/sgr";

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
  /** The commands completeCommand finds by prefix; `COMMANDS` when absent. */
  commands?: SlashCommand[];
  /**
   * Rows of a column the composer sits at the bottom of, under a part that takes what is left, as
   * in the conversation view; the composer alone on the screen when absent.
   */
  height?: number | "screen";
  /** The terminal's rows; 30 when absent. With `height: "screen"` the column is this tall. */
  rows?: number;
  /** One-row lines over the composer inside `height`, as the view draws held messages there. */
  linesAbove?: string[];
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
  const commands = options.commands ?? COMMANDS;
  function Harness() {
    const [state, setState] = useState(latest.state);
    const screenRows = useWindowSize().rows;
    const composer = (
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
                commands.filter((c) => c.name.startsWith(prefix))
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
    if (options.height === undefined) return composer;
    return (
      <Box
        flexDirection="column"
        height={options.height === "screen" ? screenRows : options.height}
      >
        <Box flexGrow={1} flexBasis={0} />
        {(options.linesAbove ?? []).map((line) => (
          <Text key={line} wrap="truncate-end">
            {line}
          </Text>
        ))}
        {composer}
      </Box>
    );
  }
  const r = renderInk(<Harness />, {
    columns: options.width ?? 40,
    rows: options.rows ?? 30,
  });
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

/** A line of nothing but `─`; with `width`, exactly that many. */
function isRule(line: string, width?: number): boolean {
  return (
    /^─+$/.test(line) && (width === undefined || [...line].length === width)
  );
}

describe("editing on screen", () => {
  it("shows the prompt and a muted hint while empty, in either language", async () => {
    const en = setup({ width: 60 });
    await flush();
    expect(en.lines()[1]).toBe(`› ${composerMessages.en.hint}`);
    const zh = setup({ locale: "zh", width: 60 });
    await flush();
    expect(zh.lines()[1]).toBe(`› ${composerMessages.zh.hint}`);
    expect(composerMessages.en.hint).toContain("/");
    expect(composerMessages.en.hint).toContain("@");
  });

  it("shows what is typed after the prompt with the cursor as an inverse cell", async () => {
    const s = setup();
    await s.r.type("hello");
    expect(s.lines()[1]).toBe("› hello");
    expect(rawLines(s.r)[1]).toContain(`${INVERSE} `);
    await s.r.press(KEYS.left);
    expect(rawLines(s.r)[1]).toContain(`${INVERSE}o`);
    expect(s.latest.state.cursor).toBe(4);
  });

  it("wraps Chinese at the width, indents the rows after the first, and moves up by display column", async () => {
    // Width 7 leaves 5 columns: rows 你好, 世界, 再见.
    const s = setup({ width: 7 });
    await s.r.type("你好世界再见");
    expect(s.lines().slice(1, 4)).toEqual(["› 你好", "  世界", "  再见"]);
    await s.r.press(KEYS.left);
    expect(rawLines(s.r)[3]).toContain(`${INVERSE}见`);
    await s.r.press(KEYS.up);
    expect(s.latest.state.cursor).toBe(3);
    expect(rawLines(s.r)[2]).toContain(`${INVERSE}界`);
    await s.r.press(KEYS.up);
    expect(s.latest.state.cursor).toBe(1);
    expect(rawLines(s.r)[1]).toContain(`${INVERSE}好`);
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
    expect(s.lines()[1]).toBe("› a");
  });

  it("breaks the line with Alt+Enter and with a backslash before Enter, without sending", async () => {
    const s = setup();
    await s.r.type("one");
    await s.r.press(KEY.altEnter);
    await s.r.type("two\\");
    await s.r.press(KEYS.enter);
    await s.r.type("three");
    expect(s.latest.state.text).toBe("one\ntwo\nthree");
    expect(s.lines().slice(1, 4)).toEqual(["› one", "  two", "  three"]);
    expect(s.calls.send).not.toHaveBeenCalled();
  });

  it("grows up to 10 rows and then scrolls, keeping the cursor row in view", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i}`);
    const s = setup({ initial: insertText(emptyComposer(), lines.join("\n")) });
    await flush();
    const shown = s
      .lines()
      .filter((line) => line.trim() !== "" && !isRule(line));
    expect(shown).toHaveLength(10);
    expect(shown.at(-1)).toBe("  line11");
    expect(s.text()).not.toContain("line1\n");
    expect(s.text()).not.toContain("line0");
    for (let i = 0; i < 11; i += 1) await s.r.press(KEYS.up);
    const top = s.lines().filter((line) => line.trim() !== "" && !isRule(line));
    expect(top).toHaveLength(10);
    expect(top[0]).toBe("› line0");
    // Up keeps the display column, so the cursor ends at the end of the shorter line0.
    expect(rawLines(s.r)[1]).toContain(`line0${INVERSE} `);
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
    expect(s.lines()[1]).toBe("› x [Pasted text #1 +6 lines]");
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
  it("lists commands with their summaries and accepts with Tab", async () => {
    const s = setup();
    await s.r.type("/he");
    const text = s.text();
    expect(text).toContain("/help   About help");
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
    expect(s.lines()[1]).toBe(`› ${composerMessages.en.hint}`);
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

  it("recalls the last message with up from an empty input, and leaves typed text alone", async () => {
    const s = setup();
    await s.r.type("one");
    await s.r.press(KEYS.enter);
    await s.r.press(KEYS.up);
    expect(s.text()).toContain("› one");
    await s.r.press(KEYS.down);
    expect(s.latest.state.text).toBe("");
    await s.r.type("draft");
    await s.r.press(KEYS.up);
    expect(s.latest.state.text).toBe("draft");
    expect(s.text()).not.toContain("one");
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
    // upper rule, the input row, the lower rule, "below" and an empty line; the cursor goes up
    // three rows from that last line.
    const placement = `${CSI}3A${CSI}7G${SHOW_CURSOR}`;
    expect((await cursorWrites("ab中"))?.slice(-placement.length)).toBe(
      placement,
    );
  });

  it("stays on the input row when the completion menu opens under it", async () => {
    // "above", the upper rule, the input row, the lower rule, /help, /hello, "below", an empty
    // line: the input is row 2, five rows up from the last.
    const placement = `${CSI}5A${CSI}6G${SHOW_CURSOR}`;
    expect((await cursorWrites("/he"))?.slice(-placement.length)).toBe(
      placement,
    );
  });
});

describe("the input's rules", () => {
  it("puts a rule as wide as the composer above and below the input", async () => {
    for (const width of [40, 25]) {
      const s = setup({ width });
      await s.r.type("hello");
      const all = s.lines();
      expect(isRule(all[0] ?? "", width)).toBe(true);
      expect(all[1]).toBe("› hello");
      expect(isRule(all[2] ?? "", width)).toBe(true);
    }
  });

  it("holds every input row between the two rules", async () => {
    const s = setup({ width: 7 });
    await s.r.type("你好世界再见");
    await s.r.press(KEY.altEnter);
    await s.r.type("x");
    const all = s.lines();
    expect(isRule(all[0] ?? "", 7)).toBe(true);
    expect(all.slice(1, 5)).toEqual(["› 你好", "  世界", "  再见", "  x"]);
    expect(isRule(all[5] ?? "", 7)).toBe(true);
  });

  it("lists the completion menu under the lower rule", async () => {
    const s = setup();
    await s.r.type("/he");
    const all = s.lines();
    expect(isRule(all[0] ?? "", 40)).toBe(true);
    expect(all[1]).toBe("› /he");
    expect(isRule(all[2] ?? "", 40)).toBe(true);
    expect(all[3]).toContain("/help   About help");
    expect(all[4]).toContain("/hello  About hello");
  });
});

describe("completion rows", () => {
  it("marks the highlighted row with › and the others with two spaces, following the highlight", async () => {
    const s = setup();
    await s.r.type("/he");
    expect(s.lines()[3]).toBe("› /help   About help");
    expect(s.lines()[4]).toBe("  /hello  About hello");
    await s.r.press(KEYS.down);
    expect(s.lines()[3]).toBe("  /help   About help");
    expect(s.lines()[4]).toBe("› /hello  About hello");
  });

  it("draws no background or reverse video on any menu row", async () => {
    const s = setup({ config: testConfig() });
    await s.r.type("/he");
    const raw = rawLines(s.r);
    for (const line of [raw[3] ?? "", raw[4] ?? ""]) {
      expect(stripVTControlCharacters(line)).toContain("/hel");
      expect(hasBackground(line)).toBe(false);
    }
    await s.r.press(KEYS.down);
    const moved = rawLines(s.r);
    for (const line of [moved[3] ?? "", moved[4] ?? ""])
      expect(hasBackground(line)).toBe(false);
  });
});

/** Twenty commands /c00 … /c19: more than the menu's eight rows. */
const TWENTY = Array.from({ length: 20 }, (_, i) =>
  command(`c${String(i).padStart(2, "0")}`),
);

/** The menu's lines: those under the input's lower rule, empty ones left out. */
function menuLines(lines: readonly string[]): string[] {
  const upper = lines.findIndex((line) => isRule(line));
  const lower = lines.findIndex((line, i) => i > upper && isRule(line));
  return lines.slice(lower + 1).filter((line) => line !== "");
}

/** Presses `key` `times` times. */
async function pressTimes(
  r: { press: (data: string) => Promise<void> },
  key: string,
  times: number,
) {
  for (let i = 0; i < times; i++) await r.press(key);
}

describe("a completion menu longer than its window", () => {
  it("lists every match, eight rows at a time, with a line for how many more are below", async () => {
    const s = setup({ commands: TWENTY });
    await s.r.type("/");
    const menu = menuLines(s.lines());
    expect(menu).toHaveLength(8);
    expect(menu[0]).toBe("› /c00  About c00");
    expect(menu[6]).toBe("  /c06  About c06");
    expect(menu[7]).toBe("↓ 13 more");
  });

  it("goes down to the last match, which shows and is selected, and stops listing more below", async () => {
    const s = setup({ commands: TWENTY });
    await s.r.type("/");
    await pressTimes(s.r, KEYS.down, 19);
    const menu = menuLines(s.lines());
    expect(menu).toHaveLength(8);
    expect(menu.at(-1)).toBe("› /c19  About c19");
    expect(menu[0]).toBe("↑ 13 more");
    expect(menu.join("\n")).not.toContain("↓");
  });

  it("has no row that stays last: the last row follows the selection down", async () => {
    const s = setup({ commands: TWENTY });
    await s.r.type("/");
    const lastRows = new Set<string>();
    for (let i = 0; i < 19; i++) {
      await s.r.press(KEYS.down);
      lastRows.add(menuLines(s.lines()).at(-1) ?? "");
    }
    expect(lastRows.size).toBeGreaterThan(5);
    expect(menuLines(s.lines()).at(-1)).toContain("/c19");
  });

  it("wraps from the first match to the last with up, and back with down", async () => {
    const s = setup({ commands: TWENTY });
    await s.r.type("/");
    await s.r.press(KEYS.up);
    expect(menuLines(s.lines()).at(-1)).toBe("› /c19  About c19");
    await s.r.press(KEYS.down);
    expect(menuLines(s.lines())[0]).toBe("› /c00  About c00");
  });

  it("completes with Tab a match the window scrolled to", async () => {
    const s = setup({ commands: TWENTY });
    await s.r.type("/");
    await pressTimes(s.r, KEYS.down, 12);
    expect(menuLines(s.lines())).toContain("› /c12  About c12");
    await s.r.press(KEYS.tab);
    expect(s.latest.state.text).toBe("/c12 ");
  });

  it("goes back to the first match and the top of the list when the typed text changes", async () => {
    const s = setup({ commands: TWENTY });
    await s.r.type("/");
    await pressTimes(s.r, KEYS.down, 12);
    await s.r.type("c");
    const menu = menuLines(s.lines());
    expect(menu[0]).toBe("› /c00  About c00");
    expect(menu.join("\n")).not.toContain("↑");
    await s.r.press(KEYS.tab);
    expect(s.latest.state.text).toBe("/c00 ");
  });

  it("filters by what is typed after the /", async () => {
    const s = setup({ commands: TWENTY });
    await s.r.type("/c1");
    const menu = menuLines(s.lines());
    expect(menu).toHaveLength(8);
    expect(menu[0]).toBe("› /c10  About c10");
    expect(menu.at(-1)).toBe("↓ 3 more");
    expect(menu.join("\n")).not.toContain("/c09");
  });

  it("says how many more in Chinese, beside the Chinese summaries", async () => {
    const s = setup({ commands: TWENTY, locale: "zh" });
    await s.r.type("/");
    await pressTimes(s.r, KEYS.down, 10);
    const menu = menuLines(s.lines());
    expect(menu[0]).toBe("↑ 还有 7 项");
    expect(menu).toContain("› /c10  关于 c10");
    expect(menu.at(-1)).toBe("↓ 还有 7 项");
  });

  it("shrinks to the rows left on a short screen, keeping the input whole and the selection in view", async () => {
    // Eight rows: the two rules and the input row leave five for the menu.
    const s = setup({ commands: TWENTY, height: 8 });
    await s.r.type("/");
    let all = s.lines();
    expect(all).toHaveLength(8);
    expect(isRule(all[0] ?? "", 40)).toBe(true);
    expect(all[1]).toBe("› /");
    expect(isRule(all[2] ?? "", 40)).toBe(true);
    expect(all.slice(3)).toEqual([
      "› /c00  About c00",
      "  /c01  About c01",
      "  /c02  About c02",
      "  /c03  About c03",
      "↓ 16 more",
    ]);
    await pressTimes(s.r, KEYS.down, 9);
    all = s.lines();
    expect(all).toHaveLength(8);
    expect(all[1]).toBe("› /");
    expect(all.slice(3)).toContain("› /c09  About c09");
    await pressTimes(s.r, KEYS.down, 10);
    expect(s.lines().at(-1)).toBe("› /c19  About c19");
  });

  it("keeps one row for the menu on a screen with no more room, the selection in it", async () => {
    // Four rows: the input takes three, the menu one.
    const s = setup({ commands: TWENTY, height: 4 });
    await s.r.type("/");
    expect(s.lines()).toEqual([
      "─".repeat(40),
      "› /",
      "─".repeat(40),
      "› /c00  About c00",
    ]);
    await pressTimes(s.r, KEYS.down, 5);
    expect(s.lines()[1]).toBe("› /");
    expect(s.lines()[3]).toBe("› /c05  About c05");
  });

  it("keeps the input and one menu row over the lines above it when the screen is that short", async () => {
    const s = setup({
      commands: TWENTY,
      height: 4,
      linesAbove: ["held one", "held two"],
    });
    await s.r.type("/");
    expect(s.lines()).toEqual([
      "─".repeat(40),
      "› /",
      "─".repeat(40),
      "› /c00  About c00",
    ]);
  });

  it("grows back to eight rows when the room comes back", async () => {
    // Seven rows: the input takes three, the menu the other four.
    const s = setup({ commands: TWENTY, height: "screen", rows: 7 });
    await s.r.type("/");
    expect(menuLines(s.lines())).toHaveLength(4);
    s.r.stdout.resize(40, 30);
    await flush();
    await flush();
    const menu = menuLines(s.lines());
    expect(menu).toHaveLength(8);
    expect(menu[0]).toBe("› /c00  About c00");
    expect(menu[7]).toBe("↓ 13 more");
  });

  it("scrolls the @ menu in the same window on a short screen", async () => {
    const members = Array.from({ length: 7 }, (_, i) => ({
      id: `m${i}`,
      name: `Member${i}`,
    }));
    const s = setup({ members, height: 7 });
    await s.r.type("@");
    await flush();
    // Seven members and everyone: eight entries in four rows.
    let menu = s.lines().slice(3);
    expect(menu).toEqual([
      "› @Member0",
      "  @Member1",
      "  @Member2",
      "↓ 5 more",
    ]);
    await pressTimes(s.r, KEYS.down, 7);
    menu = s.lines().slice(3);
    expect(menu[0]).toBe("↑ 5 more");
    expect(menu.at(-1)).toBe("› @everyone");
    await s.r.press(KEYS.tab);
    expect(s.latest.state.text).toBe("@everyone ");
  });
});
