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
 * The bytes of an image as a model can be given them: as they are when they fit in `limit`,
 * else decoded, scaled down step by step and re-encoded (jpeg and webp stay what they are; png and
 * gif, which has no encoder, become png) until they do. Throws why when the picture cannot be
 * decoded or does not fit even at the smallest step. Uses the runtime's own `Bun.Image`.
 */
export async function fitImage(
  name: string,
  mime: string,
  bytes: Buffer,
  limit: number,
): Promise<{ mime: string; bytes: Buffer }> {
  if (bytes.byteLength <= limit) return { mime, bytes };
  const over = `${name} is ${megabytes(bytes.byteLength)}, over the ${megabytes(limit)} an image may be`;
  let size: { width: number; height: number };
  try {
    size = await new Bun.Image(bytes).metadata();
  } catch (error) {
    throw new Error(
      `${over}, and it could not be decoded to shrink it: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const out =
    mime === "image/jpeg" || mime === "image/webp" ? mime : "image/png";
  let smallest = bytes.byteLength;
  for (const scale of SHRINK_SCALES) {
    let image = new Bun.Image(bytes);
    if (scale < 1)
      image = image.resize(
        Math.max(1, Math.round(size.width * scale)),
        Math.max(1, Math.round(size.height * scale)),
      );
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
