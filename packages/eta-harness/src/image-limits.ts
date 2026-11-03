/**
 * What a model will actually take as an image.
 *
 * A provider refuses an image it cannot handle the same way it refuses a
 * malformed request: HTTP 400, before the stream starts, on every request that
 * carries it. One `read` of a full-page screenshot is enough to wedge a session
 * for good — the bytes are in the journal, every later request rebuilds them,
 * and nothing the user types gets past it. So the limit has to be known before
 * the bytes enter the transcript, not discovered when they are refused.
 *
 * Measured against DeepSeek (2026-10-27): 1280×8192 and 4000×4000 are accepted;
 * 1280×8193 and 8200×100 are refused. It is a cap on each side, not on the
 * pixel count (8.2k×100 is 820 000 pixels and still fails) and not on the bytes
 * (a 2 MB PNG goes through). The table below carries what was measured or is
 * documented; everything else falls back to the default, which errs small on
 * purpose — a false "too big" costs a text note, a false "fine" costs the
 * session.
 *
 * Nothing here decodes a picture: dimensions are read from the header, because
 * the header is what decides.
 */
import { base64ByteLength, decodeBase64, readImageSize } from "./tools/image";

export interface ImageLimits {
  /** Largest accepted width or height, in pixels. */
  maxSide: number;
  /** Largest accepted payload, measured on the decoded bytes. */
  maxBytes: number;
  /** Container formats the model decodes. */
  mimeTypes: readonly string[];
}

/** The fallback: the narrowest limits any provider in reach has been seen to take. */
export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxSide: 8192,
  maxBytes: 5 * 1024 * 1024,
  mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
};

/** Keyed by provider id and by the first word of a model id (`deepseek-flash`). */
const BY_NAME: Record<string, Partial<ImageLimits>> = {
  // Measured: 1280×8192 accepted, 1280×8193 refused.
  deepseek: { maxSide: 8192 },
  // Documented: 8000×8000 per image, 5 MB.
  anthropic: { maxSide: 8000, maxBytes: 5 * 1024 * 1024 },
  claude: { maxSide: 8000, maxBytes: 5 * 1024 * 1024 },
};

/** How much of an image is decoded to find its header — enough for a long EXIF block. */
const HEADER_BYTES = 64 * 1024;

/**
 * The limits for a model, or the default when nothing is known about it.
 *
 * The provider id is what the configuration says the bytes travel through; the
 * model id is what the provider will actually decode. Either can match.
 */
export function imageLimitsFor(
  model:
    | { provider?: string | undefined; modelId?: string | undefined }
    | undefined,
): ImageLimits {
  const names = [
    model?.provider,
    model?.modelId === undefined
      ? undefined
      : model.modelId.split(/[-_.:/]/)[0],
  ];
  for (const name of names) {
    if (name === undefined || name.length === 0) continue;
    const override = BY_NAME[name.toLowerCase()];
    if (override !== undefined) return { ...DEFAULT_IMAGE_LIMITS, ...override };
  }
  return DEFAULT_IMAGE_LIMITS;
}

/** Why an image cannot go into a request. */
export interface ImageProblem {
  code: "mime" | "side" | "bytes";
  /** One clause a person can read, e.g. "1280×11024 is over the 8192 px per side". */
  detail: string;
}

/** Whether these bytes can go into a request, and why not when they cannot. */
export function checkImage(
  bytes: Uint8Array,
  mimeType: string,
  limits: ImageLimits,
): ImageProblem | undefined {
  return verdict(mimeType, bytes.byteLength, readImageSize(bytes), limits);
}

/**
 * The same question for an image the history holds as base64.
 *
 * Only the head is decoded: a dimension is in the header, and a history can
 * hold megabytes that nothing here needs to see.
 */
export function checkBase64Image(
  data: string,
  mimeType: string,
  limits: ImageLimits,
): ImageProblem | undefined {
  const size = readImageSize(decodeBase64(data, HEADER_BYTES));
  return verdict(mimeType, base64ByteLength(data), size, limits);
}

function verdict(
  mimeType: string,
  byteLength: number,
  size: { width: number; height: number } | undefined,
  limits: ImageLimits,
): ImageProblem | undefined {
  if (!limits.mimeTypes.includes(mimeType))
    return {
      code: "mime",
      detail: `${mimeType} is not a format this model decodes (${limits.mimeTypes.join(", ")})`,
    };
  if (byteLength > limits.maxBytes)
    return {
      code: "bytes",
      detail: `${formatSize(byteLength)} is over the ${formatSize(limits.maxBytes)} this model accepts`,
    };
  // An unreadable header is not evidence of a broken image: the repair rules
  // only on what it can see, and refuses to guess.
  if (size === undefined) return undefined;
  if (Math.max(size.width, size.height) > limits.maxSide)
    return {
      code: "side",
      detail: `${size.width}×${size.height} is over the ${limits.maxSide} px per side this model accepts`,
    };
  return undefined;
}

/** One line for a log or a placeholder: what an image was, and why it went. */
export function describeImageProblem(
  mimeType: string,
  bytes: number,
  problem: ImageProblem,
): string {
  return `${mimeType}, ${formatSize(bytes)} — ${problem.detail}`;
}

/** A byte count as a person reads it: `512B`, `1.5KB`, `3.2MB`. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
