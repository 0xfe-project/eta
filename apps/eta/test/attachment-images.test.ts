/**
 * The pictures a model is given: as stored when they are small enough, scaled down when they are
 * not, and refused with a reason when they cannot be read.
 */
import type { AttachmentRecord } from "../src/conversations/attachments";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../src/conversations/attachments";
import { tempDir } from "./support/host";

const LIMIT = 3 * 1024 * 1024;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, 8 + data.length))
    crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** A square RGB png of noise: it does not compress, so its size is about three bytes a pixel. */
function noisePng(side: number): Buffer {
  const row = 1 + side * 3;
  const raw = Buffer.alloc(row * side);
  crypto.getRandomValues(raw);
  for (let y = 0; y < side; y += 1) raw[y * row] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function store() {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE attachment (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, name TEXT NOT NULL,
    content_type TEXT NOT NULL, size INTEGER NOT NULL, message_id TEXT, created_at INTEGER NOT NULL
  )`);
  const attachments = new AttachmentStore(db, await tempDir("eta-images-"));
  /** Put `bytes` where the store keeps a file, as a record of the given type. */
  const put = async (
    bytes: Buffer,
    contentType: string,
    name = "pic",
  ): Promise<AttachmentRecord> => {
    const record: AttachmentRecord = {
      id: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      name,
      contentType,
      size: bytes.byteLength,
      messageId: null,
    };
    const path = attachments.pathOf(record);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return record;
  };
  return { attachments, put };
}

const sizeOf = (dataBase64: string) => Buffer.from(dataBase64, "base64");

describe("an image over the limit", () => {
  it("is handed over as it is when it fits", async () => {
    const { attachments, put } = await store();
    const small = noisePng(64);
    const record = await put(small, "image/png");
    const image = await attachments.image(record);
    expect(image.mime).toBe("image/png");
    expect(sizeOf(image.dataBase64).equals(small)).toBe(true);
    const listed = await attachments.images([record]);
    expect(listed).toEqual([image]);
  });

  it("is scaled down to fit, and the stored file is left alone", async () => {
    const { attachments, put } = await store();
    const big = noisePng(1300);
    expect(big.byteLength).toBeGreaterThan(LIMIT);
    const record = await put(big, "image/png", "big.png");
    const image = await attachments.image(record);
    const bytes = sizeOf(image.dataBase64);
    expect(image.mime).toBe("image/png");
    expect(bytes.byteLength).toBeLessThanOrEqual(LIMIT);
    const shown = await new Bun.Image(bytes).metadata();
    expect(shown.width).toBeLessThan(1300);
    expect(shown.format).toBe("png");
    expect((await readFile(attachments.pathOf(record))).equals(big)).toBe(true);
  });

  it("stays a jpeg when it was one", async () => {
    const { attachments, put } = await store();
    const jpeg = await new Bun.Image(noisePng(1700))
      .jpeg({ quality: 100 })
      .buffer();
    expect(jpeg.byteLength).toBeGreaterThan(LIMIT);
    const record = await put(jpeg, "image/jpeg", "photo.jpg");
    const image = await attachments.image(record);
    expect(image.mime).toBe("image/jpeg");
    expect(sizeOf(image.dataBase64).byteLength).toBeLessThanOrEqual(LIMIT);
  });

  it("is scaled down in the history too, within what the images share", async () => {
    const { attachments, put } = await store();
    const first = await put(noisePng(1300), "image/png", "one.png");
    const second = await put(noisePng(1300), "image/png", "two.png");
    const listed = await attachments.images([first, second]);
    const total = listed.reduce(
      (sum, image) => sum + sizeOf(image.dataBase64).byteLength,
      0,
    );
    expect(listed.length).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(LIMIT);
  });

  it("is refused with the reason when it cannot be decoded", async () => {
    const { attachments, put } = await store();
    const junk = Buffer.alloc(LIMIT + 1024);
    crypto.getRandomValues(junk);
    const record = await put(junk, "image/png", "broken.png");
    await expect(attachments.image(record)).rejects.toThrow(
      /broken\.png is 3\.\d MB, over the 3\.0 MB an image may be, and it could not be decoded/,
    );
    // The history leaves it out rather than losing the turn.
    expect(await attachments.images([record])).toEqual([]);
  });

  it("keeps the formats a model takes", async () => {
    const { attachments, put } = await store();
    const record = await put(Buffer.from("BM"), "image/bmp");
    await expect(attachments.image(record)).rejects.toThrow(
      /not an image a model takes/,
    );
  });
});
