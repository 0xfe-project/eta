/**
 * How a reply's folded steps are drawn: the one line in each of its three states and both
 * languages, its colours, its mark folded and unfolded, a long title cut to the width, and what
 * copying it gives.
 */
import type {
  RenderedItem,
  RenderOptions,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import type { ToolBlock } from "../../src/ext/conversation/model/run";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import { renderItem } from "../../src/ext/conversation/render";
import { testConfig } from "../ui-support/config";

vi.hoisted(() => {
  // chalk picks its colour level when it is first imported; without this the lines carry no SGR.
  globalThis.process.env.FORCE_COLOR = "1";
});

const RED = "\u001B[31m";
const GRAY = "\u001B[90m";

type StepsItem = Extract<TranscriptItem, { kind: "steps" }>;
type Step = StepsItem["steps"][number];

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
  const width = overrides.width ?? 80;
  expect(drawn.plain).toHaveLength(drawn.lines.length);
  drawn.lines.forEach((line, index) => {
    expect(stripVTControlCharacters(line)).toBe(drawn.plain[index]);
  });
  for (const line of drawn.plain)
    expect(stringWidth(line)).toBeLessThanOrEqual(width);
  return drawn;
}

function tool(
  id: string,
  status: ToolBlock["status"],
  input: unknown = { command: `run ${id}` },
  output?: string,
): Step {
  return {
    kind: "tool",
    key: `r:${id}`,
    tool: { type: "tool", id, name: "bash", input, output, status },
    progress: undefined,
  };
}

const text = (key: string, body: string): Step => ({
  kind: "text",
  key,
  text: body,
  streaming: false,
});

function steps(list: Step[], replying = false): StepsItem {
  return { kind: "steps", key: "r:steps", steps: list, replying };
}

describe("a finished reply's steps", () => {
  it("say how many tools were used, on one muted line", () => {
    const drawn = draw(
      steps([
        tool("a", "completed"),
        text("r:t", "between"),
        tool("b", "completed"),
      ]),
    );
    expect(drawn.plain).toEqual(["▸ Used 2 tools"]);
    expect(drawn.lines[0]).toContain(GRAY);
    expect(drawn.lines[0]).not.toContain(RED);
  });

  it("say one tool in the singular", () => {
    expect(draw(steps([tool("a", "completed")])).plain).toEqual([
      "▸ Used 1 tool",
    ]);
  });
});

describe("a running reply's steps", () => {
  it("name the tool call running now by its card's title, with how many so far", () => {
    const drawn = draw(
      steps(
        [tool("a", "completed"), tool("b", "running", { command: "npm test" })],
        true,
      ),
    );
    expect(drawn.plain).toEqual(["▸ Running: $ npm test (2 so far)"]);
    expect(drawn.lines[0]).toContain(GRAY);
  });

  it("cut a long title so the line fits the width and still ends with the count", () => {
    const long = `echo ${"word ".repeat(30)}`;
    const drawn = draw(steps([tool("a", "running", { command: long })], true), {
      width: 40,
    });
    expect(drawn.plain).toHaveLength(1);
    const line = drawn.plain[0]!;
    expect(line.startsWith("▸ Running: $ echo word")).toBe(true);
    expect(line.endsWith("… (1 so far)")).toBe(true);
    expect(stringWidth(line)).toBeLessThanOrEqual(40);
    expect(stringWidth(line)).toBeGreaterThan(35);
  });

  it("say it is working when its last tool call has ended", () => {
    expect(
      draw(steps([tool("a", "completed"), tool("b", "failed")], true)).plain,
    ).toEqual(["▸ Working (2 tools so far)"]);
    expect(draw(steps([tool("a", "completed")], true)).plain).toEqual([
      "▸ Working (1 tool so far)",
    ]);
  });

  it("speak Chinese", () => {
    expect(
      draw(steps([tool("b", "running", { command: "npm test" })], true), {
        locale: "zh",
      }).plain,
    ).toEqual(["▸ 正在运行：$ npm test（已调用 1 个）"]);
    expect(
      draw(steps([tool("a", "completed"), tool("b", "completed")], true), {
        locale: "zh",
      }).plain,
    ).toEqual(["▸ 正在处理（已调用 2 个工具）"]);
  });
});
