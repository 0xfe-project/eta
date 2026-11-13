/**
 * Takes the terminal's mouse reports out of stdin before Ink reads it. Ink has no mouse events: a
 * report reaching it would be typed into the input as text.
 */
import type { Buffer } from "node:buffer";
import type { WheelDirection } from "./wheel";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

const ESC = "\u001B";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
/* eslint-disable no-control-regex -- these match the terminal's ESC on purpose */
// SGR coordinates (mode 1006): ESC [ < button ; column ; row, then M for a press, m for a release.
const SGR_REPORT = /\u001B\[<(\d+);\d+;\d+(m)/iy;
// The end of a read that can still grow into an SGR report: ESC, ESC [, ESC [ <, up to three numbers.
const SGR_REPORT_START = /^\u001B(?:\[(?:<\d{0,6}(?:;\d{0,6}){0,2})?)?$/;
/* eslint-enable no-control-regex */
// X10 coordinates, sent by terminals without mode 1006: ESC [ M and three bytes, each value + 32.
const X10_PREFIX = `${ESC}[M`;
const X10_LENGTH = X10_PREFIX.length + 3;
const X10_OFFSET = 32;

const WHEEL_UP_BUTTON = 64;
const WHEEL_DOWN_BUTTON = 65;
const SHIFT_BIT = 4;
const META_BIT = 8;
const CTRL_BIT = 16;
const MODIFIER_BITS = SHIFT_BIT | META_BIT | CTRL_BIT;

/**
 * How long the start of a sequence waits for its rest before it goes to Ink as it is. A terminal
 * writes a report in one go, so a split one completes within this; a bare Escape key is late by
 * this much. Ink waits as long after a bare ESC for the same reason.
 */
export const UNFINISHED_SEQUENCE_WAIT_MS = 20;

function wheelOf(button: number): WheelDirection | undefined {
  switch (button & ~MODIFIER_BITS) {
    case WHEEL_UP_BUTTON:
      return "up";
    case WHEEL_DOWN_BUTTON:
      return "down";
    default:
      return undefined;
  }
}

interface MouseReport {
  length: number;
  /** Set for a wheel step; every other report is dropped without a trace. */
  wheel: WheelDirection | undefined;
}

function reportAt(input: string, at: number): MouseReport | undefined {
  SGR_REPORT.lastIndex = at;
  const sgr = SGR_REPORT.exec(input);
  if (sgr) {
    const [whole, button, final] = sgr;
    // A release (m) of a wheel button is not a step.
    return {
      length: whole.length,
      wheel: final === "M" ? wheelOf(Number(button)) : undefined,
    };
  }
  if (input.startsWith(X10_PREFIX, at) && input.length >= at + X10_LENGTH) {
    const button = input.charCodeAt(at + X10_PREFIX.length) - X10_OFFSET;
    return { length: X10_LENGTH, wheel: wheelOf(button) };
  }
  return undefined;
}

/** Whether `rest`, the end of what has arrived, can still grow into a report or a paste start. */
function canStillGrow(rest: string): boolean {
  return (
    SGR_REPORT_START.test(rest) ||
    (rest.startsWith(X10_PREFIX) && rest.length < X10_LENGTH) ||
    PASTE_START.startsWith(rest)
  );
}

/** Where a paste end that has not fully arrived starts in `input`, or its length when none does. */
function unfinishedPasteEnd(input: string, from: number): number {
  const escape = input.lastIndexOf(ESC);
  if (escape < from) return input.length;
  const rest = input.slice(escape);
  return rest.length < PASTE_END.length && PASTE_END.startsWith(rest)
    ? escape
    : input.length;
}

/** What one read leaves for Ink, and the wheel steps taken out of it, in order. */
export interface FilteredRead {
  keys: string;
  wheel: WheelDirection[];
}

/**
 * Takes SGR and X10 mouse reports out of the text read from a terminal, read after read. A report
 * split across reads is found: the end of a read that can still grow into one is held back until
 * the next read or `releaseHeld`. Inside a bracketed paste everything is left alone.
 */
export function createMouseSequenceFilter() {
  let held = "";
  let inPaste = false;

  const push = (text: string): FilteredRead => {
    const input = held + text;
    held = "";
    let keys = "";
    const wheel: WheelDirection[] = [];
    let at = 0;
    while (at < input.length) {
      if (inPaste) {
        const end = input.indexOf(PASTE_END, at);
        if (end !== -1) {
          keys += input.slice(at, end + PASTE_END.length);
          at = end + PASTE_END.length;
          inPaste = false;
          continue;
        }
        const tail = unfinishedPasteEnd(input, at);
        keys += input.slice(at, tail);
        held = input.slice(tail);
        break;
      }
      const escape = input.indexOf(ESC, at);
      if (escape === -1) {
        keys += input.slice(at);
        break;
      }
      keys += input.slice(at, escape);
      const report = reportAt(input, escape);
      if (report) {
        if (report.wheel) wheel.push(report.wheel);
        at = escape + report.length;
        continue;
      }
      if (input.startsWith(PASTE_START, escape)) {
        keys += PASTE_START;
        at = escape + PASTE_START.length;
        inPaste = true;
        continue;
      }
      const rest = input.slice(escape);
      if (canStillGrow(rest)) {
        held = rest;
        break;
      }
      keys += ESC;
      at = escape + 1;
    }
    return { keys, wheel };
  };

  return {
    push,
    /** Whether the end of the last read is held back. */
    get holding(): boolean {
      return held !== "";
    },
    /** Whether the reads so far are inside a bracketed paste. */
    get inPaste(): boolean {
      return inPaste;
    },
    /** Gives up what is held back, as it arrived; it is no longer part of any report. */
    releaseHeld: (): string => {
      const released = held;
      held = "";
      return released;
    },
  };
}

/** The parts of the terminal's stdin the filtered stdin reads and passes on. */
export interface MouseInputSource {
  readonly isTTY?: boolean;
  read: () => string | Buffer | null;
  addListener: (event: "readable", listener: () => void) => unknown;
  removeListener: (event: "readable", listener: () => void) => unknown;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  ref?: () => unknown;
  unref?: () => unknown;
}

/**
 * A stdin for Ink: the terminal's stdin without mouse reports. Ink reads it as it reads a stream,
 * with `readable` and `read`; raw mode, encoding, `ref` and `unref` go to the terminal's stdin. The
 * terminal's stdin is read only while a `readable` listener is attached, so a program Ink hands the
 * terminal to gets the keys; whatever Ink has not read when it stops listening is dropped. A held
 * sequence start reaches Ink after `UNFINISHED_SEQUENCE_WAIT_MS`, except inside a paste, where it
 * waits for the next read.
 */
export class FilteredStdin extends EventEmitter {
  private readonly source: MouseInputSource;
  private readonly onWheel: (direction: WheelDirection) => void;
  private readonly filter = createMouseSequenceFilter();
  private readonly decoder = new StringDecoder("utf8");
  private queued = "";
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  private reading = false;

  constructor(
    source: MouseInputSource,
    onWheel: (direction: WheelDirection) => void,
  ) {
    super();
    this.source = source;
    this.onWheel = onWheel;
    this.on("newListener", (event) => {
      if (event !== "readable" || this.reading) return;
      this.reading = true;
      source.addListener("readable", this.pump);
    });
    this.on("removeListener", (event) => {
      if (event !== "readable" || this.listenerCount("readable") > 0) return;
      if (!this.reading) return;
      this.reading = false;
      source.removeListener("readable", this.pump);
      this.dropPending();
    });
  }

  get isTTY(): boolean {
    return this.source.isTTY === true;
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode?.(mode);
    return this;
  }

  setEncoding(encoding: BufferEncoding): this {
    this.source.setEncoding(encoding);
    return this;
  }

  ref(): this {
    this.source.ref?.();
    return this;
  }

  unref(): this {
    this.source.unref?.();
    return this;
  }

  /** What has passed the filter since the last call, or null when nothing has. */
  read(): string | null {
    if (this.queued === "") return null;
    const text = this.queued;
    this.queued = "";
    return text;
  }

  private readonly pump = (): void => {
    clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    for (
      let chunk = this.source.read();
      chunk !== null;
      chunk = this.source.read()
    ) {
      const text =
        typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      const { keys, wheel } = this.filter.push(text);
      this.queued += keys;
      for (const direction of wheel) this.onWheel(direction);
    }
    // Inside a paste the held start of the end marker waits for its rest however long it takes:
    // given up as text, the rest could no longer end the paste.
    if (this.filter.holding && !this.filter.inPaste)
      this.heldTimer = setTimeout(
        this.releaseHeld,
        UNFINISHED_SEQUENCE_WAIT_MS,
      );
    if (this.queued !== "") this.emit("readable");
  };

  // Ink stops listening when it hands the terminal to a program. What it has not read was typed
  // before that, and held back it would reach Ink with the first key after, as one sequence.
  private dropPending(): void {
    clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    this.filter.releaseHeld();
    this.queued = "";
  }

  private readonly releaseHeld = (): void => {
    this.heldTimer = undefined;
    this.queued += this.filter.releaseHeld();
    if (this.queued !== "") this.emit("readable");
  };
}

/** The terminal's stdin with mouse reports taken out; each wheel step goes to `onWheel`. */
export function filterMouseInput(
  source: MouseInputSource,
  onWheel: (direction: WheelDirection) => void,
): FilteredStdin {
  return new FilteredStdin(source, onWheel);
}
