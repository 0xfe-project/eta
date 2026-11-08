import type { ReactNode } from "react";
import type { TranscriptItem } from "../contract";
import type { ToolBlock } from "../model/run";
import type { FilePatch, PlanItem, ToolShape } from "../model/tool-shape";
import type { DrawContext, DrawnItem } from "./context";
import type { Lines } from "./lines";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import {
  colorizeCode,
  languageForPath,
} from "../../../ui/gemini/code-colorizer";
import { DiffRenderer } from "../../../ui/gemini/diff-renderer";
import {
  exitCodeOf,
  fullOutputOf,
  patchCounts,
  shapeOf,
} from "../model/tool-shape";
import {
  concat,
  draw,
  indent,
  MARK_WIDTH,
  NO_LINES,
  slice,
  trimBlank,
} from "./lines";
import { Prefixed } from "./prefixed";
import { countLines, imageLabel, linesLabel, terminalText } from "./text";
import { summarizeArgs } from "./tool-summary";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/**
 * What a program printed, not drawn yet: its lines without the blank ones at either end, and how
 * many rows each wraps to at `width` columns by its display width. Only the rows that show are
 * drawn, so a long output folded costs what its preview costs.
 */
interface Printed {
  kind: "printed";
  lines: string[];
  rows: number[];
  color: string | undefined;
  width: number;
}

/** A tool call as its shape draws it: the title after the status mark, and what goes under. */
interface ToolDrawing {
  title: ReactNode;
  /** Folds to `previewLines` lines. */
  body: Lines | Printed;
  /** Drawn after the body, folded or not. */
  after: Lines;
  source: string;
}

const PLAN_BOXES: Readonly<Record<string, string>> = {
  completed: "[x]",
  in_progress: "[~]",
};

/**
 * A tool call: the status mark and a title by the shape of the call, the body indented under it
 * (folded to `previewLines` lines unless unfolded), where the whole output went when the host cut
 * it, and the pictures the result carried.
 */
export function drawTool(item: ToolItem, context: DrawContext): DrawnItem {
  const { tool } = item;
  const bodyWidth = context.width - MARK_WIDTH;
  const shape = shapeOf(tool);
  const drawing = drawShape(shape, item, context, bodyWidth);
  const [mark, markColor] = statusMark(tool, context);
  const title = draw(
    <Prefixed mark={mark} markColor={markColor}>
      {drawing.title}
    </Prefixed>,
    context.width,
  );
  const liveTail = shape.kind === "command" && tool.status === "running";
  const body =
    "kind" in drawing.body
      ? foldPrinted(drawing.body, context, liveTail)
      : foldBody(drawing.body, context, bodyWidth, liveTail);
  const notes = concat(
    drawing.after,
    fullOutputNote(tool, context, bodyWidth),
    imageNotes(tool, context, bodyWidth),
  );
  return {
    lines: concat(title, indent(concat(body, notes), MARK_WIDTH)),
    source: drawing.source,
    foldable: bodyRows(drawing.body) > context.previewLines,
  };
}

function statusMark(
  tool: ToolBlock,
  context: DrawContext,
): [string, string | undefined] {
  if (tool.status === "running") return ["…", context.colors.muted];
  if (tool.status === "failed") return ["✗", context.colors.error];
  return ["✓", context.colors.success];
}

function drawShape(
  shape: ToolShape,
  item: ToolItem,
  context: DrawContext,
  width: number,
): ToolDrawing {
  switch (shape.kind) {
    case "command":
      return drawCommand(shape.command, item, context, width);
    case "patch":
      return drawPatch(shape.files, item.tool, context, width);
    case "write":
      return drawWrite(shape.path, shape.content, context, width);
    case "plan":
      return drawPlan(shape.items, context, width);
    case "other":
      return drawOther(item.tool, context, width);
  }
}

function drawCommand(
  command: string,
  item: ToolItem,
  context: DrawContext,
  width: number,
): ToolDrawing {
  const { tool } = item;
  const [firstLine = ""] = command.split("\n");
  const cut = command.includes("\n") ? " …" : "";
  const exitCode = exitCodeOf(tool);
  const failedExit =
    typeof exitCode === "number" && exitCode !== 0 ? ` (exit ${exitCode})` : "";
  const output = terminalText(
    tool.status === "running" ? (item.progress ?? "") : (tool.output ?? ""),
  );
  return {
    title: (
      <Text wrap="wrap" color={context.colors.text}>
        {`$ ${firstLine}${cut}`}
        <Text color={context.colors.error}>{failedExit}</Text>
      </Text>
    ),
    body: printedOutput(output, context.colors.text, width),
    after: NO_LINES,
    source: `${command}\n${output}`,
  };
}

function drawPatch(
  files: FilePatch[],
  tool: ToolBlock,
  context: DrawContext,
  width: number,
): ToolDrawing {
  const [first, ...rest] = files;
  const header = (file: FilePatch | undefined) => {
    const { added, removed } = patchCounts(file === undefined ? [] : [file]);
    return `± ${file?.path ?? ""} +${added} −${removed}`;
  };
  const diff = (file: FilePatch) =>
    draw(
      <DiffRenderer
        diff={file.patch}
        filename={file.path}
        width={width}
        palette={context.palette}
      />,
      width,
    );
  const body = concat(
    ...(first === undefined ? [] : [diff(first)]),
    ...rest.flatMap((file) => [
      draw(
        <Text wrap="wrap" color={context.colors.text}>
          {header(file)}
        </Text>,
        width,
      ),
      diff(file),
    ]),
  );
  const output = terminalText(tool.output ?? "");
  const failure =
    tool.status === "failed" && output.trim() !== ""
      ? outputLines(output, context.colors.error, width)
      : NO_LINES;
  return {
    title: (
      <Text wrap="wrap" color={context.colors.text}>
        {header(first)}
      </Text>
    ),
    body,
    after: failure,
    source: files.map((file) => file.patch).join("\n"),
  };
}

function drawWrite(
  path: string,
  content: string,
  context: DrawContext,
  width: number,
): ToolDrawing {
  const { t } = context;
  const body =
    content === ""
      ? NO_LINES
      : trimBlank(
          draw(
            colorizeCode({
              code: content,
              language: languageForPath(path),
              width,
              defaultColor: context.colors.text,
            }),
            width,
          ),
        );
  return {
    title: (
      <Text wrap="wrap" color={context.colors.text}>
        {`✎ ${path} · ${linesLabel(countLines(content), t)}`}
      </Text>
    ),
    body,
    after: NO_LINES,
    source: content,
  };
}

function drawPlan(
  items: PlanItem[],
  context: DrawContext,
  width: number,
): ToolDrawing {
  const body = draw(
    <Box flexDirection="column">
      {items.map((step, index) => (
        // Steps never reorder within one call, so the index names each.
        // eslint-disable-next-line react/no-array-index-key
        <Text key={index} wrap="wrap" color={context.colors.text}>
          {`${PLAN_BOXES[step.status] ?? "[ ]"} ${step.content}`}
        </Text>
      ))}
    </Box>,
    width,
  );
  return {
    title: <Text color={context.colors.text}>{context.t("plan")}</Text>,
    body,
    after: NO_LINES,
    source: items.map((step) => step.content).join("\n"),
  };
}

function drawOther(
  tool: ToolBlock,
  context: DrawContext,
  width: number,
): ToolDrawing {
  const summary = summarizeArgs(tool.input);
  const output = terminalText(tool.output ?? "");
  return {
    title: (
      <Text wrap="wrap" color={context.colors.text}>
        {summary === "" ? tool.name : `${tool.name} ${summary}`}
      </Text>
    ),
    body: printedOutput(output, context.colors.text, width),
    after: NO_LINES,
    source: `${tool.name}\n${JSON.stringify(tool.input ?? null, null, 2)}\n${output}`,
  };
}

function outputLines(
  output: string,
  color: string | undefined,
  width: number,
): Lines {
  if (output.trim() === "") return NO_LINES;
  return trimBlank(
    draw(
      <Text wrap="wrap" color={color}>
        {output}
      </Text>,
      width,
    ),
  );
}

function printedOutput(
  output: string,
  color: string | undefined,
  width: number,
): Printed {
  const lines = output.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  const kept = lines.slice(start, end);
  return {
    kind: "printed",
    lines: kept,
    rows: kept.map((line) =>
      Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, width))),
    ),
    color,
    width,
  };
}

/** Lines `from` to `to` (not included) of what a program printed, drawn and wrapped. */
function drawPrinted(printed: Printed, from: number, to: number): Lines {
  if (from >= to) return NO_LINES;
  return draw(
    <Text wrap="wrap" color={printed.color}>
      {printed.lines.slice(from, to).join("\n")}
    </Text>,
    printed.width,
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function bodyRows(body: Lines | Printed): number {
  return "kind" in body ? sum(body.rows) : body.plain.length;
}

/**
 * What a program printed as it shows: whole when unfolded or short enough; folded, the first
 * `previewLines` rows, or the last ones for a command still printing, and a line counting the
 * rest. Only the printed lines that reach those rows are drawn; the rest are counted by width.
 */
function foldPrinted(
  printed: Printed,
  context: DrawContext,
  liveTail: boolean,
): Lines {
  const { previewLines } = context;
  const count = printed.lines.length;
  if (context.expanded || sum(printed.rows) <= previewLines)
    return drawPrinted(printed, 0, count);
  if (liveTail) {
    let from = count;
    let rows = 0;
    while (from > 0 && rows < previewLines) rows += printed.rows[--from]!;
    const drawn = drawPrinted(printed, from, count);
    const cut = Math.max(0, drawn.plain.length - previewLines);
    const hidden = sum(printed.rows.slice(0, from)) + cut;
    return concat(moreLine(hidden, context, printed.width), slice(drawn, cut));
  }
  let to = 0;
  let rows = 0;
  while (to < count && rows < previewLines) rows += printed.rows[to++]!;
  const drawn = drawPrinted(printed, 0, to);
  const shown = Math.min(previewLines, drawn.plain.length);
  const hidden = drawn.plain.length - shown + sum(printed.rows.slice(to));
  return concat(
    slice(drawn, 0, shown),
    moreLine(hidden, context, printed.width),
  );
}

/** "… N more lines", muted; nothing when no line is hidden. */
function moreLine(hidden: number, context: DrawContext, width: number): Lines {
  if (hidden <= 0) return NO_LINES;
  const { t } = context;
  return draw(
    <Text wrap="wrap" color={context.colors.muted}>
      {hidden === 1 ? t("moreLine") : t("moreLines", { count: hidden })}
    </Text>,
    width,
  );
}

/**
 * The body as it shows: whole when unfolded or short enough; folded, its first `previewLines`
 * lines, or its last ones for a command still printing, and a line counting the rest.
 */
function foldBody(
  body: Lines,
  context: DrawContext,
  width: number,
  liveTail: boolean,
): Lines {
  const { previewLines } = context;
  const hidden = body.plain.length - previewLines;
  if (context.expanded || hidden <= 0) return body;
  const more = moreLine(hidden, context, width);
  return liveTail
    ? concat(more, slice(body, hidden))
    : concat(slice(body, 0, previewLines), more);
}

function fullOutputNote(
  tool: ToolBlock,
  context: DrawContext,
  width: number,
): Lines {
  const path = fullOutputOf(tool);
  if (path === undefined || path === "") return NO_LINES;
  return draw(
    <Text wrap="wrap" color={context.colors.muted}>
      {context.t("fullOutput", { path })}
    </Text>,
    width,
  );
}

function imageNotes(
  tool: ToolBlock,
  context: DrawContext,
  width: number,
): Lines {
  const images = tool.images ?? [];
  if (images.length === 0) return NO_LINES;
  const path = pathArgument(tool.input);
  const suffix = path === undefined ? "" : ` · ${path}`;
  return draw(
    <Box flexDirection="column">
      {images.map((image) => (
        <Text
          key={`${image.entryId}-${image.index}`}
          wrap="wrap"
          color={context.colors.muted}
        >
          {`${imageLabel(image, context.t)}${suffix}`}
        </Text>
      ))}
    </Box>,
    width,
  );
}

/** The file a call named, by `file_path` or `path`. */
function pathArgument(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { file_path: filePath, path } = input as Record<string, unknown>;
  if (typeof filePath === "string" && filePath !== "") return filePath;
  return typeof path === "string" && path !== "" ? path : undefined;
}
