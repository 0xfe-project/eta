/**
 * Renders an Ink tree into memory at a chosen terminal size, and types into it.
 * `ink-testing-library` fixes the width at 100 columns and has no height; the splash and the
 * tab bar need both.
 */
import type { ReactElement } from "react";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render as inkRender } from "ink";

class MemoryStdout extends EventEmitter {
  readonly frames: string[] = [];
  isTTY = false;
  columns: number;
  rows: number;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

class MemoryStdin extends EventEmitter {
  isTTY = true;
  private pending: string | null = null;
  write = (data: string): void => {
    this.pending = data;
    this.emit("readable");
    this.emit("data", data);
  };

  read = (): string | null => {
    const data = this.pending;
    this.pending = null;
    return data;
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

const realSetTimeout = globalThis.setTimeout;

/** Waits on the real clock, so it works while a test fakes timers. */
export function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/** Lets pending React work and promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

export const KEYS = {
  enter: "\r",
  escape: "\u001B",
  up: "\u001B[A",
  down: "\u001B[B",
  left: "\u001B[D",
  right: "\u001B[C",
  altLeft: "\u001B[1;3D",
  altRight: "\u001B[1;3C",
  tab: "\t",
  backspace: "\u007F",
  ctrlC: "\u0003",
  ctrlW: "\u0017",
  alt: (char: string) => `\u001B${char}`,
  paste: (text: string) => `\u001B[200~${text}\u001B[201~`,
} as const;

export interface Rendered {
  lastFrame: () => string;
  stdout: MemoryStdout;
  /** Types a key or text and waits for the frame. A bare Escape waits out Ink's 20 ms escape timeout on the real clock. */
  press: (data: string) => Promise<void>;
  type: (text: string) => Promise<void>;
  unmount: () => void;
}

export function renderInk(
  tree: ReactElement,
  size: { columns?: number; rows?: number } = {},
): Rendered {
  const stdout = new MemoryStdout(size.columns ?? 100, size.rows ?? 30);
  const stderr = new MemoryStdout(100, 30);
  const stdin = new MemoryStdin();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const press = async (data: string): Promise<void> => {
    stdin.write(data);
    if (data === KEYS.escape) await realDelay(40);
    await flush();
  };
  return {
    lastFrame: () => stdout.frames.at(-1) ?? "",
    stdout,
    press,
    type: async (text: string) => {
      for (const char of text) await press(char);
    },
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}

/** The last frame without colours and styles. */
export function plain(rendered: Pick<Rendered, "lastFrame">): string {
  return stripVTControlCharacters(rendered.lastFrame());
}
