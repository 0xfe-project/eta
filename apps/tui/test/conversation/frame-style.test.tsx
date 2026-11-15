/**
 * The style of a reply's frame: the codes Ink writes for its colour, and the name cleaned of
 * control characters. A colour asked for again, or for another name, gives the same codes.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // chalk picks its colour level when it is first imported; without this there are no codes.
  globalThis.process.env.FORCE_COLOR = "1";
});

const { frameStyle } = await import(
  "../../src/ext/conversation/render/frame-style"
);

const MAGENTA = "\u001B[35m";
const BLUE = "\u001B[34m";
const FG_OFF = "\u001B[39m";
const BOLD = "\u001B[1m";
const BOLD_OFF = "\u001B[22m";

describe("frameStyle", () => {
  it("paints the border and the bold name in the colour asked for, whatever came before", () => {
    const magenta = frameStyle("Ada", "magenta");
    expect(magenta.border).toEqual({ open: MAGENTA, close: FG_OFF });
    expect(frameStyle("Ada", "magenta")).toEqual(magenta);
    const blue = frameStyle("Ada", "blue");
    expect(blue.border).toEqual({ open: BLUE, close: FG_OFF });
    expect(blue.nameStyle.open).toContain(BOLD);
    expect(blue.nameStyle.open).toContain(BLUE);
    expect(frameStyle("Ben", "magenta").border).toEqual(magenta.border);
    expect(frameStyle("Ada", "magenta").border).toEqual(magenta.border);
  });

  it("takes control characters out of the name and puts its lines on one", () => {
    expect(frameStyle("Cy\u0007", "blue").name).toBe("Cy");
    expect(frameStyle("Dee\nEve", "blue").name).toBe("Dee Eve");
    expect(frameStyle("Cy", "magenta").name).toBe("Cy");
  });

  it("keeps the terminal's own colour apart from every named one", () => {
    const own = frameStyle("Ada", undefined);
    expect(own.border).toEqual({ open: "", close: "" });
    expect(own.nameStyle).toEqual({ open: BOLD, close: BOLD_OFF });
    expect(frameStyle("Ada", "magenta").border.open).toBe(MAGENTA);
  });
});
