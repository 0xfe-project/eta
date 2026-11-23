import { Buffer } from "node:buffer";

export const DEFAULT_MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024; // 4 MiB

export interface VirtualClipboardOptions {
  maxBytes?: number | undefined;
}

export interface VirtualClipboardPayload {
  text?: string | undefined;
  html?: string | undefined;
  imagePng?: Buffer | Uint8Array | undefined;
}

export interface VirtualClipboardSnapshot {
  text: string;
  html?: string | undefined;
  imagePng?: Buffer | undefined;
  byteLength: number;
  revision: number;
  updatedAt: number;
}

/**
 * In-memory per-realm clipboard isolated from the host OS clipboard (zero OS clipboard calls).
 * Supports `text/plain`, `text/html`, and optional `image/png` Buffer payloads with a configurable
 * byte cap (`maxBytes`, default 4 MiB) that throws `RangeError` when exceeded to prevent OOM.
 */
export class VirtualClipboard {
  readonly maxBytes: number;

  private textValue = "";
  private htmlValue: string | undefined = undefined;
  private imagePngValue: Buffer | undefined = undefined;
  private currentBytes = 0;
  private rev = 0;
  private lastUpdatedAt = Date.now();

  constructor(options: VirtualClipboardOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_CLIPBOARD_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError(
        `Invalid VirtualClipboard maxBytes: ${String(maxBytes)}`,
      );
    }
    this.maxBytes = maxBytes;
  }

  get revision(): number {
    return this.rev;
  }

  get updatedAt(): number {
    return this.lastUpdatedAt;
  }

  get byteLength(): number {
    return this.currentBytes;
  }

  /** Write a text, HTML, and/or PNG payload atomically into the virtual clipboard. */
  write(payload: VirtualClipboardPayload | string): VirtualClipboardSnapshot {
    const normalized: VirtualClipboardPayload =
      typeof payload === "string" ? { text: payload } : payload;

    const nextText = normalized.text ?? "";
    const nextHtml = normalized.html;
    const nextImage =
      normalized.imagePng !== undefined
        ? Buffer.from(normalized.imagePng)
        : undefined;

    const textBytes = Buffer.byteLength(nextText, "utf8");
    const htmlBytes =
      nextHtml !== undefined ? Buffer.byteLength(nextHtml, "utf8") : 0;
    const imageBytes = nextImage !== undefined ? nextImage.byteLength : 0;
    const totalBytes = textBytes + htmlBytes + imageBytes;

    if (totalBytes > this.maxBytes) {
      throw new RangeError(
        `Clipboard payload of ${String(totalBytes)} bytes exceeds limit of ${String(this.maxBytes)} bytes`,
      );
    }

    this.textValue = nextText;
    this.htmlValue = nextHtml;
    this.imagePngValue = nextImage;
    this.currentBytes = totalBytes;
    this.rev += 1;
    this.lastUpdatedAt = Date.now();

    return this.snapshot();
  }

  /** Write `text/plain` content. */
  writeText(text: string): VirtualClipboardSnapshot {
    return this.write({ text });
  }

  /** Write `text/html` content along with an optional `text/plain` fallback. */
  writeHtml(html: string, plainText?: string): VirtualClipboardSnapshot {
    return this.write({ text: plainText ?? "", html });
  }

  /** Write an `image/png` buffer along with optional text fallback. */
  writeImagePng(
    imagePng: Buffer | Uint8Array,
    altText?: string,
  ): VirtualClipboardSnapshot {
    return this.write({ text: altText ?? "", imagePng });
  }

  /** Read the current `text/plain` string. */
  readText(): string {
    return this.textValue;
  }

  /** Read the current `text/html` string, if present. */
  readHtml(): string | undefined {
    return this.htmlValue;
  }

  /** Read a defensive copy of the current `image/png` Buffer, if present. */
  readImagePng(): Buffer | undefined {
    return this.imagePngValue ? Buffer.from(this.imagePngValue) : undefined;
  }

  /** Return an immutable snapshot of all representations and metadata. */
  snapshot(): VirtualClipboardSnapshot {
    return {
      text: this.textValue,
      html: this.htmlValue,
      imagePng: this.imagePngValue
        ? Buffer.from(this.imagePngValue)
        : undefined,
      byteLength: this.currentBytes,
      revision: this.rev,
      updatedAt: this.lastUpdatedAt,
    };
  }

  /** Clear all representations and increment `revision`. */
  clear(): VirtualClipboardSnapshot {
    this.textValue = "";
    this.htmlValue = undefined;
    this.imagePngValue = undefined;
    this.currentBytes = 0;
    this.rev += 1;
    this.lastUpdatedAt = Date.now();
    return this.snapshot();
  }
}
