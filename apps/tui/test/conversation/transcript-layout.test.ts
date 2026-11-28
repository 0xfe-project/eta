/** The cache that draws each item once, and again only when it or how it is drawn changes. */
import type {
  RenderedItem,
  RenderItem,
  RenderOptions,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import { describe, expect, it } from "vitest";
import { createRenderCache } from "../../src/ext/conversation/transcript/render-cache";
import { testConfig } from "../ui-support/config";

const text = (key: string): TranscriptItem => ({
  kind: "text",
  key,
  text: key,
  streaming: false,
});
function drawn(...lines: string[]): RenderedItem {
  return {
    lines: lines.map((line) => `\u001B[1m${line}\u001B[22m`),
    plain: lines,
    source: lines.join("\n"),
    foldable: false,
  };
}

const NO_FRAME = {
  name: "",
  border: { open: "", close: "" },
  nameStyle: { open: "", close: "" },
};

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
    return { seen, cache: createRenderCache(render) };
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
