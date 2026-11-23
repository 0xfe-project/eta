import { Buffer } from "node:buffer";

/**
 * An .ico cut down to the pictures that fit in `limit` bytes, as an .ico. Bun.Image cannot decode
 * an ico, so nothing is re-encoded: the pictures are taken as they are, largest first, while they
 * fit, and the directory is written again around them. Null when the bytes are not a well-formed
 * ico, or when not even one picture fits.
 */
export function fitIco(bytes: Uint8Array, limit: number): Buffer | null {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (source.length < 6 || source.readUInt16LE(0) !== 0) return null;
  if (source.readUInt16LE(2) !== 1) return null;
  const count = source.readUInt16LE(4);
  if (count === 0 || 6 + 16 * count > source.length) return null;
  const pictures: { entry: Buffer; payload: Buffer; side: number }[] = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + 16 * index;
    const size = source.readUInt32LE(at + 8);
    const offset = source.readUInt32LE(at + 12);
    if (size === 0 || offset + size > source.length) return null;
    pictures.push({
      entry: source.subarray(at, at + 16),
      payload: source.subarray(offset, offset + size),
      side: source[at] || 256,
    });
  }
  let room = limit - 6;
  const kept = new Set<(typeof pictures)[number]>();
  const largestFirst = [...pictures].sort(
    (a, b) => b.side - a.side || a.payload.length - b.payload.length,
  );
  for (const picture of largestFirst) {
    const cost = 16 + picture.payload.length;
    if (cost > room) continue;
    kept.add(picture);
    room -= cost;
  }
  if (kept.size === 0) return null;
  const inOrder = pictures.filter((picture) => kept.has(picture));
  const head = Buffer.alloc(6 + 16 * inOrder.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(inOrder.length, 4);
  let offset = head.length;
  inOrder.forEach((picture, index) => {
    const at = 6 + 16 * index;
    picture.entry.copy(head, at);
    head.writeUInt32LE(offset, at + 12);
    offset += picture.payload.length;
  });
  return Buffer.concat([head, ...inOrder.map((picture) => picture.payload)]);
}
