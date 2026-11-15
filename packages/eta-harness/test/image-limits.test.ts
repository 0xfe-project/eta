/**
 * What a model will take as an image (see image-limits.ts).
 *
 * The numbers matter more than the plumbing. A limit read one pixel too
 * generously puts a picture in the journal that the provider refuses on every
 * request after it, and the session stops answering for good — so the
 * measurement is pinned here (a cap per side, not on pixels, not on bytes), and
 * the header reader is pinned for the formats it decodes and for the shapes it
 * must refuse to guess about.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  checkBase64Image,
  checkImage,
  DEFAULT_IMAGE_LIMITS,
  imageLimitsFor,
} from "../src/image-limits";
import { base64ByteLength, readImageSize } from "../src/tools/image";

/** A PNG header of the given size: signature, IHDR, nothing to decode. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A GIF header: signature, then the two little-endian sizes. */
function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([...Buffer.from("GIF89a", "latin1")], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/** A JPEG whose SOF0 follows a JFIF segment, the way a camera writes one. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(29);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  view.setUint16(4, 16); // APP0 length
  view.setUint32(6, 0x4a464946); // "JFIF"
  view.setUint16(20, 0xffc0);
  view.setUint16(22, 17); // SOF0 length
  bytes[24] = 8; // precision
  view.setUint16(25, height);
  view.setUint16(27, width);
  return bytes;
}

describe("readImageSize", () => {
  it("reads a size out of every header a provider accepts", () => {
    expect(readImageSize(png(1280, 11024))).toEqual({
      width: 1280,
      height: 11024,
    });
    expect(readImageSize(gif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readImageSize(jpeg(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("says nothing rather than guessing", () => {
    expect(readImageSize(new Uint8Array())).toBeUndefined();
    expect(readImageSize(Buffer.from("not an image at all"))).toBeUndefined();
    // A PNG signature without its IHDR, and a JPEG cut before its frame header.
    expect(readImageSize(png(10, 10).slice(0, 16))).toBeUndefined();
    expect(readImageSize(jpeg(10, 10).slice(0, 20))).toBeUndefined();
  });
});

describe("checkImage", () => {
  // Measured against DeepSeek on 2026-10-27: these two are the pair that draws
  // the line, and 8200×100 is why it is a per-side cap and not a pixel count.
  it("is a cap on a side, not on the number of pixels", () => {
    expect(
      checkImage(png(1280, 8192), "image/png", DEFAULT_IMAGE_LIMITS),
    ).toBeUndefined();
    expect(
      checkImage(png(4000, 4000), "image/png", DEFAULT_IMAGE_LIMITS),
    ).toBeUndefined();
    expect(
      checkImage(png(1280, 8193), "image/png", DEFAULT_IMAGE_LIMITS),
    ).toMatchObject({ code: "side" });
    expect(
      checkImage(png(8200, 100), "image/png", DEFAULT_IMAGE_LIMITS),
    ).toMatchObject({ code: "side" });
  });

  it("says what it is about the image", () => {
    const problem = checkImage(
      png(1280, 11024),
      "image/png",
      DEFAULT_IMAGE_LIMITS,
    );
    expect(problem?.detail).toContain("1280×11024");
    expect(problem?.detail).toContain("8192");
  });

  it("refuses a format and a payload the model would refuse", () => {
    expect(
      checkImage(png(10, 10), "image/bmp", DEFAULT_IMAGE_LIMITS),
    ).toMatchObject({ code: "mime" });
    expect(
      checkImage(png(10, 10), "image/png", {
        ...DEFAULT_IMAGE_LIMITS,
        maxBytes: 10,
      }),
    ).toMatchObject({ code: "bytes" });
  });
});

describe("checkBase64Image", () => {
  it("reaches the same verdict from the history's base64", () => {
    const data = Buffer.from(png(1280, 11024)).toString("base64");
    expect(
      checkBase64Image(data, "image/png", DEFAULT_IMAGE_LIMITS),
    ).toMatchObject({
      code: "side",
    });
    expect(base64ByteLength(data)).toBe(png(1280, 11024).byteLength);
    expect(
      checkBase64Image(
        Buffer.from(png(100, 100)).toString("base64"),
        "image/png",
        DEFAULT_IMAGE_LIMITS,
      ),
    ).toBeUndefined();
  });
});

describe("imageLimitsFor", () => {
  it("knows the models it has measured or read the documentation for", () => {
    expect(
      imageLimitsFor({ provider: "deepseek", modelId: "deepseek-flash" })
        .maxSide,
    ).toBe(8192);
    expect(
      imageLimitsFor({ provider: "anthropic", modelId: "claude-sonnet" })
        .maxSide,
    ).toBe(8000);
  });

  it("falls back to the conservative default for anything else", () => {
    expect(imageLimitsFor(undefined)).toBe(DEFAULT_IMAGE_LIMITS);
    expect(imageLimitsFor({ provider: "local", modelId: "llama-3" })).toBe(
      DEFAULT_IMAGE_LIMITS,
    );
  });
});
