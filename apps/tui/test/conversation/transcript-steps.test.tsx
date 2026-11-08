/**
 * The transcript's side of a reply's folded steps: a place inside a step that folded away lands
 * on the steps line, and the toggle key picks which reply's steps to unfold. The items are drawn
 * here (not by `render/`), so every line is known.
 */
import type {
  RenderedItem,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import type { TranscriptUi } from "../../src/ext/conversation/transcript/ui";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { layoutTranscript } from "../../src/ext/conversation/transcript/layout";
import {
  lineOfPlace,
  placeIn,
} from "../../src/ext/conversation/transcript/places";
import { Transcript } from "../../src/ext/conversation/transcript/transcript";
import { INITIAL_TRANSCRIPT_UI } from "../../src/ext/conversation/transcript/ui";
import { ConfigContext } from "../../src/extensions/react";
import { LocaleContext } from "../../src/i18n/react";
import { testConfig } from "../ui-support/config";
import { flush, KEYS, renderInk } from "../ui-support/render";

/** Columns the layouts are put together at; no item here is in a frame, so any width would do. */
const WIDTH = 80;

const KEY = {
  top: "\u001B[1;5H",
  lineDown: "\u001B[1;2B",
  toggleTurn: KEYS.alt("e"),
};

type Step = Extract<TranscriptItem, { kind: "steps" }>["steps"][number];

const step = (key: string): Step => ({
  kind: "tool",
  key,
  tool: {
    type: "tool",
    id: key,
    name: "bash",
    input: { command: key },
    status: "completed",
  },
  progress: undefined,
});

const stepsItem = (
  row: string,
  children: string[] = ["t1"],
): TranscriptItem => ({
  kind: "steps",
  key: `${row}:steps`,
  steps: children.map((child) => step(`${row}:${child}`)),
  replying: false,
});

const text = (key: string): TranscriptItem => ({
  kind: "text",
  key,
  text: key,
  streaming: false,
});

function drawn(lines: string[], foldable = false): RenderedItem {
  return { lines, plain: lines, source: `source of ${lines[0]}`, foldable };
}

/** Each item drawn as its key, `lines` lines long; a steps item as one foldable line. */
function drawAll(items: TranscriptItem[], lines = 1): RenderedItem[] {
  return items.map((item) =>
    item.kind === "steps"
      ? drawn([`▸ ${item.key}`], true)
      : drawn(Array.from({ length: lines }, (_, i) => `${item.key}.${i}`)),
  );
}

describe("a place inside a step that folded away", () => {
  const folded = [stepsItem("r", ["t1", "t2"]), text("r:text")];
  const foldedLayout = layoutTranscript(
    folded,
    [drawn(["▸ steps"], true), drawn(["final 0", "final 1"])],
    WIDTH,
  );

  it("lands on the steps line, not on the reply's item nearest its old line", () => {
    const place = { key: "r:t2", offset: 2, line: 8 };
    expect(lineOfPlace(foldedLayout, place)).toBe(0);
    expect(lineOfPlace(foldedLayout, placeIn(foldedLayout, place))).toBe(0);
  });
});

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const one of mounted.splice(0)) one.unmount();
});

function mount(
  items: TranscriptItem[],
  options: {
    height?: number;
    active?: boolean;
    /** Drawings to use instead of `drawAll`'s. */
    rendered?: RenderedItem[];
  } = {},
) {
  const seen = { ui: { ...INITIAL_TRANSCRIPT_UI } as TranscriptUi };
  const rendered = options.rendered ?? drawAll(items);
  function Harness() {
    const [ui, setUi] = useState<TranscriptUi>(seen.ui);
    seen.ui = ui;
    return (
      <Transcript
        items={items}
        rendered={rendered}
        height={options.height ?? 10}
        width={40}
        isActive={options.active ?? true}
        ui={ui}
        onUi={(update) => setUi((was) => ({ ...was, ...update }))}
        hasOlder={false}
        loadingOlder={false}
        onReachTop={() => {}}
        onNotify={() => {}}
        copy={() => {}}
      />
    );
  }
  const view = renderInk(
    <ConfigContext value={testConfig()}>
      <LocaleContext value="en">
        <Harness />
      </LocaleContext>
    </ConfigContext>,
    { columns: 40, rows: (options.height ?? 10) + 2 },
  );
  mounted.push(view);
  return { ...view, seen };
}

const texts = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => text(`${prefix}${i}`));

describe("the toggle key", () => {
  it("takes the steps line on screen over a newer one below the screen", async () => {
    // At the top: a:steps 0, early0..5 on 2..12; b:steps is further down, off screen.
    const view = mount([
      stepsItem("a"),
      ...texts("early", 6),
      stepsItem("b"),
      ...texts("late", 10),
    ]);
    await flush();
    await view.press(KEY.top);
    await view.press(KEY.toggleTurn);
    expect([...view.seen.ui.expanded]).toEqual(["a:steps"]);
  });

  it("takes the reply whose unfolded steps are on screen when no steps line is", async () => {
    // a:steps 0, blank 1, a:t1 2-31 (unfolded), blank 32, b:steps 33. Three lines down from the
    // top, lines 3-11 show: only a:t1.
    const items = [
      stepsItem("a"),
      step("a:t1"),
      stepsItem("b"),
      ...texts("late", 10),
    ];
    const view = mount(items, {
      rendered: items.map((item) =>
        item.kind === "steps"
          ? drawn([`▸ ${item.key}`], true)
          : item.key === "a:t1"
            ? drawn(Array.from({ length: 30 }, (_, i) => `t1 ${i}`))
            : drawn([item.key]),
      ),
    });
    await flush();
    await view.press(KEY.top);
    for (let i = 0; i < 3; i += 1) await view.press(KEY.lineDown);
    const screen = view.lastFrame();
    expect(screen).not.toContain("▸ a:steps");
    expect(screen).not.toContain("▸ b:steps");
    expect(screen).toContain("t1 5");
    await view.press(KEY.toggleTurn);
    expect([...view.seen.ui.expanded]).toEqual(["a:steps"]);
  });

  it("does nothing without any steps", async () => {
    const view = mount(texts("only", 5));
    await flush();
    await view.press(KEY.toggleTurn);
    expect(view.seen.ui.expanded.size).toBe(0);
  });
});
