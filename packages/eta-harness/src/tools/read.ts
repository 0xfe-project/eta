/**
 * read — the file reader (port of eta-agent's `tools/read.ts`).
 *
 * Text comes back with the whole file's shape: an offset, a limit, and a
 * continuation notice that says which lines you got and where to ask next, so a
 * model can walk a large file without guessing. Truncation is a head cut (you
 * want the beginning of a file), bounded by the same limits the shell uses. The
 * funny-looking first-line case — a single line longer than the whole budget —
 * does not get cut silently: the tool says how long the line is and hands over a
 * command that will show it.
 *
 * Images are read by content, not by extension: what the bytes are decides, and
 * a picture comes back as an image block beside a text note. A BMP is refused
 * unless an image processor is injected, because no provider takes one.
 */
import type { ImageContent, TextContent } from "@eta/core";
import type { EnvCallOptions } from "@eta/execution";
import type { TruncationResult } from "@eta/execution/output";
import type { Static } from "typebox";
import type { ImageLimits, ImageProblem } from "../image-limits";
import type { ExecutionToolContext } from "./context";
import type { HarnessTool, ToolResult } from "./tool";
import { getOrThrow } from "@eta/execution";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@eta/execution/output";
import { Type } from "typebox";
import {
  checkBase64Image,
  checkImage,
  DEFAULT_IMAGE_LIMITS,
  describeImageProblem,
} from "../image-limits";
import { detectSupportedImageMimeType, encodeBase64 } from "./image";
import { resolveReadToolPath } from "./path-utils";
import { text } from "./tool";

export const readSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to read (relative or absolute)",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of lines to read" }),
  ),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
  truncation?: TruncationResult | undefined;
}

export type ReadImageProcessorResult =
  | { ok: true; data: string; mimeType: string; hints: string[] }
  | { ok: false; message: string };

/** An optional image conversion (a plugin that can resize or transcode). */
export type ReadImageProcessor = (
  bytes: Uint8Array,
  mimeType: string,
  options: { autoResizeImages: boolean },
) => Promise<ReadImageProcessorResult>;

export interface ReadToolOptions {
  /** Whether an injected image processor should resize. Defaults to true. */
  autoResizeImages?: boolean | undefined;
  imageProcessor?: ReadImageProcessor | undefined;
  /**
   * What the model the session is on will accept. A function, not a value: the
   * session's model can change between two reads, and an image one model takes
   * another refuses. Absent means the conservative default.
   */
  imageLimits?: (() => ImageLimits | undefined) | undefined;
}

export function createReadTool<
  TContext extends ExecutionToolContext = ExecutionToolContext,
>(
  options: ReadToolOptions = {},
): HarnessTool<TContext, typeof readSchema, ReadToolDetails | undefined> {
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    async execute(args, run): Promise<ToolResult<ReadToolDetails | undefined>> {
      const env = run.context.env;
      const call: EnvCallOptions =
        run.call.signal === undefined ? {} : { signal: run.call.signal };
      const absolutePath = await resolveReadToolPath(env, args.path, call);
      const bytes = getOrThrow(await env.readBinaryFile(absolutePath, call));

      const image = await readImage(bytes, options, absolutePath);
      if (image !== undefined) return image;

      const textContent = new TextDecoder().decode(bytes);
      const allLines = textContent.split("\n");
      const totalFileLines = allLines.length;
      const startLine =
        args.offset === undefined ? 0 : Math.max(0, args.offset - 1);
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(
          `Offset ${args.offset} is beyond end of file (${allLines.length} lines total)`,
        );
      }

      let selectedContent: string;
      let userLimitedLines: number | undefined;
      if (args.limit !== undefined) {
        const endLine = Math.min(startLine + args.limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selectedContent);
      let outputText: string;
      let details: ReadToolDetails | undefined;
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(
          new TextEncoder().encode(allLines[startLine]).byteLength,
        );
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${args.path} | head -c ${DEFAULT_MAX_BYTES}]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        outputText +=
          truncation.truncatedBy === "lines"
            ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
            : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        details = { truncation };
      } else if (
        userLimitedLines !== undefined &&
        startLine + userLimitedLines < allLines.length
      ) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }

      return { content: [{ type: "text", text: outputText }], details };
    },
  };
}

/** The image branch, or `undefined` when the bytes are not a supported image. */
async function readImage(
  bytes: Uint8Array,
  options: ReadToolOptions,
  path: string,
): Promise<ToolResult<undefined> | undefined> {
  const mimeType = detectSupportedImageMimeType(bytes);
  if (mimeType === undefined) return undefined;
  const limits = options.imageLimits?.() ?? DEFAULT_IMAGE_LIMITS;

  if (options.imageProcessor !== undefined) {
    const processed = await options.imageProcessor(bytes, mimeType, {
      autoResizeImages: options.autoResizeImages ?? true,
    });
    if (!processed.ok) {
      return text(
        `Read image file [${mimeType}]\n${processed.message}`,
      ) as ToolResult<undefined>;
    }
    // A processor that resized or transcoded changed what is sent, so the
    // limit is asked about its output, not about what was on disk.
    const problem = checkBase64Image(
      processed.data,
      processed.mimeType,
      limits,
    );
    if (problem !== undefined)
      return notAttached(
        processed.data,
        processed.mimeType,
        path,
        problem,
        limits,
      );
    const hints =
      processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
    return {
      content: [
        {
          type: "text",
          text: `Read image file [${processed.mimeType}]${hints}`,
        },
        { type: "image", data: processed.data, mimeType: processed.mimeType },
      ] satisfies (TextContent | ImageContent)[],
      details: undefined,
    };
  }

  if (mimeType === "image/bmp") {
    return text(
      "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]",
    ) as ToolResult<undefined>;
  }
  const problem = checkImage(bytes, mimeType, limits);
  if (problem !== undefined)
    return notAttached(encodeBase64(bytes), mimeType, path, problem, limits);
  return {
    content: [
      { type: "text", text: `Read image file [${mimeType}]` },
      { type: "image", data: encodeBase64(bytes), mimeType },
    ] satisfies (TextContent | ImageContent)[],
    details: undefined,
  };
}

/**
 * An image the model will not take.
 *
 * The picture does not go into the transcript — a request carrying it is
 * refused at the door, and every later request would be refused the same way,
 * so the file is named instead, with what it is and how to get a version the
 * model can see. Saying "no image" and stopping there would leave the model
 * guessing about a file it was just told to read.
 */
function notAttached(
  data: string,
  mimeType: string,
  path: string,
  problem: ImageProblem,
  limits: ImageLimits,
): ToolResult<undefined> {
  return text(
    [
      `Read image file [${mimeType}] — not attached: ${problem.detail}.`,
      `[The image was left out of the transcript on purpose: the provider refuses a request that carries it (HTTP 400), and silent, every later request would fail the same way.`,
      `The file is still at ${path}. Shrink it first — \`sips -Z ${limits.maxSide} "${path}" --out /tmp/shrunk.png\` — or capture a region instead of a full page, then read the smaller file.]`,
      `(${describeImageProblem(mimeType, Math.floor((data.length * 3) / 4), problem)})`,
    ].join(" "),
  ) as ToolResult<undefined>;
}
