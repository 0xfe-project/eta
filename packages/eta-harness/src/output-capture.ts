/**
 * OutputBuffer — bounded capture of one command's output (the memory discipline
 * behind eta-agent's `harness/utils/output-capture.ts`).
 *
 * A command may print gigabytes. What the model gets is bounded before it is
 * ever concatenated: the buffer keeps only a window of `maxBytes * 2`, counts
 * the totals as they arrive, and cuts the window to the limits at snapshot
 * time. The full text is available to *spill* to a file, and only until it has
 * been spilled — after that the file owns it.
 *
 * What eta does beyond this — rate-limited live updates of the window to the
 * running tool call — belongs to the bash tool, where a model actually watches
 * output arrive; it is not needed to keep memory in bounds, and this is where
 * the bounds live.
 */
import type { ShellTruncation } from "./env/types";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail, utf8ByteLength } from "./truncate";

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
		this.append(typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true }));
	}

	/** Flush any pending decoder state; call once the stream has ended. */
	finish(): void {
		if (this.disposed) return;
		this.append(this.decoder.decode());
	}

	/** The bounded text, and how it was cut. */
	snapshot(): { text: string; truncation: ShellTruncation } {
		const options = { maxBytes: this.maxBytes, maxLines: this.maxLines };
		const cut = this.retain === "head" ? truncateHead(this.window, options) : truncateTail(this.window, options);
		const { content, ...truncation } = cut;
		return {
			text: content,
			truncation: {
				...truncation,
				truncated: this.truncated,
				truncatedBy: this.truncated ? (this.totalLines > this.maxLines ? "lines" : "bytes") : null,
				totalBytes: this.totalBytes,
				totalLines: this.totalLines,
				...(this.retain === "tail" ? { lastLineBytes: this.currentLineBytes } : {}),
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
		return this.newlines + (this.endsWithNewline || this.totalBytes === 0 ? 0 : 1);
	}

	private append(text: string): void {
		if (text.length === 0) return;
		const bytes = utf8ByteLength(text);
		this.totalBytes += bytes;
		this.newlines += countNewlines(text);
		this.endsWithNewline = text.endsWith("\n");
		const lastNewline = text.lastIndexOf("\n");
		this.currentLineBytes =
			lastNewline === -1 ? this.currentLineBytes + bytes : utf8ByteLength(text.slice(lastNewline + 1));
		this.window += text;
		if (!this.rawTaken) this.raw += text;

		// Keep the window at twice the limit so a snapshot has something to cut,
		// and never let it grow past that: the point is bounded memory.
		const guard = this.maxBytes * 2;
		if (utf8ByteLength(this.window) > guard * 2) {
			this.window =
				this.retain === "tail" ? trimToLastUtf8Bytes(this.window, guard) : trimToFirstUtf8Bytes(this.window, guard);
		}
	}
}

function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
	return count;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimToLastUtf8Bytes(text: string, maxBytes: number): string {
	const bytes = textEncoder.encode(text);
	if (bytes.length <= maxBytes) return text;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return textDecoder.decode(bytes.subarray(start));
}

function trimToFirstUtf8Bytes(text: string, maxBytes: number): string {
	const bytes = textEncoder.encode(text);
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return textDecoder.decode(bytes.subarray(0, end));
}
