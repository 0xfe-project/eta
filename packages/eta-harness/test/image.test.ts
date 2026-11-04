/**
 * Image detection and the read image branch (ported from eta-agent's
 * `test/harness/tools.test.ts`).
 *
 * A picture is recognized by its bytes, not by its name: the magic number is
 * the truth, and the two cases worth being careful about are a PNG that
 * is *animated* (no provider takes one) and a BMP (none takes that either, unless
 * an image processor converts it).
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { detectSupportedImageMimeType, encodeBase64 } from "../src/tools/image";

/** One-pixel PNG (the smallest thing a provider will take). */
const tinyPng = (): Uint8Array =>
  Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
      "base64",
    ),
  );

/** A well-formed 1×1 24-bit BMP header, 58 bytes long. */
function tinyBmp(): Uint8Array {
  const bytes = new Uint8Array(58);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 1, true);
  view.setInt32(22, 1, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  return bytes;
}

const asciiBytes = (text: string, tail: number[] = []): Uint8Array =>
  Uint8Array.from(
    [...text].map((character) => character.charCodeAt(0)).concat(tail),
  );

describe("image detection", () => {
  it("recognizes the formats a provider takes by their magic numbers", () => {
    expect(detectSupportedImageMimeType(tinyPng())).toBe("image/png");
    expect(
      detectSupportedImageMimeType(
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      ),
    ).toBe("image/jpeg");
    expect(detectSupportedImageMimeType(asciiBytes("GIF89a", [0, 0]))).toBe(
      "image/gif",
    );
    expect(
      detectSupportedImageMimeType(
        Uint8Array.from([
          ...asciiBytes("RIFF"),
          0,
          0,
          0,
          0,
          ...asciiBytes("WEBP"),
        ]),
      ),
    ).toBe("image/webp");
    expect(detectSupportedImageMimeType(tinyBmp())).toBe("image/bmp");
  });

  it("refuses what it cannot be sure about", () => {
    // Not an image at all.
    expect(
      detectSupportedImageMimeType(asciiBytes("hello world")),
    ).toBeUndefined();
    expect(detectSupportedImageMimeType(new Uint8Array())).toBeUndefined();
    // A JPEG variant no provider takes.
    expect(
      detectSupportedImageMimeType(
        Uint8Array.from([0xff, 0xd8, 0xff, 0xf7, 0x00]),
      ),
    ).toBeUndefined();
    // A PNG whose first chunk is not IHDR, or which is animated, is refused.
    const brokenPng = tinyPng();
    brokenPng[12] = 0x58;
    expect(detectSupportedImageMimeType(brokenPng)).toBeUndefined();
    // A BMP whose pixel data would start before the header: refused.
    const brokenBmp = tinyBmp();
    new DataView(brokenBmp.buffer).setUint32(10, 4, true);
    expect(detectSupportedImageMimeType(brokenBmp)).toBeUndefined();
  });

  it("refuses an animated PNG by its animation chunk", () => {
    // Signature + IHDR (its 13-byte payload and CRC end at byte 33), then a
    // well-formed acTL chunk: an APNG, which is not sent to a provider.
    const animated = Uint8Array.from([
      ...tinyPng().slice(0, 33),
      0,
      0,
      0,
      8,
      ...asciiBytes("acTL"),
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    expect(detectSupportedImageMimeType(animated)).toBeUndefined();
  });

  it("encodes base64 the way the platform does", () => {
    for (const bytes of [
      new Uint8Array(),
      Uint8Array.from([0]),
      Uint8Array.from([0, 1]),
      Uint8Array.from([0, 1, 2]),
      Uint8Array.from([0, 1, 2, 253, 254, 255]),
      tinyPng(),
    ]) {
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});
