import { describe, expect, it } from "@rstest/core";
import { firstVisible, preview, railRows } from "./rail";

const numbers = (total: number, focus: number) =>
  railRows(total, focus)
    .filter((row) => row.index !== undefined)
    .map((row) => row.index);

describe("右边缘的编号", () => {
  it("一条对话时什么都不画", () => {
    expect(railRows(1, 0)).toEqual([]);
    expect(railRows(0, -1)).toEqual([]);
  });

  it("首尾永远在，中间均匀撒几个锚点", () => {
    expect(numbers(10, 0)).toEqual(expect.arrayContaining([0, 9]));
    expect(numbers(10, 0).length).toBeGreaterThanOrEqual(6);
  });

  it("当前位置附近是连续的，远处用 ⋯ 带计数", () => {
    const rows = railRows(100, 50);
    const focusRows = rows.filter(
      (row) => row.index !== undefined && row.index >= 47 && row.index <= 53,
    );
    expect(focusRows.map((row) => row.index)).toEqual([
      47, 48, 49, 50, 51, 52, 53,
    ]);
    // Somewhere between the anchors there has to be a skip row, or nothing was saved.
    expect(rows.some((row) => row.index === undefined)).toBe(true);
    const skipped = rows
      .filter((row) => row.index === undefined)
      .reduce((sum, row) => sum + row.skipped, 0);
    expect(skipped).toBeGreaterThan(0);
  });

  it("窗口越界时不越界", () => {
    // The window around the first entry reaches past both ends of four: every entry, once, no gap.
    expect(railRows(4, 0)).toEqual(
      [0, 1, 2, 3].map((index) => ({ index, skipped: 0 })),
    );
    // A focus that is not on the list is read as the last entry, not as a row past the end.
    const last = numbers(100, -1);
    expect(last.at(-1)).toBe(99);
    expect(last).toEqual(expect.arrayContaining([96, 97, 98, 99]));
  });

  it("悬停提示只取前 44 字", () => {
    expect(preview("  多行\n文本   合成一行 ")).toBe("多行 文本 合成一行");
    const long = "x".repeat(100);
    expect(preview(long)).toHaveLength(45);
    expect(preview(long).endsWith("…")).toBe(true);
  });

  it("正在看的那条是视口顶上的第一条", () => {
    expect(
      firstVisible([
        { id: "a", top: -400 },
        { id: "b", top: -10 },
        { id: "c", top: 30 },
      ]),
    ).toBe("c");
    // All scrolled past: the last one is what you are looking at.
    expect(
      firstVisible([
        { id: "a", top: -400 },
        { id: "b", top: -200 },
      ]),
    ).toBe("b");
  });
});
