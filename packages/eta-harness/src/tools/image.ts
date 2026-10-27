const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectSupportedImageMimeType(
  buffer: Uint8Array,
): string | undefined {
  if (startsWith(buffer, [0xff, 0xd8, 0xff]))
    return buffer[3] === 0xf7 ? undefined : "image/jpeg";
  if (startsWith(buffer, PNG_SIGNATURE))
    return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : undefined;
  if (startsWithAscii(buffer, 0, "GIF")) return "image/gif";
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP"))
    return "image/webp";
  if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
  return undefined;
}

/**
 * The bytes a base64 string stands for, without decoding all of it.
 *
 * A history can hold megabytes of image data, and every check wants the first
 * few hundred bytes (a header) plus the total length. `maxBytes` cuts the work
 * where the caller says it no longer matters.
 */
export function decodeBase64(data: string, maxBytes?: number): Uint8Array {
  const usable =
    maxBytes === undefined ? data : data.slice(0, Math.ceil(maxBytes / 3) * 4);
  // A cut that lands inside a quantum is padding the decoder would reject.
  const trimmed = usable.slice(0, usable.length - (usable.length % 4));
  const binary = atob(trimmed);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** How many bytes a base64 string stands for, without decoding it. */
export function base64ByteLength(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * An image's pixel dimensions, read from its header.
 *
 * Not a decode: providers refuse an image by its *size*, and a header is all it
 * takes to know whether a screenshot of a long page is one of them. `undefined`
 * means this function could not tell — an unknown container, or a header that
 * is not where it should be — and a caller must not treat that as "too big".
 */
export function readImageSize(
  buffer: Uint8Array,
): { width: number; height: number } | undefined {
  const mimeType = detectSupportedImageMimeType(buffer);
  if (mimeType === "image/png") {
    if (buffer.length < 24) return undefined;
    return {
      width: readUint32BE(buffer, 16),
      height: readUint32BE(buffer, 20),
    };
  }
  if (mimeType === "image/gif") {
    if (buffer.length < 10) return undefined;
    return {
      width: readUint16LE(buffer, 6),
      height: readUint16LE(buffer, 8),
    };
  }
  if (mimeType === "image/jpeg") return jpegSize(buffer);
  if (mimeType === "image/webp") return webpSize(buffer);
  if (mimeType === "image/bmp") {
    if (buffer.length < 26) return undefined;
    const width = readUint32LESigned(buffer, 18);
    const height = readUint32LESigned(buffer, 22);
    if (width === undefined || height === undefined) return undefined;
    return { width, height: Math.abs(height) };
  }
  return undefined;
}

/** JPEG keeps its dimensions in the first SOFn marker, after variable segments. */
function jpegSize(
  buffer: Uint8Array,
): { width: number; height: number } | undefined {
  let offset = 2; // past the SOI marker
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] ?? 0;
    // Padding FFs before a marker are legal and say nothing.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // SOF0-SOF15 carry the frame size, minus the markers that are not frames.
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      return {
        height: readUint16BE(buffer, offset + 5),
        width: readUint16BE(buffer, offset + 7),
      };
    }
    const segmentLength = readUint16BE(buffer, offset + 2);
    if (segmentLength < 2) return undefined;
    offset += 2 + segmentLength;
  }
  return undefined;
}

function webpSize(
  buffer: Uint8Array,
): { width: number; height: number } | undefined {
  if (buffer.length < 16) return undefined;
  if (startsWithAscii(buffer, 12, "VP8X")) {
    if (buffer.length < 30) return undefined;
    return {
      width: 1 + readUint24LE(buffer, 24),
      height: 1 + readUint24LE(buffer, 27),
    };
  }
  if (startsWithAscii(buffer, 12, "VP8L")) {
    if (buffer.length < 25) return undefined;
    const bits = readUint32LE(buffer, 21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
  }
  if (startsWithAscii(buffer, 12, "VP8 ")) {
    if (buffer.length < 30) return undefined;
    return {
      width: readUint16LE(buffer, 26) & 0x3fff,
      height: readUint16LE(buffer, 28) & 0x3fff,
    };
  }
  return undefined;
}

export function encodeBase64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    output +=
      second === undefined
        ? "="
        : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : alphabet[third & 0x3f];
  }
  return output;
}

function isPng(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 16 &&
    readUint32BE(buffer, PNG_SIGNATURE.length) === 13 &&
    startsWithAscii(buffer, 12, "IHDR")
  );
}

function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

function isBmp(buffer: Uint8Array): boolean {
  if (buffer.length < 26) return false;
  const declaredFileSize = readUint32LE(buffer, 2);
  const pixelDataOffset = readUint32LE(buffer, 10);
  const dibHeaderSize = readUint32LE(buffer, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize)
    return false;

  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(buffer, 22);
    bitsPerPixel = readUint16LE(buffer, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buffer.length < 30) return false;
    colorPlanes = readUint16LE(buffer, 26);
    bitsPerPixel = readUint16LE(buffer, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint16BE(buffer: Uint8Array, offset: number): number {
  return ((buffer[offset] ?? 0) << 8) + (buffer[offset + 1] ?? 0);
}

function readUint24LE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) +
    ((buffer[offset + 1] ?? 0) << 8) +
    ((buffer[offset + 2] ?? 0) << 16)
  );
}

/** A BMP width/height is signed: a negative height means a top-down image. */
function readUint32LESigned(
  buffer: Uint8Array,
  offset: number,
): number | undefined {
  const value = readUint32LE(buffer, offset);
  if (value === 0) return undefined;
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) +
    ((buffer[offset + 1] ?? 0) << 8) +
    ((buffer[offset + 2] ?? 0) << 16) +
    (buffer[offset + 3] ?? 0) * 0x1000000
  );
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(
  buffer: Uint8Array,
  offset: number,
  text: string,
): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}
