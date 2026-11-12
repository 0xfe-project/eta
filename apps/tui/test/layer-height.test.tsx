/**
 * Layers in the whole interface on small terminals: the frame Ink writes is never taller than the
 * terminal, and `/help` scrolls through every command, each row drawn whole.
 */
import type { RenderedApp } from "./ui-support/app";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { extensions } from "../src/extensions.gen";
import { LIST_KEYS } from "./ext-support/keys";
import { renderApp } from "./ui-support/app";
import { flush, KEYS } from "./ui-support/render";

const open: RenderedApp[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

async function app(columns: number, rows: number): Promise<RenderedApp> {
  const r = await renderApp({ columns, rows });
  open.push(r);
  return r;
}

const TITLE = "Commands";
const FOOTER = "Esc to close";
const HINT = /^[↑↓] \d+ more$/;

/** The lines of a frame Ink wrote, without colours; a trailing newline is not a line. */
function frameLines(frame: string): string[] {
  return stripVTControlCharacters(frame).replace(/\n$/, "").split("\n");
}

/**
 * The rows of the help layer in a frame, between its title and its footer, border and padding
 * taken off; undefined for a frame without the layer.
 */
function helpRows(frame: string): string[] | undefined {
  const lines = frameLines(frame).map((line) =>
    line.replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd(),
  );
  const title = lines.indexOf(TITLE);
  const footer = lines.indexOf(FOOTER);
  if (title === -1 || footer === -1 || footer < title) return undefined;
  return lines.slice(title + 1, footer);
}

async function openHelp(r: RenderedApp): Promise<number> {
  await r.type("/help");
  const before = r.stdout.frames.length;
  await r.press(KEYS.enter);
  await flush();
  return before;
}

/** The help layer's rows on a terminal tall enough that nothing scrolls. */
async function wholeHelp(columns: number): Promise<string[]> {
  const r = await app(columns, 150);
  await openHelp(r);
  const rows = helpRows(r.lastFrame());
  if (rows === undefined) throw new Error("the help layer did not open");
  r.unmount();
  return rows.filter((row) => row !== "");
}

const COMMAND_NAMES = extensions.flatMap((extension) =>
  (extension.commands ?? []).map((command) => command.name),
);

describe.each([
  { columns: 80, rows: 33 },
  { columns: 60, rows: 20 },
])("/help on a $columns×$rows terminal", ({ columns, rows }) => {
  async function scrollThrough(key: string) {
    const whole = await wholeHelp(columns);
    // The reference has a row for every command; it is what each scrolled row is held to.
    for (const name of COMMAND_NAMES)
      expect(
        whole.some((row) => row.startsWith(`/${name} `) || row === `/${name}`),
        `/${name} in the unscrolled list`,
      ).toBe(true);

    const r = await app(columns, rows);
    const from = await openHelp(r);
    for (let step = 0; step < 80; step += 1) {
      const shown = helpRows(r.lastFrame());
      if (shown !== undefined && !shown.some((row) => row.startsWith("↓")))
        break;
      await r.press(key);
    }
    const frames = r.stdout.frames.slice(from);
    const seen = new Set<string>();
    let layerFrames = 0;
    for (const frame of frames) {
      expect(frameLines(frame).length).toBeLessThanOrEqual(rows);
      const shown = helpRows(frame);
      if (shown === undefined) continue;
      layerFrames += 1;
      for (const row of shown) {
        if (row === "" || HINT.test(row)) continue;
        expect(whole, `a row drawn whole: "${row}"`).toContain(row);
        seen.add(row);
      }
    }
    expect(layerFrames).toBeGreaterThan(1);
    for (const row of whole) expect(seen, `"${row}" shown`).toContain(row);
    // The last frame is at the end: the last row of the list shows and nothing is below.
    const last = helpRows(r.lastFrame()) ?? [];
    expect(last.filter((row) => row !== "").at(-1)).toBe(whole.at(-1));
    expect(last.some((row) => row.startsWith("↓"))).toBe(false);
  }

  it("shows every row whole at least once while PageDown goes to the end", async () => {
    await scrollThrough(LIST_KEYS.pageDown);
  });

  it("shows every row whole at least once while ↓ goes to the end", async () => {
    await scrollThrough(KEYS.down);
  });

  it("says how many rows are below when it opens, and none above", async () => {
    const r = await app(columns, rows);
    await openHelp(r);
    const shown = helpRows(r.lastFrame()) ?? [];
    expect(shown[0]).toBe("");
    expect(shown.at(-1)).toMatch(/^↓ \d+ more$/);
  });
});

/**
 * The layer frame's border in a frame Ink wrote: the line of its top and bottom, and whether the
 * lines between its bottom and the status line are blank.
 */
function layerBox(frame: string): {
  top: number;
  height: number;
  blankBelow: boolean;
} {
  const lines = frameLines(frame);
  const top = lines.findIndex((line) => line.startsWith("┌"));
  const bottom = lines.findIndex((line) => line.startsWith("└"));
  const status = lines.findIndex((line) => line.startsWith("Connected"));
  return {
    top,
    height: bottom - top + 1,
    blankBelow: lines
      .slice(bottom + 1, status)
      .every((line) => line.trim() === ""),
  };
}

/**
 * The help layer shows its rows and nothing more: the empty hint row under the title, every row
 * of `whole` in order (the list has empty rows of its own between its parts), its last row right
 * above the empty hint row over the footer.
 */
function expectEveryRowAndNoMore(shown: string[] | undefined, whole: string[]) {
  expect(shown?.[0]).toBe("");
  expect(shown?.at(-1)).toBe("");
  expect(shown?.at(-2)).toBe(whole.at(-1));
  expect(shown?.filter((row) => row !== "")).toEqual(whole);
}

/** Rows of the main area: the terminal less the status line and the tab bar under it. */
function mainArea(rows: number): number {
  return rows - 2;
}

describe("/help as tall as its content", () => {
  it.each([
    { rows: 33, fits: false },
    { rows: 80, fits: true },
  ])(
    "on 80×$rows every frame Ink writes after Enter shows the layer with its rows",
    async ({ rows, fits }) => {
      const whole = await wholeHelp(80);
      const r = await app(80, rows);
      const from = await openHelp(r);
      await flush();
      let layerFrames = 0;
      for (const [index, frame] of r.stdout.frames.slice(from).entries()) {
        const lines = frameLines(frame).map((line) =>
          line.replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd(),
        );
        const title = lines.indexOf(TITLE);
        if (title === -1) continue;
        layerFrames += 1;
        expect(frameLines(frame).length).toBeLessThanOrEqual(rows);
        // The rows under the title, down to the footer, or to the status line in a frame the
        // room cut off before the frame started scrolling.
        const end = lines.findIndex(
          (line, at) =>
            at > title && (line === FOOTER || line.startsWith("Connected")),
        );
        const under = lines.slice(title + 1, end);
        expect(
          under.find((row) => row !== ""),
          `frame ${index}`,
        ).toBe(whole[0]);
        for (const row of under)
          if (row !== "" && !HINT.test(row) && !row.startsWith("└"))
            expect(whole, `frame ${index}: "${row}" drawn whole`).toContain(
              row,
            );
        if (fits) expectEveryRowAndNoMore(helpRows(frame), whole);
      }
      expect(layerFrames).toBeGreaterThan(0);
      if (!fits) expect(layerBox(r.lastFrame()).height).toBe(mainArea(rows));
    },
  );

  it("on 80×24 it does not fit: the frame takes the main area and scrolls", async () => {
    const r = await app(80, 24);
    await openHelp(r);
    const box = layerBox(r.lastFrame());
    expect(box.top).toBe(0);
    expect(box.height).toBe(mainArea(24));
    expect(helpRows(r.lastFrame())?.at(-1)).toMatch(HINT);
  });

  it("on a terminal tall enough it is as tall as its rows, blank under it", async () => {
    const whole = await wholeHelp(80);
    const r = await app(80, 150);
    await openHelp(r);
    const box = layerBox(r.lastFrame());
    expect(box.top).toBe(0);
    expectEveryRowAndNoMore(helpRows(r.lastFrame()), whole);
    expect(box.height).toBeLessThan(mainArea(150));
    expect(box.blankBelow).toBe(true);
  });

  it("starts scrolling when the terminal gets shorter, and fits again when it gets taller", async () => {
    const whole = await wholeHelp(80);
    const tall = whole.length + 30;
    const r = await app(80, tall);
    await openHelp(r);
    const fits = layerBox(r.lastFrame()).height;
    expect(fits).toBeLessThan(mainArea(tall));

    r.stdout.resize(80, 24);
    await flush();
    await flush();
    expect(layerBox(r.lastFrame()).height).toBe(mainArea(24));
    expect(helpRows(r.lastFrame())?.at(-1)).toMatch(HINT);
    expect(frameLines(r.lastFrame()).length).toBeLessThanOrEqual(24);
    await r.press(LIST_KEYS.pageDown);
    expect(helpRows(r.lastFrame())?.[0]).toMatch(/^↑ \d+ more$/);

    r.stdout.resize(80, tall);
    await flush();
    await flush();
    const box = layerBox(r.lastFrame());
    expect(box.height).toBe(fits);
    expect(box.blankBelow).toBe(true);
    expectEveryRowAndNoMore(helpRows(r.lastFrame()), whole);
  });
});

describe("the frame Ink writes", () => {
  it("is never taller than the terminal on the home screen and with /help at 40×12", async () => {
    const r = await app(40, 12);
    const from = await openHelp(r);
    for (let i = 0; i < 10; i += 1) await r.press(LIST_KEYS.pageDown);
    for (const frame of r.stdout.frames.slice(Math.max(0, from - 5)))
      expect(frameLines(frame).length).toBeLessThanOrEqual(12);
  });
});
