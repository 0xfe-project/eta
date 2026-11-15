import type { Locale } from "../src/config/types";
/**
 * The completion menu shared by the home command input and the conversation composer: which
 * entries a window of so many rows shows, the lines saying how many more are above and below, and
 * how each entry is drawn.
 */
import type { MenuEntry } from "../src/ui/components/completion-menu";
import { describe, expect, it, vi } from "vitest";
import { ConfigContext } from "../src/extensions/react";
import { LocaleContext } from "../src/i18n/react";
import { CompletionMenu } from "../src/ui/components/completion-menu";
import { MENU_ROWS, menuWindow } from "../src/ui/components/menu-window";
import { testConfig } from "./ui-support/config";
import { flush, plain, renderInk } from "./ui-support/render";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

describe("menuWindow", () => {
  it("shows every entry, with no line for more, when they all fit", () => {
    for (const selected of [0, 2, 4])
      expect(menuWindow({ count: 5, selected, rows: 8 })).toEqual({
        start: 0,
        end: 5,
        above: 0,
        below: 0,
      });
    expect(menuWindow({ count: 8, selected: 7, rows: 8 })).toEqual({
      start: 0,
      end: 8,
      above: 0,
      below: 0,
    });
  });

  it("keeps the top page, with a line for what is below, while the selection is near the top", () => {
    for (const selected of [0, 1, 2, 3])
      expect(menuWindow({ count: 20, selected, rows: 8 })).toEqual({
        start: 0,
        end: 7,
        above: 0,
        below: 13,
      });
  });

  it("keeps the selection in the middle, with a line above and below, once the list scrolls", () => {
    expect(menuWindow({ count: 20, selected: 4, rows: 8 })).toEqual({
      start: 1,
      end: 7,
      above: 1,
      below: 13,
    });
    expect(menuWindow({ count: 20, selected: 10, rows: 8 })).toEqual({
      start: 7,
      end: 13,
      above: 7,
      below: 7,
    });
  });

  it("ends on the bottom page, with a line for what is above, at the last entries", () => {
    for (const selected of [17, 18, 19])
      expect(menuWindow({ count: 20, selected, rows: 8 })).toEqual({
        start: 13,
        end: 20,
        above: 13,
        below: 0,
      });
  });

  it("draws only entries, no line for more, in fewer than three rows", () => {
    expect(menuWindow({ count: 20, selected: 0, rows: 1 })).toEqual({
      start: 0,
      end: 1,
      above: 0,
      below: 0,
    });
    expect(menuWindow({ count: 20, selected: 19, rows: 1 })).toEqual({
      start: 19,
      end: 20,
      above: 0,
      below: 0,
    });
    expect(menuWindow({ count: 20, selected: 10, rows: 2 })).toEqual({
      start: 9,
      end: 11,
      above: 0,
      below: 0,
    });
  });

  it("for every list, height and selection: fills the rows it may, shows the selection, and counts what it hides", () => {
    for (let count = 1; count <= 24; count++) {
      for (let rows = 1; rows <= 10; rows++) {
        for (let selected = 0; selected < count; selected++) {
          const at = { count, selected, rows };
          const w = menuWindow(at);
          const drawn =
            w.end - w.start + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0);
          expect(drawn, JSON.stringify(at)).toBe(Math.min(rows, count));
          expect(w.start, JSON.stringify(at)).toBeLessThanOrEqual(selected);
          expect(w.end, JSON.stringify(at)).toBeGreaterThan(selected);
          expect(w.start).toBeGreaterThanOrEqual(0);
          expect(w.end).toBeLessThanOrEqual(count);
          if (rows >= 3) {
            // Every hidden entry is counted on a line.
            expect(w.above, JSON.stringify(at)).toBe(w.start);
            expect(w.below, JSON.stringify(at)).toBe(count - w.end);
          } else {
            expect(w.above).toBe(0);
            expect(w.below).toBe(0);
          }
        }
      }
    }
  });
});

function entry(name: string, detail?: string): MenuEntry {
  return { key: name, name, bold: [[0, 1]], detail };
}

function draw(
  entries: readonly MenuEntry[],
  selected: number,
  {
    rows = MENU_ROWS,
    columns = 60,
    locale = "en",
  }: { rows?: number; columns?: number; locale?: Locale } = {},
) {
  return renderInk(
    <ConfigContext value={testConfig()}>
      <LocaleContext value={locale}>
        <CompletionMenu entries={entries} selected={selected} rows={rows} />
      </LocaleContext>
    </ConfigContext>,
    { columns, rows: 30 },
  );
}

const lines = (r: { lastFrame: () => string }) =>
  plain(r)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");

const TWENTY = Array.from({ length: 20 }, (_, i) =>
  entry(`/c${String(i).padStart(2, "0")}`, `About c${i}`),
);

describe("the completion menu", () => {
  it("lines the details up in one column after the longest name", async () => {
    const r = draw(
      [
        entry("/a", "First"),
        entry("/longer", "Second"),
        entry("/mid", "Third"),
      ],
      0,
    );
    await flush();
    expect(lines(r)).toEqual([
      "› /a       First",
      "  /longer  Second",
      "  /mid     Third",
    ]);
    r.unmount();
  });

  it("measures the name column over every entry, also those outside the window, so it stays put while scrolling", async () => {
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => entry(`/s${i}`, `About s${i}`)),
      entry("/a-much-longer-name", "Long"),
    ];
    const top = draw(entries, 0, { rows: 4 });
    await flush();
    const bottom = draw(entries, 10, { rows: 4 });
    await flush();
    const detailColumn = (r: typeof top, text: string) =>
      lines(r)
        .find((line) => line.includes(text))
        ?.indexOf(text);
    expect(lines(top).join("\n")).not.toContain("/a-much-longer-name");
    expect(detailColumn(top, "About s0")).toBe(
      "  /a-much-longer-name  ".length,
    );
    expect(detailColumn(bottom, "Long")).toBe("  /a-much-longer-name  ".length);
    top.unmount();
    bottom.unmount();
  });

  it("shows a window of the entries, with a line for how many more are above and below", async () => {
    const top = draw(TWENTY, 0);
    await flush();
    expect(lines(top)).toEqual([
      "› /c00  About c0",
      ...Array.from({ length: 6 }, (_, i) => `  /c0${i + 1}  About c${i + 1}`),
      "↓ 13 more",
    ]);
    const middle = draw(TWENTY, 10);
    await flush();
    expect(lines(middle)).toEqual([
      "↑ 7 more",
      "  /c07  About c7",
      "  /c08  About c8",
      "  /c09  About c9",
      "› /c10  About c10",
      "  /c11  About c11",
      "  /c12  About c12",
      "↓ 7 more",
    ]);
    const bottom = draw(TWENTY, 19);
    await flush();
    expect(lines(bottom)[0]).toBe("↑ 13 more");
    expect(lines(bottom).at(-1)).toBe("› /c19  About c19");
    expect(lines(bottom)).toHaveLength(8);
    for (const r of [top, middle, bottom]) r.unmount();
  });

  it("says how many more in Chinese", async () => {
    const r = draw(TWENTY, 10, { locale: "zh" });
    await flush();
    expect(lines(r)[0]).toBe("↑ 还有 7 项");
    expect(lines(r).at(-1)).toBe("↓ 还有 7 项");
    r.unmount();
  });

  it("cuts a detail too long for the row with … and keeps every entry on one row", async () => {
    const long = "A summary far too long to fit beside the name in this row";
    const r = draw([entry("/one", long), entry("/two", "Short")], 0, {
      columns: 30,
    });
    await flush();
    const all = lines(r);
    expect(all).toHaveLength(2);
    expect(all[0]?.startsWith("› /one  A summary")).toBe(true);
    expect(all[0]?.endsWith("…")).toBe(true);
    expect([...(all[0] ?? "")].length).toBeLessThanOrEqual(30);
    expect(all[1]).toBe("  /two  Short");
    r.unmount();
  });

  it("draws the entries alone, without the column gap, when none has a detail", async () => {
    const r = draw([entry("@Alice"), entry("@everyone")], 1);
    await flush();
    expect(lines(r)).toEqual(["  @Alice", "› @everyone"]);
    r.unmount();
  });
});
