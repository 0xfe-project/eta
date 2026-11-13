/**
 * How each kind of transcript item other than a tool call is drawn: the plain lines, what copying
 * it gives, whether it folds, and that no line is wider than asked.
 */
import type {
  RenderedItem,
  RenderOptions,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import { renderItem } from "../../src/ext/conversation/render";
import { testConfig } from "../ui-support/config";

vi.hoisted(() => {
  // chalk picks its colour level when it is first imported; without this the lines carry no SGR.
  globalThis.process.env.FORCE_COLOR = "1";
});

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[\\d;]*m`);
const CYAN = "\u001B[36m";
const RED = "\u001B[31m";
const YELLOW = "\u001B[33m";
const GRAY = "\u001B[90m";
const MAGENTA = "\u001B[35m";
const BLUE_BRIGHT = "\u001B[94m";
const GREEN_BRIGHT = "\u001B[92m";
const FG_OFF = "\u001B[39m";
const BOLD = "\u001B[1m";
const BOLD_OFF = "\u001B[22m";
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/;

const author = (
  name: string,
  agentId = "a1",
  members: string[] = [agentId],
): TranscriptItem => ({
  kind: "author",
  key: "a",
  name,
  agentId,
  members,
});

function options(overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    width: 80,
    previewLines: 3,
    expanded: false,
    theme: testConfig().theme,
    locale: "en",
    ...overrides,
  };
}

function draw(
  item: TranscriptItem,
  overrides: Partial<RenderOptions> = {},
): RenderedItem {
  const drawn = renderItem(item, options(overrides));
  expectWellFormed(drawn, overrides.width ?? 80);
  return drawn;
}

/** What holds for every item drawn, whatever it is. */
function expectWellFormed(drawn: RenderedItem, width: number) {
  expect(drawn.plain).toHaveLength(drawn.lines.length);
  drawn.lines.forEach((line, index) => {
    expect(stripVTControlCharacters(line)).toBe(drawn.plain[index]);
  });
  for (const line of drawn.plain) {
    expect(
      stringWidth(line),
      `too wide at ${width}: ${JSON.stringify(line)}`,
    ).toBeLessThanOrEqual(width);
    expect(line).toBe(line.trimEnd());
    expect(SGR.test(line)).toBe(false);
  }
  expect(drawn.plain.length).toBeGreaterThan(0);
  expect(drawn.plain[0]).not.toBe("");
  expect(drawn.plain.at(-1)).not.toBe("");
}

function user(
  text: string,
  extra: Partial<Extract<TranscriptItem, { kind: "user" }>> = {},
): TranscriptItem {
  return {
    kind: "user",
    key: "u",
    text,
    pastes: [],
    attachments: [],
    images: [],
    ...extra,
  };
}

const CHINESE =
  "这是一段很长的中文句子，用来检查宽字符按两列计算之后折行是否正确。";
const LONG_PATH =
  "/home/someone/projects/eta/apps/tui/src/ext/conversation/render/a-very-long-file-name-without-breaks.tsx";

describe("user", () => {
  it("puts the prompt mark before the first line and indents the rest two columns", () => {
    const drawn = draw(user("first line\nsecond line"));
    expect(drawn.plain).toEqual(["› first line", "  second line"]);
    expect(drawn.source).toBe("first line\nsecond line");
    expect(drawn.foldable).toBe(false);
  });

  it("wraps a long line under the text, not under the mark", () => {
    const drawn = draw(user("alpha beta gamma delta epsilon zeta"), {
      width: 20,
    });
    expect(drawn.plain.length).toBeGreaterThan(1);
    expect(drawn.plain[0]?.startsWith("› alpha")).toBe(true);
    for (const line of drawn.plain.slice(1))
      expect(line.startsWith("  ")).toBe(true);
    expect(
      drawn.plain
        .map((line) => line.slice(2))
        .join(" ")
        .replace(/\s+/g, " "),
    ).toBe("alpha beta gamma delta epsilon zeta");
  });

  it("draws a paste as a placeholder with its line count and copies the paste whole", () => {
    const paste = "line one\nline two\nline three";
    const text = `before ${paste} after`;
    const start = text.indexOf(paste);
    const drawn = draw(user(text, { pastes: [[start, start + paste.length]] }));
    expect(drawn.plain).toEqual(["› before [Pasted text +3 lines] after"]);
    expect(drawn.plain.join("\n")).not.toContain("line two");
    expect(drawn.source).toBe(text);
  });

  it("says 1 line for a one-line paste", () => {
    const text = "x pasted y";
    const drawn = draw(user(text, { pastes: [[2, 8]] }));
    expect(drawn.plain).toEqual(["› x [Pasted text +1 line] y"]);
  });

  it("draws two pastes as two placeholders, in order", () => {
    const text = "a\nb c d\ne\nf";
    // "a\nb" and "d\ne\nf"
    const drawn = draw(
      user(text, {
        pastes: [
          [0, 3],
          [6, 11],
        ],
      }),
    );
    expect(drawn.plain).toEqual([
      "› [Pasted text +2 lines] c [Pasted text +3 lines]",
    ]);
  });

  it("lists attachments and images with their size, muted", () => {
    const drawn = draw(
      user("see these", {
        attachments: [
          {
            id: "a1",
            name: "report.pdf",
            contentType: "application/pdf",
            size: 2048,
          },
          {
            id: "a2",
            name: "video.mp4",
            contentType: "video/mp4",
            size: 5 * 1024 * 1024,
          },
        ],
        images: [
          {
            mimeType: "image/png",
            data: "",
            bytes: 1536,
            entryId: "e",
            index: 0,
          },
          { mimeType: "image/jpeg", data: "", entryId: "e", index: 1 },
        ],
      }),
    );
    expect(drawn.plain).toEqual([
      "› see these",
      "  [file] report.pdf · 2 KB",
      "  [file] video.mp4 · 5 MB",
      "  [image] image/png · 1.5 KB",
      "  [image] image/jpeg",
    ]);
    expect(drawn.lines[1]).toContain(GRAY);
    expect(drawn.lines[0]).toContain(CYAN);
  });

  it("keeps Chinese, mixed text and a long path within 20, 40 and 80 columns", () => {
    for (const width of [20, 40, 80]) {
      const drawn = draw(user(`${CHINESE} mixed 混排 text ${LONG_PATH}`), {
        width,
      });
      expect(drawn.plain.join("").replace(/\s/g, "")).toContain("混排");
    }
  });

  it("speaks Chinese when the locale is zh", () => {
    const text = "x pasted y";
    const drawn = draw(
      user(text, {
        pastes: [[2, 8]],
        attachments: [
          { id: "a", name: "a.txt", contentType: "text/plain", size: 1024 },
        ],
      }),
      { locale: "zh" },
    );
    expect(drawn.plain).toEqual([
      "› x [粘贴的文本 +1 行] y",
      "  [文件] a.txt · 1 KB",
    ]);
  });
});

describe("author", () => {
  it("draws the name after a dot, in the accent colour, bold", () => {
    const drawn = draw(author("Writer"));
    expect(drawn.plain).toEqual(["● Writer"]);
    expect(drawn.lines[0]).toContain(CYAN);
    expect(drawn.lines[0]).toContain("\u001B[1m");
    expect(drawn.foldable).toBe(false);
    expect(drawn.source).toBe("Writer");
  });

  // The test theme's agent colours are magenta, blueBright, greenBright; "a2" hashes to the first,
  // "a1" to the second (see transcript-frames.test.ts for the hash).
  it("gives the frame of its reply the colour its agent id picks, and the name bold in it", () => {
    const first = draw(author("Writer", "a2")).frame;
    expect(first).toEqual({
      name: "Writer",
      border: { open: MAGENTA, close: FG_OFF },
      nameStyle: {
        open: expect.stringContaining(MAGENTA),
        close: expect.stringContaining(FG_OFF),
      },
    });
    expect(first?.nameStyle.open).toContain(BOLD);
    expect(first?.nameStyle.close).toContain(BOLD_OFF);
    expect(draw(author("Writer", "a1")).frame?.border.open).toBe(BLUE_BRIGHT);
  });

  it("gives the same agent the same colour, whatever its name", () => {
    const one = draw(author("Writer", "a1")).frame;
    const other = draw(author("Someone else", "a1")).frame;
    expect(one?.border.open).toBe(BLUE_BRIGHT);
    expect(other?.border).toEqual(one?.border);
  });

  it("takes the colours from the theme it is given, `default` leaving the frame uncoloured", () => {
    const theme = { ...testConfig().theme, agents: ["default"] };
    const frame = draw(author("W", "a1"), { theme }).frame;
    expect(frame?.border).toEqual({ open: "", close: "" });
    expect(frame?.nameStyle).toEqual({ open: BOLD, close: BOLD_OFF });
    const yellow = draw(author("W", "a1"), {
      theme: { ...testConfig().theme, agents: ["yellow"] },
    }).frame;
    expect(yellow?.border).toEqual({ open: YELLOW, close: FG_OFF });
  });

  it("moves an agent whose colour another member of the conversation took first on to the next colour", () => {
    // "a1" and "ada" both hash to blueBright; "a1" sorts first and keeps it.
    const members = ["ada", "a1"];
    expect(draw(author("A", "a1", members)).frame?.border.open).toBe(
      BLUE_BRIGHT,
    );
    expect(draw(author("B", "ada", members)).frame?.border.open).toBe(
      GREEN_BRIGHT,
    );
    expect(draw(author("B", "ada", ["ada"])).frame?.border.open).toBe(
      BLUE_BRIGHT,
    );
  });

  it("names the frame in one line without control characters", () => {
    const frame = draw(author("Wri\u0007ter\u001B[2J\nnext", "a1")).frame;
    expect(frame?.name).not.toMatch(CONTROL_CHAR);
    expect(frame?.name).not.toContain("\n");
    expect(frame?.name).toContain("Wri");
  });

  it("is the only kind with a frame", () => {
    expect(draw(user("hi")).frame).toBeUndefined();
    expect(
      draw({ kind: "text", key: "t", text: "x", streaming: false }).frame,
    ).toBeUndefined();
  });
});

describe("thinking", () => {
  const text = "step one\nstep two\nstep three";

  it("folds to one line that counts the lines", () => {
    const drawn = draw({ kind: "thinking", key: "t", text, streaming: false });
    expect(drawn.plain).toEqual(["∴ Thinking · 3 lines"]);
    expect(drawn.lines[0]).toContain(GRAY);
    expect(drawn.foldable).toBe(true);
    expect(drawn.source).toBe(text);
  });

  it("says it is still thinking while it streams", () => {
    const drawn = draw({ kind: "thinking", key: "t", text, streaming: true });
    expect(drawn.plain).toEqual(["∴ Thinking…"]);
  });

  it("unfolds into the text, muted and indented two columns", () => {
    const drawn = draw(
      { kind: "thinking", key: "t", text, streaming: false },
      { expanded: true },
    );
    expect(drawn.plain).toEqual([
      "∴ Thinking · 3 lines",
      "  step one",
      "  step two",
      "  step three",
    ]);
    expect(drawn.lines[2]).toContain(GRAY);
    expect(drawn.foldable).toBe(true);
  });

  it("does not fold when there is nothing to show", () => {
    const drawn = draw({
      kind: "thinking",
      key: "t",
      text: "",
      streaming: true,
    });
    expect(drawn.foldable).toBe(false);
  });

  it("is in Chinese under zh", () => {
    expect(
      draw(
        { kind: "thinking", key: "t", text, streaming: false },
        { locale: "zh" },
      ).plain,
    ).toEqual(["∴ 思考 · 3 行"]);
    expect(
      draw(
        { kind: "thinking", key: "t", text, streaming: true },
        { locale: "zh" },
      ).plain,
    ).toEqual(["∴ 思考中…"]);
  });

  it("wraps unfolded Chinese within 20 columns", () => {
    const drawn = draw(
      { kind: "thinking", key: "t", text: CHINESE, streaming: false },
      { expanded: true, width: 20 },
    );
    expect(drawn.plain.length).toBeGreaterThan(3);
    for (const line of drawn.plain.slice(1))
      expect(line.startsWith("  ")).toBe(true);
  });
});

describe("outcome", () => {
  function outcome(
    kind: "stopped" | "failed" | "run-error",
    code: string | undefined,
    text: string,
  ): TranscriptItem {
    return { kind: "outcome", key: "o", outcome: kind, code, text };
  }

  it("says why a reply failed, by code, followed by the host's words", () => {
    expect(draw(outcome("failed", "run_failed", "boom")).plain).toEqual([
      "✗ The run failed: boom",
    ]);
    expect(draw(outcome("failed", "unavailable", "no model")).plain).toEqual([
      "✗ The reply could not run: no model",
    ]);
    expect(draw(outcome("failed", "gone", "left")).plain).toEqual([
      "✗ This member is no longer in the conversation: left",
    ]);
    const failed = draw(outcome("failed", "run_failed", "boom"));
    expect(failed.lines[0]).toContain(RED);
  });

  it("leaves out the host's words after a restart, which only repeat the reason", () => {
    expect(draw(outcome("failed", "restart", "host restarted")).plain).toEqual([
      "✗ The host restarted before this reply was finished",
    ]);
  });

  it("leaves out an empty text and says something general for an unknown code", () => {
    expect(draw(outcome("failed", "run_failed", "")).plain).toEqual([
      "✗ The run failed",
    ]);
    expect(draw(outcome("failed", "brand_new", "why")).plain).toEqual([
      "✗ The reply failed: why",
    ]);
    expect(draw(outcome("failed", undefined, "")).plain).toEqual([
      "✗ The reply failed",
    ]);
  });

  it("draws an error inside a run with its text, or a general line", () => {
    expect(draw(outcome("run-error", undefined, "rate limited")).plain).toEqual(
      ["✗ rate limited"],
    );
    expect(draw(outcome("run-error", undefined, "")).plain).toEqual([
      "✗ The run hit an error",
    ]);
    expect(draw(outcome("run-error", undefined, "x")).lines[0]).toContain(RED);
  });

  it("speaks Chinese under zh", () => {
    expect(
      draw(outcome("failed", "run_failed", "boom"), { locale: "zh" }).plain,
    ).toEqual(["✗ 运行失败: boom"]);
    expect(
      draw(outcome("stopped", undefined, ""), { locale: "zh" }).plain,
    ).toEqual(["■ 已停止"]);
  });
});

describe("summary", () => {
  const text = "what happened\nand then";

  it("folds to a line naming the kind of summary and its length", () => {
    const compacted = draw({
      kind: "summary",
      key: "s",
      summary: "compaction",
      text,
    });
    expect(compacted.plain).toEqual(["≡ Context compacted · 2 lines"]);
    expect(compacted.lines[0]).toContain(GRAY);
    expect(compacted.foldable).toBe(true);
    expect(compacted.source).toBe(text);
    expect(
      draw({ kind: "summary", key: "s", summary: "branch", text }).plain,
    ).toEqual(["≡ Branch summary · 2 lines"]);
  });

  it("unfolds into its text, indented two columns", () => {
    const drawn = draw(
      { kind: "summary", key: "s", summary: "compaction", text },
      { expanded: true },
    );
    expect(drawn.plain).toEqual([
      "≡ Context compacted · 2 lines",
      "  what happened",
      "  and then",
    ]);
  });

  it("speaks Chinese under zh", () => {
    expect(
      draw(
        { kind: "summary", key: "s", summary: "branch", text },
        { locale: "zh" },
      ).plain,
    ).toEqual(["≡ 分支摘要 · 2 行"]);
  });
});

describe("notice", () => {
  it("puts a dot before the text and colours it by tone", () => {
    const muted = draw({
      kind: "notice",
      key: "n",
      tone: "muted",
      text: "Nobody woke up",
    });
    expect(muted.plain).toEqual(["· Nobody woke up"]);
    expect(muted.lines[0]).toContain(GRAY);
    expect(muted.source).toBe("Nobody woke up");
    expect(muted.foldable).toBe(false);
    const warning = draw({
      kind: "notice",
      key: "n",
      tone: "warning",
      text: "Waiting on you",
    });
    expect(warning.lines[0]).toContain(YELLOW);
  });

  it("wraps under the text", () => {
    const drawn = draw(
      { kind: "notice", key: "n", tone: "muted", text: CHINESE },
      { width: 20 },
    );
    expect(drawn.plain[0]?.startsWith("· ")).toBe(true);
    for (const line of drawn.plain.slice(1))
      expect(line.startsWith("  ")).toBe(true);
  });
});

describe("colour", () => {
  it("paints with the theme it is given", () => {
    const theme = { ...testConfig().theme, accent: "magenta" };
    const drawn = draw(author("W"), { theme });
    expect(drawn.lines[0]).toContain("\u001B[35m");
    expect(drawn.lines[0]).not.toContain(CYAN);
  });

  it("leaves a `default` colour to the terminal", () => {
    const theme = { ...testConfig().theme, accent: "default" };
    const drawn = draw(author("W"), { theme });
    expect(drawn.lines[0]).not.toMatch(new RegExp(`${ESC}\\[3\\dm`));
  });
});

describe("folded pastes after wide and astral characters", () => {
  it("cuts at UTF-16 offsets when Chinese and an emoji with a skin tone come first", () => {
    const paste = "line one\nline two";
    // "中文 " is 3 code units, "👍🏽" 4 (two surrogate pairs), the space 1: the paste starts at 8.
    const text = `中文 👍🏽 ${paste} 尾`;
    expect(text.indexOf(paste)).toBe(8);
    const drawn = draw(user(text, { pastes: [[8, 8 + paste.length]] }));
    expect(drawn.plain).toEqual(["› 中文 👍🏽 [Pasted text +2 lines] 尾"]);
    expect(drawn.source).toBe(text);
  });

  it("cuts at UTF-16 offsets after a character outside the basic plane", () => {
    const paste = "a\nb\nc";
    // "𠀀" is one character in two code units: the paste starts at 3, not 2.
    const text = `𠀀:${paste}`;
    const drawn = draw(user(text, { pastes: [[3, 3 + paste.length]] }));
    expect(drawn.plain).toEqual(["› 𠀀:[Pasted text +3 lines]"]);
  });
});

describe("terminal codes in what is drawn", () => {
  const ESC_ = "\u001B";
  const payloads = [
    `${ESC_}]52;c;Zm9v\u0007`,
    `${ESC_}]52;c;Zm9v${ESC_}\\`,
    `${ESC_}c`,
    `${ESC_}[>0c`,
    `${ESC_}[2J${ESC_}[H`,
    `${ESC_}[10;10H`,
    "\u009B2J",
    `${ESC_}P1$q${ESC_}\\`,
  ];
  const evil = (words: string) => payloads.map((p) => `${words}${p}`).join("");
  const tool = (input: unknown, output: string, status = "completed") => ({
    kind: "tool" as const,
    key: "k",
    tool: {
      type: "tool" as const,
      id: "c",
      name: "bash",
      input,
      status: status as "completed",
      output,
    },
    progress: undefined,
  });
  const items: [string, TranscriptItem][] = [
    ["user", user(evil("u"))],
    ["author", author(evil("n"))],
    [
      "thinking",
      { kind: "thinking", key: "t", text: evil("th"), streaming: false },
    ],
    ["text", { kind: "text", key: "x", text: evil("md"), streaming: false }],
    [
      "code",
      {
        kind: "text",
        key: "x",
        text: `\`\`\`ts\n${evil("c")}\n\`\`\``,
        streaming: false,
      },
    ],
    [
      "table",
      {
        kind: "text",
        key: "x",
        text: `| a | b |\n|---|---|\n| ${evil("t")} | x |`,
        streaming: false,
      },
    ],
    ["command", tool({ command: evil("cmd") }, evil("out"))],
    ["write", tool({ path: "a.ts", content: evil("w") }, "")],
    ["other", tool({ query: evil("q") }, evil("o"))],
    [
      "outcome",
      {
        kind: "outcome",
        key: "o",
        outcome: "failed",
        code: "run_failed",
        text: evil("f"),
      },
    ],
    [
      "summary",
      { kind: "summary", key: "s", summary: "compaction", text: evil("s") },
    ],
    ["notice", { kind: "notice", key: "n", tone: "muted", text: evil("no") }],
  ];
  // Colour codes are all a line may carry: anything else could move the cursor, set the clipboard
  // or reset the terminal.
  const SGR_ALL = new RegExp(`${ESC_}\\[[\\d;]*m`, "g");
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

  it.each(items)("leaves only colour codes in a drawn %s", (_kind, item) => {
    for (const expanded of [false, true]) {
      const drawn = renderItem(item, options({ expanded }));
      for (const line of drawn.lines)
        expect(
          CONTROL.test(line.replace(SGR_ALL, "")),
          JSON.stringify(line),
        ).toBe(false);
      if (drawn.frame !== undefined)
        expect(CONTROL.test(drawn.frame.name), drawn.frame.name).toBe(false);
    }
  });
});
