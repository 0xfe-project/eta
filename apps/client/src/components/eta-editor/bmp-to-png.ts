// The model tools reject BMP, and the Windows clipboard hands screenshots over as image/bmp. nsh's
// runtime is not a browser (canvas/createImageBitmap are not available to it), so decode the BMP
// here and write an uncompressed PNG.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function zlibStored(raw: Uint8Array) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let offset = 0, i = 0; i < blocks; i++, offset += 65535) {
    const size = Math.min(65535, raw.length - offset);
    out[at++] = i === blocks - 1 ? 1 : 0;
    view.setUint16(at, size, true);
    view.setUint16(at + 2, ~size & 0xffff, true);
    at += 4;
    out.set(raw.subarray(offset, offset + size), at);
    at += size;
  }
  view.setUint32(at, adler32(raw));
  return out;
}

function channel(mask: number) {
  if (!mask) return { shift: 0, max: 0 };
  let shift = 0;
  while (!((mask >>> shift) & 1)) shift++;
  return { shift, max: mask >>> shift };
}

/** Decode a 24- or 32-bit BMP and encode it as an RGB PNG; alpha is dropped (clipboard BMPs carry none). */
function bmpToPng(bmp: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  if (bmp.length < 54 || view.getUint16(0, true) !== 0x4d42)
    throw new Error("Not a BMP image");
  const offset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const height = Math.abs(signedHeight);
  const bits = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (view.getUint32(14, true) < 40 || width <= 0 || !height)
    throw new Error("Unsupported BMP header");
  if ((bits !== 24 && bits !== 32) || ![0, 3, 6].includes(compression))
    throw new Error(
      `Unsupported BMP format (${bits}-bit, compression ${compression})`,
    );
  const masks = (bits === 32 && compression !== 0 ? [54, 58, 62] : []).map(
    (at) => view.getUint32(at, true),
  );
  const [red, green, blue] = masks.length
    ? masks.map(channel)
    : [
        { shift: 16, max: 255 },
        { shift: 8, max: 255 },
        { shift: 0, max: 255 },
      ];
  if (!red || !green || !blue || !red.max || !green.max || !blue.max)
    throw new Error("Unsupported BMP channel masks");
  const stride = ((width * bits + 31) >> 5) << 2;
  if (offset + stride * height > bmp.length)
    throw new Error("BMP pixel data is truncated");
  const bytes = bits >> 3;
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const source = offset + (signedHeight > 0 ? height - 1 - y : y) * stride;
    let to = y * (width * 3 + 1);
    raw[to++] = 0;
    for (let x = 0; x < width; x++) {
      const at = source + x * bytes;
      if (bits === 24) {
        raw[to++] = bmp[at + 2]!;
        raw[to++] = bmp[at + 1]!;
        raw[to++] = bmp[at]!;
      } else {
        const pixel = view.getUint32(at, true);
        for (const { shift, max } of [red, green, blue])
          raw[to++] = Math.round((((pixel >>> shift) & max) * 255) / max);
      }
    }
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk("IHDR", header),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/** BMP files (by type, or by name when the runtime gives no type) become PNG; every other file is returned as is. */
export const isBmp = (file: File) =>
  file.type === "image/bmp" || /\.bmp$/i.test(file.name);

export async function pastedFile(file: File): Promise<File> {
  if (!isBmp(file)) return file;
  const png = bmpToPng(new Uint8Array(await file.arrayBuffer()));
  return new File([png], `${file.name.replace(/\.bmp$/i, "")}.png`, {
    type: "image/png",
  });
}
