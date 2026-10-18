/**
 * Bounded capture of one command's output (the memory discipline behind
 * eta-agent's `harness/utils/output-capture.ts`).
 *
 * A command may print gigabytes. What the model gets is bounded before it is
 * ever concatenated: the buffer keeps only a window of `maxBytes * 2`, counts
 * the totals as they arrive, and cuts the window to the limits at snapshot
 * time. The full text is available to *spill* to a file, and only until it has
 * been spilled — after that the file owns it.
 *
 * `LiveOutput` is the other half: it publishes that window as it fills, through
 * the adaptive publisher, so a client can watch a long command talk without ever
 * holding its output. `applyShellOutputUpdate` applies the deltas on the far side.
 */
import { AdaptivePublisher } from "./adaptive-publisher";
import type {
  ShellOutputMetadata,
  ShellOutputUpdate,
  ShellOutputView,
  ShellTruncation,
} from "./types";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
  utf8ByteLength,
} from "./truncate";

/** The floor between two live updates, and the size budget they share. */
export const OUTPUT_MIN_EMIT_INTERVAL_MS = 100;
export const OUTPUT_TARGET_BYTES_PER_SECOND = 100 * 1024;

/** What one buffer is allowed to keep. */
export interface OutputBufferOptions {
  maxBytes?: number | undefined;
  maxLines?: number | undefined;
  /** Which end of the output to keep. Defaults to `"tail"`. */
  retain?: "head" | "tail" | undefined;
}

export class OutputBuffer {
  private readonly maxBytes: number;
  private readonly maxLines: number;
  private readonly retain: "head" | "tail";
  private readonly decoder = new TextDecoder();
  private window = "";
  private raw = "";
  private rawTaken = false;
  private totalBytes = 0;
  private newlines = 0;
  private endsWithNewline = true;
  private currentLineBytes = 0;
  private disposed = false;

  constructor(options: OutputBufferOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.retain = options.retain ?? "tail";
    if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
      throw new TypeError("output maxBytes must be a positive finite number");
    }
    if (!Number.isInteger(this.maxLines) || this.maxLines <= 0) {
      throw new TypeError("output maxLines must be a positive integer");
    }
  }

  /** Whether what has arrived so far already exceeds a limit. */
  get truncated(): boolean {
    return this.totalBytes > this.maxBytes || this.totalLines > this.maxLines;
  }

  /** Total bytes seen, across everything ever pushed. */
  get bytes(): number {
    return this.totalBytes;
  }

  push(chunk: string | Uint8Array): void {
    if (this.disposed) return;
    this.append(
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true }),
    );
  }

  /** Flush any pending decoder state; call once the stream has ended. */
  finish(): void {
    if (this.disposed) return;
    this.append(this.decoder.decode());
  }

  /** The bounded text, and how it was cut. */
  snapshot(): { text: string; truncation: ShellTruncation } {
    const options = { maxBytes: this.maxBytes, maxLines: this.maxLines };
    const cut =
      this.retain === "head"
        ? truncateHead(this.window, options)
        : truncateTail(this.window, options);
    const { content, ...truncation } = cut;
    return {
      text: content,
      truncation: {
        ...truncation,
        truncated: this.truncated,
        truncatedBy: this.truncated
          ? this.totalLines > this.maxLines
            ? "lines"
            : "bytes"
          : null,
        totalBytes: this.totalBytes,
        totalLines: this.totalLines,
        ...(this.retain === "tail"
          ? { lastLineBytes: this.currentLineBytes }
          : {}),
      },
    };
  }

  /**
   * Everything pushed so far, for a spill file. Returns the text once; a
   * second call is empty, because the file owns it after that.
   */
  takeRaw(): string {
    if (this.rawTaken) return "";
    this.rawTaken = true;
    const text = this.raw;
    this.raw = "";
    return text;
  }

  dispose(): void {
    this.disposed = true;
    this.window = "";
    this.raw = "";
  }

  private get totalLines(): number {
    return (
      this.newlines + (this.endsWithNewline || this.totalBytes === 0 ? 0 : 1)
    );
  }

  private append(text: string): void {
    if (text.length === 0) return;
    const bytes = utf8ByteLength(text);
    this.totalBytes += bytes;
    this.newlines += countNewlines(text);
    this.endsWithNewline = text.endsWith("\n");
    const lastNewline = text.lastIndexOf("\n");
    this.currentLineBytes =
      lastNewline === -1
        ? this.currentLineBytes + bytes
        : utf8ByteLength(text.slice(lastNewline + 1));
    this.window += text;
    if (!this.rawTaken) this.raw += text;

    // Keep the window at twice the limit so a snapshot has something to cut,
    // and never let it grow past that: the point is bounded memory.
    const guard = this.maxBytes * 2;
    if (utf8ByteLength(this.window) > guard * 2) {
      this.window =
        this.retain === "tail"
          ? trimToLastUtf8Bytes(this.window, guard)
          : trimToFirstUtf8Bytes(this.window, guard);
    }
  }
}

function countNewlines(text: string): number {
  let count = 0;
  for (
    let index = text.indexOf("\n");
    index !== -1;
    index = text.indexOf("\n", index + 1)
  )
    count += 1;
  return count;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimToLastUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = textEncoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80)
    start += 1;
  return textDecoder.decode(bytes.subarray(start));
}

function trimToFirstUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = textEncoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return textDecoder.decode(bytes.subarray(0, end));
}

/** What a live view needs to publish, and where the published updates go. */
export interface LiveOutputOptions {
  buffer: OutputBuffer;
  onUpdate: (update: ShellOutputUpdate) => void;
  onError: (error: unknown) => void;
  /** Where the whole output went, once it has been spilled. */
  spillPath?: string | undefined;
  minIntervalMs?: number | undefined;
  targetBytesPerSecond?: number | undefined;
}

/**
 * Publishes one buffer's window while it fills.
 *
 * Writes received while publication is rate-limited collapse into the latest view
 * — the publisher's snapshot is the buffer, so nothing is queued and nothing is
 * lost. The first update after idle and the final flush are immediate.
 */
export class LiveOutput {
  private readonly buffer: OutputBuffer;
  private readonly publisher: AdaptivePublisher<
    ShellOutputView,
    ShellOutputUpdate
  >;
  private spillPath: string | undefined;
  private disposed = false;

  constructor(options: LiveOutputOptions) {
    this.buffer = options.buffer;
    this.spillPath = options.spillPath;
    this.publisher = new AdaptivePublisher({
      snapshot: () => this.view(),
      update: updateFrom,
      measure: (update) => utf8ByteLength(JSON.stringify(update)),
      publish: options.onUpdate,
      onError: options.onError,
      minIntervalMs: options.minIntervalMs ?? OUTPUT_MIN_EMIT_INTERVAL_MS,
      targetBytesPerSecond:
        options.targetBytesPerSecond ?? OUTPUT_TARGET_BYTES_PER_SECOND,
    });
  }

  /** One chunk arrived. */
  push(chunk: string | Uint8Array): void {
    if (this.disposed) return;
    this.buffer.push(chunk);
    this.publisher.markDirty();
  }

  /** The stream ended: flush the decoder and publish what is left. */
  finish(): void {
    if (this.disposed) return;
    this.buffer.finish();
    this.flush();
  }

  /** The full output now lives in a file; say so at once, not at the next chunk. */
  setSpillPath(path: string): void {
    if (this.disposed || this.spillPath === path) return;
    this.spillPath = path;
    this.publisher.markDirty();
    this.flush();
  }

  flush(): void {
    if (this.disposed) return;
    this.publisher.flush(true);
  }

  dispose(): void {
    this.publisher.dispose();
    this.disposed = true;
  }

  /** The current view: the buffer's bounded text, plus where the rest of it went. */
  view(): ShellOutputView {
    const { text, truncation } = this.buffer.snapshot();
    return {
      text: sanitizeShellOutput(text),
      truncation,
      ...(this.spillPath === undefined ? {} : { spillPath: this.spillPath }),
      ...(truncation.lastLineBytes === undefined
        ? {}
        : { lastLineBytes: truncation.lastLineBytes }),
    };
  }
}

/**
 * Apply one delta to the view a consumer holds. The inverse of what the publisher
 * sends: a client that keeps one `ShellOutputView` and applies everything it
 * receives ends with exactly the view the producer had.
 */
export function applyShellOutputUpdate(
  current: ShellOutputView | undefined,
  update: ShellOutputUpdate,
): ShellOutputView {
  switch (update.kind) {
    case "replace":
      return update.output;
    case "append":
      return {
        text: `${current?.text ?? ""}${update.text}`,
        ...update.metadata,
      };
    case "slide":
      return {
        text: `${current?.text.slice(update.drop) ?? ""}${update.text}`,
        ...update.metadata,
      };
    case "metadata":
      return { text: current?.text ?? "", ...update.metadata };
  }
}

/**
 * The smallest delta that turns one view into the next: nothing new is sent twice.
 * A window that turned over entirely has no shared text and is replaced outright.
 */
function updateFrom(
  previous: ShellOutputView | undefined,
  current: ShellOutputView,
): ShellOutputUpdate {
  if (previous === undefined) return { kind: "replace", output: current };
  const metadata: ShellOutputMetadata = {
    truncation: current.truncation,
    ...(current.spillPath === undefined
      ? {}
      : { spillPath: current.spillPath }),
    ...(current.lastLineBytes === undefined
      ? {}
      : { lastLineBytes: current.lastLineBytes }),
  };
  if (current.text === previous.text) return { kind: "metadata", metadata };
  if (
    current.text.length > previous.text.length &&
    current.text.startsWith(previous.text)
  ) {
    return {
      kind: "append",
      text: current.text.slice(previous.text.length),
      metadata,
    };
  }
  const shared = suffixPrefixOverlap(
    previous.text,
    current.text,
    Math.min(
      previous.text.length,
      current.text.length,
      current.truncation.maxBytes * 2,
    ),
  );
  if (shared > 0) {
    return {
      kind: "slide",
      drop: previous.text.length - shared,
      text: current.text.slice(shared),
      metadata,
    };
  }
  return { kind: "replace", output: current };
}

/**
 * How much of the end of `before` is the start of `after`: what a window that
 * scrolled can keep. Probes the first bytes of the new text rather than every
 * suffix, so the cost does not grow with the window.
 */
function suffixPrefixOverlap(
  before: string,
  after: string,
  scan: number,
): number {
  if (before.length === 0 || after.length === 0 || scan === 0) return 0;
  const tail =
    before.length > scan ? before.slice(before.length - scan) : before;
  for (const probeLength of [Math.min(64, after.length), 1]) {
    const probe = after.slice(0, probeLength);
    let candidates = 0;
    for (
      let index = tail.indexOf(probe);
      index !== -1;
      index = tail.indexOf(probe, index + 1)
    ) {
      if (++candidates > 8) break;
      const overlapLength = tail.length - index;
      if (
        overlapLength <= after.length &&
        tail.slice(index) === after.slice(0, overlapLength)
      ) {
        return overlapLength;
      }
    }
    if (probeLength === 1) break;
  }
  return 0;
}

/** Control characters a terminal would eat; a view is text, not a terminal stream. */
const INVALID_SHELL_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g;

export function sanitizeShellOutput(text: string): string {
  return text.replace(INVALID_SHELL_OUTPUT, "");
}
