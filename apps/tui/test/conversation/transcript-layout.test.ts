/** Items laid out as one column of lines, and the cache that draws each item once. */
import type {
  RenderedItem,
  RenderItem,
  RenderOptions,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import { describe, expect, it } from "vitest";
import { layoutTranscript } from "../../src/ext/conversation/transcript/layout";
import { createRenderCache } from "../../src/ext/conversation/transcript/render-cache";
import { testConfig } from "../ui-support/config";

const text = (key: string): TranscriptItem => ({
  kind: "text",
  key,
  text: key,
  streaming: false,
});
const author = (key: string): TranscriptItem => ({
  kind: "author",
  key,
  name: key,
  agentId: key,
  members: [],
});

/** Too narrow for frames, so an author is its own line. */
const UNFRAMED = 39;

function drawn(...lines: string[]): RenderedItem {
  return {
    lines: lines.map((line) => `\u001B[1m${line}\u001B[22m`),
    plain: lines,
    source: lines.join("\n"),
    foldable: false,
  };
}

describe("layoutTranscript", () => {
  it("puts no blank line between an author and the items of its reply", () => {
    const layout = layoutTranscript(
      [text("u"), author("r1:author"), text("r1:text")],
      [drawn("u"), drawn("Ada"), drawn("t")],
      UNFRAMED,
    );
    expect(layout.plain).toEqual(["u", "", "Ada", "t"]);
    expect(layout.owner).toEqual([0, -1, 1, 2]);
    expect(layout.starts).toEqual([0, 2, 3]);
  });
});

const NO_FRAME = {
  name: "",
  border: { open: "", close: "" },
  nameStyle: { open: "", close: "" },
};

/** Every item at the transcript's width; the widths frames give are in transcript-frames.test.ts. */
const everyAtWidth = (items: readonly TranscriptItem[], width: number) =>
  items.map(() => width);

describe("createRenderCache", () => {
  const theme = testConfig().theme;
  const base = { width: 40, previewLines: 5, theme, locale: "en" as const };

  function counting() {
    const seen: { key: string; options: RenderOptions }[] = [];
    const render: RenderItem = (item, options) => {
      seen.push({ key: item.key, options });
      // `RenderItem` asks every author's drawing for a frame style; none of these is in a frame.
      return {
        ...drawn(`${item.key}@${options.width}${options.expanded ? "+" : ""}`),
        frame: NO_FRAME,
      };
    };
    return { seen, cache: createRenderCache(render, everyAtWidth) };
  }

  it("draws again only the item that changed object, fold, or any option", () => {
    const { seen, cache } = counting();
    const a = text("a");
    const b = text("b");
    cache([a, b], base, () => false);
    cache([a, { ...b }], base, () => false);
    expect(seen.map((s) => s.key)).toEqual(["a", "b", "b"]);
    cache([a], base, (key) => key === "a");
    expect(seen.at(-1)).toMatchObject({
      key: "a",
      options: { expanded: true },
    });
    const before = seen.length;
    for (const change of [
      { width: 41 },
      { previewLines: 6 },
      { theme: { ...theme } },
      { locale: "zh" as const },
    ]) {
      cache([a], { ...base, ...change }, (key) => key === "a");
    }
    expect(seen.length - before).toBe(4);
  });
});
