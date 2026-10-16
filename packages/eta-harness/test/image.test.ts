import type { ImageContent, ToolCallInfo } from "@eta/core";
import type { ExecutionToolContext } from "../src/tools/context";
import type { ToolResult } from "../src/tools/tool";
/**
 * Image detection and the read image branch (ported from eta-agent's
 * `test/harness/tools.test.ts`).
 *
 * A picture is recognized by its bytes, not by its name: the magic number is
 * the truth, and the two cases worth being careful about are a PNG that is
 * animated* (no provider takes one) and a BMP (none takes that either, unless
 * an image processor converts it).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeEnvironment } from "@eta/execution-node";
import { beforeAll, describe, expect, it } from "vitest";
import { detectSupportedImageMimeType, encodeBase64 } from "../src/tools/image";
import { createReadTool } from "../src/tools/read";

let directory = "";
let env: NodeEnvironment;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "eta-image-"));
  env = new NodeEnvironment({ cwd: directory });
});

const run = () =>
  ({
    call: { turn: 1, toolCallId: "read-1" } as ToolCallInfo,
    context: { env } as ExecutionToolContext,
    update: () => undefined,
  }) satisfies Parameters<ReturnType<typeof createReadTool>["execute"]>[1];

const imageOf = (result: ToolResult<unknown>): ImageContent | undefined =>
  result.content.find((part): part is ImageContent => part.type === "image");

const textOf = (result: ToolResult<unknown>): string =>
  result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

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
  bytes[1] = 0x4D;
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
        Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]),
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
        Uint8Array.from([0xFF, 0xD8, 0xFF, 0xF7, 0x00]),
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

describe("read with images", () => {
  it("reads a picture by content, even with a text extension", async () => {
    const png = tinyPng();
    await env.writeFile("image.txt", png);
    const result = await createReadTool().execute({ path: "image.txt" }, run());
    expect(textOf(result)).toContain("Read image file [image/png]");
    expect(imageOf(result)).toEqual({
      type: "image",
      data: Buffer.from(png).toString("base64"),
      mimeType: "image/png",
    });
  });

  it("omits a BMP unless a processor can convert it", async () => {
    await env.writeFile("plain.bmp", tinyBmp());
    const plain = await createReadTool().execute({ path: "plain.bmp" }, run());
    expect(textOf(plain)).toContain("Image omitted");
    expect(imageOf(plain)).toBeUndefined();
  });

  it("delegates conversion to an injected processor, and passes its hints on", async () => {
    const bmp = tinyBmp();
    await env.writeFile("convert.bmp", bmp);
    let received:
      | { bytes: Uint8Array; mimeType: string; autoResizeImages: boolean }
      | undefined;
    const tool = createReadTool({
      autoResizeImages: false,
      imageProcessor: async (bytes, mimeType, options) => {
        received = {
          bytes,
          mimeType,
          autoResizeImages: options.autoResizeImages,
        };
        return {
          ok: true,
          data: "converted",
          mimeType: "image/png",
          hints: ["[Image converted from image/bmp to image/png.]"],
        };
      },
    });
    const result = await tool.execute({ path: "convert.bmp" }, run());
    expect(received).toMatchObject({
      mimeType: "image/bmp",
      autoResizeImages: false,
    });
    expect(Array.from(received?.bytes ?? [])).toEqual(Array.from(bmp));
    expect(textOf(result)).toContain(
      "[Image converted from image/bmp to image/png.]",
    );
    expect(imageOf(result)).toEqual({
      type: "image",
      data: "converted",
      mimeType: "image/png",
    });
  });

  it("tells the model when the processor refuses the image", async () => {
    await env.writeFile("refuse.bmp", tinyBmp());
    const tool = createReadTool({
      imageProcessor: async () => ({
        ok: false,
        message: "[Could not convert this image.]",
      }),
    });
    const result = await tool.execute({ path: "refuse.bmp" }, run());
    expect(textOf(result)).toContain("Read image file [image/bmp]");
    expect(textOf(result)).toContain("[Could not convert this image.]");
    expect(imageOf(result)).toBeUndefined();
  });

  it("cleans up after itself", async () => {
    await env.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
});
