/**
 * Layers with a list, on a real host and a small terminal: the list takes the rows the layer has
 * left, so the layer fits the terminal without scrolling as a whole, and Ink's frame is never
 * taller than the terminal.
 */
import type { AgentView, ProjectView } from "@eta/client-contracts";
import type { HostRendered } from "../ext-support/render-with-host";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import manage from "../../src/ext/manage";
import model from "../../src/ext/model";
import { createSetupExtension } from "../../src/ext/setup";
import { renderWithHost } from "../ext-support/render-with-host";
import { tempDir } from "../support/temp";
import { KEYS } from "../ui-support/render";

const COLUMNS = 60;
const ROWS = 16;

function frameLines(frame: string): string[] {
  return stripVTControlCharacters(frame).replace(/\n$/, "").split("\n");
}

/** The layer's rows from its title down to the row above its bottom border, border and padding off. */
function layerRows(screen: string): string[] {
  const lines = screen.split("\n");
  const top = lines.findIndex((line) => line.startsWith("┌"));
  const bottom = lines.findIndex((line) => line.startsWith("└"));
  if (top === -1 || bottom === -1) return [];
  return lines
    .slice(top + 1, bottom)
    .map((line) => line.replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd());
}

/**
 * Every frame since `from` fits the terminal; the last one shows the whole layer, both borders,
 * with the frame's own hint rows (under the title, above the footer or the bottom border) empty:
 * nothing of the layer is scrolled out of view.
 */
function expectFits(
  r: HostRendered,
  from: number,
  { footer, rows = ROWS }: { footer: boolean; rows?: number },
): string[] {
  for (const frame of r.stdout.frames.slice(from))
    expect(frameLines(frame).length).toBeLessThanOrEqual(rows);
  const layer = layerRows(r.screen());
  expect(layer.length, r.screen()).toBeGreaterThan(3);
  expect(layer[1], r.screen()).toBe("");
  expect(layer.at(footer ? -2 : -1), r.screen()).toBe("");
  return layer;
}

describe(`layers with a list on a ${COLUMNS}×${ROWS} terminal`, () => {
  it("/model: the agent list shows as many agents as fit, in order, with how many more below", async () => {
    const r = await renderWithHost({
      extensions: [model],
      columns: COLUMNS,
      rows: ROWS,
    });
    const names = Array.from(
      { length: 30 },
      (_, i) => `Agent ${String(i + 1).padStart(2, "0")}`,
    );
    for (const name of names)
      await r.wire.call<{ agent: AgentView }>("agents", "create", {
        name,
        model: "fake:fake-model",
      });
    const from = r.stdout.frames.length;
    await r.runCommand("/model");
    await r.waitFor(/Agent 01/);
    await r.settle();
    const rows = expectFits(r, from, { footer: true });
    const shown = rows.flatMap((row) => /Agent (\d\d)/.exec(row)?.[1] ?? []);
    expect(shown.length).toBeGreaterThanOrEqual(3);
    // In order from the first, each whole, then a row for the rest.
    expect(shown).toEqual(names.slice(0, shown.length).map((n) => n.slice(6)));
    expect(rows).toContain(`↓ ${30 - shown.length} more`);
    // Moving to the end keeps it fitting.
    for (let i = 0; i < 30; i += 1) await r.press(KEYS.down);
    await r.settle();
    const end = expectFits(r, from, { footer: true });
    expect(end.some((row) => row.includes("Agent 30"))).toBe(true);
  });
});

describe("the first-time setup on terminals too short for it", () => {
  const SETUP_TITLE = "Setup · Esc to leave";
  const HINT_ROW = /^[↑↓] \d+ more$/;

  /** The setup layer's rows under its title, border and padding off; undefined without the layer. */
  function setupRows(frame: string): string[] | undefined {
    const lines = frameLines(frame);
    const title = lines.findIndex((line) => line.includes(SETUP_TITLE));
    if (title === -1) return undefined;
    const bottom = lines.findIndex(
      (line, index) => index > title && line.startsWith("└"),
    );
    if (bottom === -1) return undefined;
    return lines
      .slice(title + 1, bottom)
      .map((line) => line.replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd());
  }

  /** The row the list's cursor is on, or undefined when it is out of view. */
  function cursorRow(rows: readonly string[]): string | undefined {
    return rows.find((row) => row.startsWith("› "));
  }

  async function openSetup(rows: number) {
    const r = await renderWithHost({
      extensions: [createSetupExtension()],
      columns: COLUMNS,
      rows,
    });
    await r.waitFor(SETUP_TITLE);
    await r.settle();
    return r;
  }

  it.each([10, 12, 16])(
    "at 60×%i: every row whole in every frame, every line outside the list reachable with PageUp and PageDown, the cursor in view",
    async (rows) => {
      const tall = await openSetup(40);
      const whole = (setupRows(tall.lastFrame()) ?? []).filter(
        (row) => row !== "",
      );
      await tall.close();
      const outsideList = whole.filter(
        (row) => !row.startsWith("› ") && !row.startsWith("  "),
      );
      expect(outsideList.length).toBeGreaterThan(4);

      const r = await openSetup(rows);
      expect(cursorRow(setupRows(r.lastFrame()) ?? [])).toBeDefined();
      for (let i = 0; i < 20; i += 1) {
        await r.press("\u001B[6~");
        const shown = setupRows(r.lastFrame()) ?? [];
        if (!shown.some((row) => /^↓ \d+ more$/.test(row))) break;
      }
      for (let i = 0; i < 20; i += 1) {
        await r.press("\u001B[5~");
        const shown = setupRows(r.lastFrame()) ?? [];
        if (!shown.some((row) => /^↑ \d+ more$/.test(row))) break;
      }
      await r.press(KEYS.down);
      await r.settle();
      expect(cursorRow(setupRows(r.lastFrame()) ?? [])).toBeDefined();

      const seen = new Set<string>();
      for (const frame of r.stdout.frames) {
        expect(frameLines(frame).length).toBeLessThanOrEqual(rows);
        const shown = setupRows(frame);
        if (shown === undefined) continue;
        for (const row of shown) {
          if (row === "" || HINT_ROW.test(row)) continue;
          expect(whole, `a row drawn whole: "${row}"`).toContain(row);
          seen.add(row);
        }
      }
      for (const row of outsideList)
        expect(seen, `"${row}" reachable`).toContain(row);
    },
    90_000,
  );
});

describe("/new on a 60×9 terminal", () => {
  it("enter after PageUp took the cursor out of view brings it back and starts nothing; the next Enter starts", async () => {
    const r = await renderWithHost({
      extensions: [manage],
      columns: 60,
      rows: 9,
    });
    await r.wire.call<{ agent: AgentView }>("agents", "create", {
      name: "Ada",
      model: "fake:fake-model",
    });
    for (let i = 0; i < 3; i += 1)
      await r.wire.call<{ project: ProjectView }>("projects", "create", {
        path: await tempDir(`eta-tui-gate-${i}-`),
      });
    await r.runCommand("/new");
    await r.waitFor("New conversation");
    await r.settle();
    expect(r.screen()).toMatch(/› /);
    await r.press("\u001B[5~");
    await r.settle();
    expect(r.screen()).not.toMatch(/› /);
    await r.press(KEYS.enter);
    await r.settle();
    expect(r.screen()).not.toContain("Started");
    expect(r.screen()).toMatch(/› /);
    await r.press(KEYS.enter);
    await r.waitFor("Started");
  });
});
