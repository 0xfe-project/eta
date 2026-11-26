/**
 * Fitting an image into a byte limit, with the runtime's own `Bun.Image`: shared by the attachments a
 * model is given and the logos the host keeps.
 */
import type { Buffer } from "node:buffer";

/** How much of its width and height an image keeps, in turn, until it fits (1: re-encoded only). */
const SHRINK_SCALES = [1, 0.75, 0.5, 0.35, 0.25, 0.15];
/** Lossy formats are re-encoded at this quality; the stored file is never touched. */
const SHRINK_QUALITY = 80;

const megabytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The bytes of an image as a model can be given them: as they are when they fit in `limit` (and
 * within `options.maxSide`, when given), else decoded, scaled down step by step and re-encoded
 * (jpeg and webp stay what they are; png and gif, which has no encoder, become png) until they do.
 * Throws why when the picture cannot be decoded or does not fit even at the smallest step. Uses
 * the runtime's own `Bun.Image`.
 */
export async function fitImage(
  name: string,
  mime: string,
  bytes: Buffer,
  limit: number,
  options?: { maxSide?: number | undefined },
): Promise<{ mime: string; bytes: Buffer }> {
  const maxSide = options?.maxSide;
  let size: { width: number; height: number } | undefined;
  if (bytes.byteLength <= limit) {
    if (maxSide === undefined) return { mime, bytes };
    try {
      size = await new Bun.Image(bytes).metadata();
    } catch {
      return { mime, bytes };
    }
    if (Math.max(size.width, size.height) <= maxSide) return { mime, bytes };
  }
  const byteOver = `${name} is ${megabytes(bytes.byteLength)}, over the ${megabytes(limit)} an image may be`;
  if (size === undefined) {
    try {
      size = await new Bun.Image(bytes).metadata();
    } catch (error) {
      throw new Error(
        `${byteOver}, and it could not be decoded to shrink it: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const maxDim = Math.max(size.width, size.height);
  const over =
    bytes.byteLength > limit
      ? byteOver
      : `${name} is ${size.width}x${size.height}, over the ${maxSide} px per side an image may be`;
  const baseScale =
    maxSide !== undefined && maxDim > maxSide ? maxSide / maxDim : 1;
  const out =
    mime === "image/jpeg" || mime === "image/webp" ? mime : "image/png";
  let smallest = bytes.byteLength;
  for (const scale of SHRINK_SCALES) {
    const effectiveScale = baseScale * scale;
    let image = new Bun.Image(bytes);
    if (effectiveScale < 1) {
      const width = Math.max(1, Math.round(size.width * effectiveScale));
      const height = Math.max(1, Math.round(size.height * effectiveScale));
      image = image.resize(
        maxSide === undefined ? width : Math.min(maxSide, width),
        maxSide === undefined ? height : Math.min(maxSide, height),
      );
    }
    const encoded = await (out === "image/jpeg"
      ? image.jpeg({ quality: SHRINK_QUALITY })
      : out === "image/webp"
        ? image.webp({ quality: SHRINK_QUALITY })
        : image.png()
    ).buffer();
    if (encoded.byteLength <= limit) return { mime: out, bytes: encoded };
    smallest = Math.min(smallest, encoded.byteLength);
  }
  throw new Error(
    `${over}, and is still ${megabytes(smallest)} scaled down to ${SHRINK_SCALES.at(-1)! * 100}% of its size`,
  );
}
