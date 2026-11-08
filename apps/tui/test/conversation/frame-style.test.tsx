/**
 * The style of a reply's frame is drawn through Ink once per colour and once per name: the codes
 * a colour turns into and the name cleaned of control characters are kept, and what is kept is
 * what drawing again would give.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // chalk picks its colour level when it is first imported; without this there are no codes.
  globalThis.process.env.FORCE_COLOR = "1";
});

const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock("ink", async (importOriginal) => {
  const ink = await importOriginal<typeof import("ink")>();
  return {
    ...ink,
    renderToString: (...args: Parameters<typeof ink.renderToString>) => {
      calls.count += 1;
      return ink.renderToString(...args);
    },
  };
});

const { frameStyle } = await import(
  "../../src/ext/conversation/render/frame-style"
);

const MAGENTA = "\u001B[35m";
const BLUE = "\u001B[34m";
const FG_OFF = "\u001B[39m";

describe("frameStyle", () => {
  it("gives the same style the second time without drawing again", () => {
    const first = frameStyle("Ada", "magenta");
    const before = calls.count;
    const second = frameStyle("Ada", "magenta");
    expect(calls.count).toBe(before);
    expect(second).toEqual(first);
    expect(first.border).toEqual({ open: MAGENTA, close: FG_OFF });
  });

  it("draws a new colour's codes once and a new name once, and keeps each apart", () => {
    frameStyle("Ben", "magenta");
    const before = calls.count;
    const blue = frameStyle("Ben", "blue");
    expect(calls.count - before).toBe(2);
    expect(blue.border).toEqual({ open: BLUE, close: FG_OFF });
    const middle = calls.count;
    const renamed = frameStyle("Cy\u0007", "blue");
    expect(calls.count - middle).toBe(1);
    expect(renamed.name).toBe("Cy");
    expect(frameStyle("Ben", "magenta").border).toEqual({
      open: MAGENTA,
      close: FG_OFF,
    });
    expect(frameStyle("Ben", "blue").border).toEqual(blue.border);
  });

  it("keeps the terminal's own colour apart from every named one", () => {
    const own = frameStyle("Ada", undefined);
    expect(own.border).toEqual({ open: "", close: "" });
    expect(own.nameStyle).toEqual({ open: "\u001B[1m", close: "\u001B[22m" });
    expect(frameStyle("Ada", "magenta").border.open).toBe(MAGENTA);
  });
});
