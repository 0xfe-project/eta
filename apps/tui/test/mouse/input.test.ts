/**
 * The mouse sequences taken out of stdin before Ink reads it: which sequences go, which wheel turns
 * they carry, what reaches Ink untouched, and how a sequence split across reads is still found.
 */
import type { WheelDirection } from "../../src/ui/mouse/wheel";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMouseSequenceFilter,
  filterMouseInput,
  UNFINISHED_SEQUENCE_WAIT_MS,
} from "../../src/ui/mouse/input";

const ESC = "\u001B";
const sgr = (button: number, final: "M" | "m" = "M", x = 10, y = 5) =>
  `${ESC}[<${button};${x};${y}${final}`;
const x10 = (button: number, x = 10, y = 5) =>
  `${ESC}[M${String.fromCharCode(button + 32, x + 32, y + 32)}`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Pushes every piece through one filter; returns what reached Ink and the wheel turns, in order. */
function through(...pieces: string[]) {
  const filter = createMouseSequenceFilter();
  let keys = "";
  const wheel: WheelDirection[] = [];
  for (const piece of pieces) {
    const out = filter.push(piece);
    keys += out.keys;
    wheel.push(...out.wheel);
  }
  return { keys, wheel, holding: filter.holding, filter };
}

describe("mouse reports in SGR coordinates", () => {
  it.each([
    ["a release after a wheel button", sgr(64, "m")],
    ["coordinates past 223", sgr(0, "M", 300, 250)],
  ])("takes out %s and reports nothing", (_, sequence) => {
    expect(through(sequence)).toMatchObject({ keys: "", wheel: [] });
  });

  it("lets through a sequence that only starts like one", () => {
    expect(through(`${ESC}[<x`)).toMatchObject({
      keys: `${ESC}[<x`,
      wheel: [],
      holding: false,
    });
    expect(through(`${ESC}[<64;1;1X`)).toMatchObject({
      keys: `${ESC}[<64;1;1X`,
      wheel: [],
    });
  });
});

describe("a sequence split across reads", () => {
  it("is found when it comes one character at a time, among keys", () => {
    const stream = `x${sgr(65)}y${x10(64)}z${ESC}[B${sgr(0)}w`;
    const result = through(...stream);
    expect(result.keys).toBe(`xyz${ESC}[Bw`);
    expect(result.wheel).toEqual(["down", "up"]);
    expect(result.holding).toBe(false);
  });

  it("joins a held ESC to the key that follows it", () => {
    expect(through(ESC, "x")).toMatchObject({
      keys: `${ESC}x`,
      holding: false,
    });
    expect(through(ESC, "[A")).toMatchObject({
      keys: `${ESC}[A`,
      holding: false,
    });
  });

  it.each([
    ["Alt+x", `${ESC}x`],
    ["an arrow", `${ESC}[A`],
    ["Shift+Up", `${ESC}[1;2A`],
    ["Insert", `${ESC}[2~`],
    ["F12", `${ESC}[24~`],
    ["a kitty keyboard reply", `${ESC}[?1u`],
  ])("lets %s through at once", (_, sequence) => {
    const result = through(sequence);
    expect(result.keys).toBe(sequence);
    expect(result.holding).toBe(false);
    expect(result.wheel).toEqual([]);
  });
});

describe("bracketed paste", () => {
  it("lets everything inside a paste through, mouse-like bytes too", () => {
    const paste = `${PASTE_START}a${sgr(64)}b${x10(65)}c${PASTE_END}`;
    expect(through(paste)).toMatchObject({ keys: paste, wheel: [] });
  });

  it("follows a paste whose markers are split across reads", () => {
    const result = through(
      `${ESC}[20`,
      `0~x${ESC}[<64;1`,
      ";1M",
      `${ESC}[2`,
      `01~z${sgr(65)}`,
    );
    expect(result.keys).toBe(
      `${PASTE_START}x${sgr(64, "M", 1, 1)}${PASTE_END}z`,
    );
    expect(result.wheel).toEqual(["down"]);
  });

  it("filters again after the paste ends", () => {
    const result = through(`${PASTE_START}p${PASTE_END}${sgr(64)}q`);
    expect(result).toMatchObject({
      keys: `${PASTE_START}p${PASTE_END}q`,
      wheel: ["up"],
    });
  });
});

/** A stdin double that hands out each write once through `read`, and records what it is asked. */
class SourceStdin extends EventEmitter {
  isTTY = true;
  readonly calls: string[] = [];
  readonly reads: number[] = [];
  private pending: (string | Buffer)[] = [];
  write(data: string | Buffer): void {
    this.pending.push(data);
    this.emit("readable");
  }

  read = (): string | Buffer | null => {
    this.reads.push(this.pending.length);
    return this.pending.shift() ?? null;
  };

  setRawMode = (mode: boolean) => {
    this.calls.push(`setRawMode:${mode}`);
    return this;
  };

  setEncoding = (encoding: string) => {
    this.calls.push(`setEncoding:${encoding}`);
    return this;
  };

  ref = () => {
    this.calls.push("ref");
    return this;
  };

  unref = () => {
    this.calls.push("unref");
    return this;
  };
}

/** Reads the filtered stdin the way Ink does: on `readable`, `read` until null. */
function inkReader(filtered: ReturnType<typeof filterMouseInput>) {
  const chunks: string[] = [];
  const listener = () => {
    for (let chunk = filtered.read(); chunk !== null; chunk = filtered.read())
      chunks.push(chunk);
  };
  filtered.addListener("readable", listener);
  return {
    chunks,
    text: () => chunks.join(""),
    stop: () => filtered.removeListener("readable", listener),
  };
}

describe("the stdin Ink is given", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const source = new SourceStdin();
    const wheel: WheelDirection[] = [];
    const filtered = filterMouseInput(source, (direction) =>
      wheel.push(direction),
    );
    return { source, wheel, filtered };
  }

  it("passes raw mode, encoding, ref and unref on to the real stdin", () => {
    const { source, filtered } = setup();
    filtered.setRawMode(true);
    filtered.setEncoding("utf8");
    filtered.ref();
    filtered.unref();
    filtered.setRawMode(false);
    expect(source.calls).toEqual([
      "setRawMode:true",
      "setEncoding:utf8",
      "ref",
      "unref",
      "setRawMode:false",
    ]);
  });

  it("reads the real stdin only while Ink listens, so a program on the terminal gets the keys", () => {
    const { source, filtered } = setup();
    source.write("before");
    expect(source.reads).toEqual([]);
    const ink = inkReader(filtered);
    source.write("x");
    expect(ink.text()).toContain("x");
    ink.stop();
    const readsWhenStopped = source.reads.length;
    source.write("for the editor");
    expect(source.reads.length).toBe(readsWhenStopped);
  });

  it(`gives Ink a lone ESC after ${UNFINISHED_SEQUENCE_WAIT_MS} ms, not before`, () => {
    const { source, filtered } = setup();
    const ink = inkReader(filtered);
    source.write(ESC);
    expect(ink.text()).toBe("");
    vi.advanceTimersByTime(UNFINISHED_SEQUENCE_WAIT_MS - 1);
    expect(ink.text()).toBe("");
    vi.advanceTimersByTime(1);
    expect(ink.text()).toBe(ESC);
  });

  it("finds a sequence whose rest comes within the wait, and leaves nothing behind", () => {
    const { source, wheel, filtered } = setup();
    const ink = inkReader(filtered);
    source.write(`${ESC}[<6`);
    vi.advanceTimersByTime(UNFINISHED_SEQUENCE_WAIT_MS - 1);
    source.write("4;3;3M");
    vi.advanceTimersByTime(UNFINISHED_SEQUENCE_WAIT_MS * 3);
    expect(ink.text()).toBe("");
    expect(wheel).toEqual(["up"]);
  });

  it("finds the end of a paste whose end marker comes in two reads far apart", () => {
    const { source, wheel, filtered } = setup();
    const ink = inkReader(filtered);
    source.write(`${PASTE_START}hello${ESC}[20`);
    vi.advanceTimersByTime(UNFINISHED_SEQUENCE_WAIT_MS * 3);
    source.write("1~");
    source.write(sgr(64));
    vi.advanceTimersByTime(UNFINISHED_SEQUENCE_WAIT_MS * 3);
    expect(ink.text()).toBe(`${PASTE_START}hello${PASTE_END}`);
    expect(wheel).toEqual(["up"]);
  });

  it("drops what it holds when Ink stops listening, so it is not joined to a later key", () => {
    const { source, filtered } = setup();
    const ink = inkReader(filtered);
    source.write(ESC);
    ink.stop();
    vi.advanceTimersByTime(UNFINISHED_SEQUENCE_WAIT_MS * 3);
    const again = inkReader(filtered);
    source.write("x");
    expect(again.chunks).toEqual(["x"]);
  });

  it("drops what has passed but not been read when Ink stops listening", () => {
    const { source, filtered } = setup();
    const listener = () => {};
    filtered.addListener("readable", listener);
    source.write("typed before the editor");
    filtered.removeListener("readable", listener);
    const again = inkReader(filtered);
    source.write("x");
    expect(again.chunks).toEqual(["x"]);
  });

  it("decodes chunks that arrive as bytes, a character split between two of them too", () => {
    const { source, filtered } = setup();
    const ink = inkReader(filtered);
    const bytes = Buffer.from(`é${sgr(64)}`, "utf8");
    source.write(bytes.subarray(0, 1));
    source.write(bytes.subarray(1));
    expect(ink.text()).toBe("é");
  });
});
