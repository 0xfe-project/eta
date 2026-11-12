/**
 * Parts of a layer with a cursor, in a frame: they keep fitting when the terminal changes size,
 * and Enter or Space while the cursor is out of view only brings it back.
 */
import type { ReactNode } from "react";
import type { ListLine } from "../src/ext/pending/scroll-list";
import { Box, Text, useWindowSize } from "ink";
import { describe, expect, it } from "vitest";
import { CheckList } from "../src/ext/kit/check-list";
import { PickList } from "../src/ext/kit/pick-list";
import { ScrollList } from "../src/ext/pending/scroll-list";
import { ChoiceList } from "../src/ui/components/choice-list";
import { LayerFrame } from "../src/ui/components/layer-frame";
import {
  LayerAreaContext,
  useActionGate,
} from "../src/ui/components/layer-space";
import { useRowCursor } from "../src/ui/components/row-cursor";
import { RowList } from "../src/ui/components/row-list";
import { LIST_KEYS } from "./ext-support/keys";
import { renderKit } from "./ext-support/render-kit";
import { flush, KEYS, plain } from "./ui-support/render";

/** A layer area as tall as the terminal, as the shell gives one. */
function Sized({ children }: { children: ReactNode }) {
  const { rows } = useWindowSize();
  return (
    <LayerAreaContext value>
      <Box flexDirection="column" height={rows}>
        {children}
      </Box>
    </LayerAreaContext>
  );
}

/** The frame's rows, border and padding off. */
function rows(r: { lastFrame: () => string }): string[] {
  return plain(r)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .replace(/^[│┌└]/, "")
        .replace(/[│┐┘]$/, "")
        .trim(),
    );
}

/** The marked row, past its marker; undefined when it is out of view. */
function markedRow(r: { lastFrame: () => string }): string | undefined {
  return rows(r)
    .find((row) => row.startsWith("›"))
    ?.slice(1)
    .trim();
}

/** The frame's two hint rows (under the title, above the footer) are empty: nothing scrolled. */
function expectFrameFits(r: { lastFrame: () => string }) {
  const all = rows(r);
  expect(all[2], plain(r)).toBe("");
  expect(all.at(-3), plain(r)).toBe("");
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await flush();
}

const ITEMS = Array.from({ length: 30 }, (_, i) => ({
  key: `k${i}`,
  label: `Item ${String(i).padStart(2, "0")}`,
}));

describe("a layer open while the terminal gets shorter", () => {
  it("a scroll list draws as many lines as the new room holds, and keeps the keys", async () => {
    const picks: string[] = [];
    const lines: ListLine[] = ITEMS.map(({ key, label }) => ({
      kind: "choice",
      key,
      content: <Text>{label}</Text>,
    }));
    const r = renderKit(
      <Sized>
        <LayerFrame title="Pending" footer="Esc">
          <ScrollList
            lines={lines}
            onPick={(key) => picks.push(key)}
            onEscape={() => {}}
          />
        </LayerFrame>
      </Sized>,
      { columns: 40, rows: 20 },
    );
    await settle();
    expectFrameFits(r);
    r.stdout.resize(40, 10);
    await settle();
    expectFrameFits(r);
    expect(plain(r).trimEnd().split("\n").length).toBeLessThanOrEqual(10);
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    expect(markedRow(r)).toBe("Item 02");
    expectFrameFits(r);
    await r.press(LIST_KEYS.pageDown);
    const marked = markedRow(r);
    expect(marked).toBeDefined();
    expectFrameFits(r);
    await r.press(KEYS.enter);
    expect(picks).toEqual([ITEMS.find((item) => item.label === marked)?.key]);
  });

  it("a pick list under other lines takes the new room and keeps the keys", async () => {
    const picks: string[] = [];
    const r = renderKit(
      <Sized>
        <LayerFrame title="Pick" footer="Esc">
          <Text>Intro</Text>
          <PickList
            items={ITEMS}
            empty="none"
            onPick={(key) => picks.push(key)}
          />
        </LayerFrame>
      </Sized>,
      { columns: 40, rows: 24 },
    );
    await settle();
    expectFrameFits(r);
    r.stdout.resize(40, 12);
    await settle();
    expectFrameFits(r);
    expect(rows(r)).toContain("Intro");
    await r.press(KEYS.down);
    expect(markedRow(r)).toBe("Item 01");
    expect(rows(r)).toContain("Intro");
    await r.press(KEYS.enter);
    expect(picks).toEqual(["k1"]);
  });
});

describe("enter on a row list whose cursor PageUp or PageDown took out of view", () => {
  it("brings the cursor back and chooses nothing; the next Enter chooses", async () => {
    const chosen: number[] = [];
    function Layer() {
      const gate = useActionGate();
      const at = useRowCursor(
        5,
        (i) => chosen.push(i),
        () => {},
        gate,
      );
      return (
        <LayerFrame title="New" footer="Esc">
          <Text>Heading</Text>
          <RowList
            rows={Array.from({ length: 5 }, (_, i) => ({
              key: `r${i}`,
              label: `Row ${i}`,
            }))}
            cursor={at}
            height={5}
            gate={gate}
          />
          {["one", "two", "three", "four"].map((line) => (
            <Text key={line}>{`After ${line}`}</Text>
          ))}
        </LayerFrame>
      );
    }
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={9}>
          <Layer />
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 9 },
    );
    await settle();
    expect(markedRow(r)).toBe("Row 0");
    await r.press(LIST_KEYS.pageDown);
    expect(markedRow(r)).toBeUndefined();
    await r.press(KEYS.enter);
    expect(chosen).toEqual([]);
    expect(markedRow(r)).toBe("Row 0");
    await r.press(KEYS.enter);
    expect(chosen).toEqual([0]);
  });
});

describe("a cursor taller than the view", () => {
  it("counts as in view when its first row shows: Enter chooses", async () => {
    const chosen: number[] = [];
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={7}>
          <LayerFrame title="Pick" footer="Esc">
            <ChoiceList
              choices={[
                { label: "config.json", hint: "settings" },
                { label: "mcp.json", hint: "servers" },
              ]}
              onChoose={(i) => chosen.push(i)}
            />
          </LayerFrame>
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 7 },
    );
    await settle();
    expect(markedRow(r)).toBe("1. config.json");
    await r.press(KEYS.enter);
    expect(chosen).toEqual([0]);
  });
});

describe("space while PageUp or PageDown took the cursor out of view", () => {
  it("in a check list: brings the cursor back and ticks nothing; the next Space ticks", async () => {
    const r = renderKit(
      <LayerAreaContext value>
        <Box flexDirection="column" height={10}>
          <LayerFrame title="Tick" footer="Esc">
            {["one", "two", "three", "four"].map((line) => (
              <Text key={line}>{`Text ${line}`}</Text>
            ))}
            <CheckList items={ITEMS} empty="none" onConfirm={() => {}} />
          </LayerFrame>
        </Box>
      </LayerAreaContext>,
      { columns: 40, rows: 10 },
    );
    await settle();
    expect(markedRow(r)).toBe("[ ] Item 00");
    await r.press(LIST_KEYS.pageUp);
    expect(markedRow(r)).toBeUndefined();
    await r.press(LIST_KEYS.space);
    expect(markedRow(r)).toBe("[ ] Item 00");
    await r.press(LIST_KEYS.space);
    expect(markedRow(r)).toBe("[x] Item 00");
  });
});

/** Lines of the frame from its top border to its bottom border. */
function frameHeight(r: { lastFrame: () => string }): number {
  const lines = plain(r).split("\n");
  return (
    lines.findIndex((line) => line.startsWith("└")) -
    lines.findIndex((line) => line.startsWith("┌")) +
    1
  );
}

describe("a cursor in a frame as tall as its content", () => {
  it("is followed once the terminal gets too short, and the frame fits it again when it gets taller", async () => {
    const choices = Array.from({ length: 8 }, (_, i) => ({
      label: `Choice ${i}`,
    }));
    const chosen: number[] = [];
    const r = renderKit(
      <Sized>
        <LayerFrame title="Pick" footer="Esc">
          <ChoiceList choices={choices} onChoose={(i) => chosen.push(i)} />
        </LayerFrame>
      </Sized>,
      { columns: 40, rows: 24 },
    );
    await settle();
    expect(frameHeight(r)).toBe(8 + 6);
    expectFrameFits(r);

    r.stdout.resize(40, 10);
    await settle();
    expect(frameHeight(r)).toBe(10);
    for (let i = 0; i < 7; i += 1) await r.press(KEYS.down);
    expect(markedRow(r)).toBe("8. Choice 7");
    await r.press(LIST_KEYS.pageUp);
    expect(markedRow(r)).toBeUndefined();
    await r.press(KEYS.enter);
    expect(chosen).toEqual([]);
    expect(markedRow(r)).toBe("8. Choice 7");

    r.stdout.resize(40, 24);
    await settle();
    expect(frameHeight(r)).toBe(8 + 6);
    expectFrameFits(r);
    expect(markedRow(r)).toBe("8. Choice 7");
    expect(rows(r)).toContain("1. Choice 0");
    await r.press(KEYS.enter);
    expect(chosen).toEqual([7]);
  });
});
