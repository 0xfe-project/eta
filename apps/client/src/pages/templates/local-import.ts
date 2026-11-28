import type { AgentRuntime, ThinkingLevel } from "@eta/client-contracts";
import type { AgentTemplate } from "./template";
import {
  isAgentRuntime,
  isThinkingLevel,
  THINKING_LEVELS,
} from "@eta/client-contracts";
import { parseRoleCard } from "./role-card";

export type LocalBotSourceKind =
  | "role-card"
  | "markdown-agent"
  | "yaml"
  | "json";

export interface ImportedBotDraft {
  sourceKind: LocalBotSourceKind;
  /** Original filename when imported from a file (e.g. `reviewer.md`). */
  filename?: string;
  template: AgentTemplate;
  /** Optional pre-configured agent fields from YAML/JSON or frontmatter. */
  runtime?: AgentRuntime;
  model?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  machineId?: string | null;
  persona?: string;
  plugins?: string[];
}

export type LocalBotParseResult =
  | { ok: true; draft: ImportedBotDraft }
  | { ok: false; error: string };

/** Maximum bytes accepted when reading a local bot file (256 KiB). */
export const LOCAL_BOT_MAX_BYTES = 256 * 1024;

const DEFAULT_CATEGORY = "Local";

const KNOWN_YAML_KEYS = new Set([
  "id",
  "name",
  "note",
  "category",
  "summary",
  "description",
  "owns",
  "doesNotOwn",
  "needsApproval",
  "recommendedPlugins",
  "persona",
  "runtime",
  "model",
  "thinkingLevel",
  "machineId",
  "plugins",
  "instructions",
]);

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

interface FileParts {
  clean?: string;
  basename?: string;
  stem?: string;
  ext: string;
}

function parseFilename(filename?: string): FileParts {
  const clean = filename?.trim();
  if (!clean) return { ext: "" };
  const basename = clean.split(/[/\\]/).pop()?.trim() ?? "";
  if (!basename) return { clean, ext: "" };
  const dot = basename.lastIndexOf(".");
  if (dot > 0) {
    return {
      clean,
      basename,
      stem: basename.slice(0, dot),
      ext: basename.slice(dot).toLowerCase(),
    };
  }
  return { clean, basename, stem: basename, ext: "" };
}

function stemToName(stem: string | undefined): string | undefined {
  if (!stem) return undefined;
  const spaced = stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return undefined;
  if (/^[a-z0-9 ]+$/.test(spaced)) {
    return spaced.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  }
  return spaced;
}

function toLocalId(rawId: string | undefined, fallback: string): string {
  const slug = (rawId?.trim() || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "local-bot";
  return slug.startsWith("local-") ? slug : `local-${slug}`;
}

function deriveSummary(instructions: string): string {
  const firstLine =
    instructions
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const cleaned = firstLine
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .trim();
  if (cleaned.length <= 160) return cleaned;
  return `${cleaned.slice(0, 159).trimEnd()}…`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Minimal zero-dependency YAML subset parser (compatible with agent-file.ts
// output and Claude/Cursor Markdown frontmatter)
// ---------------------------------------------------------------------------

type YamlParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count++;
  return count;
}

function stripInlineComment(raw: string): string {
  for (let i = 0; i < raw.length; i++) {
    if (
      raw[i] === "#" &&
      (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")
    ) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function parseDoubleQuoted(
  raw: string,
  lineNo: number,
): { ok: true; value: string } | { ok: false; error: string } {
  let out = "";
  let i = 1;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') {
      const rest = raw.slice(i + 1).trim();
      if (rest !== "" && !rest.startsWith("#")) {
        return {
          ok: false,
          error: `YAML syntax error on line ${lineNo}: unexpected text after closing quote.`,
        };
      }
      return { ok: true, value: out };
    }
    if (ch === "\\") {
      i++;
      if (i >= raw.length) {
        return {
          ok: false,
          error: `YAML syntax error on line ${lineNo}: unterminated escape sequence.`,
        };
      }
      const esc = raw[i]!;
      switch (esc) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "0":
          out += "\0";
          break;
        case "u": {
          const hex = raw.slice(i + 1, i + 5);
          if (!/^[0-9a-f]{4}$/i.test(hex)) {
            return {
              ok: false,
              error: `YAML syntax error on line ${lineNo}: invalid \\u escape.`,
            };
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          out += esc;
          break;
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return {
    ok: false,
    error: `YAML syntax error on line ${lineNo}: unterminated double-quoted string.`,
  };
}

function parseSingleQuoted(
  raw: string,
  lineNo: number,
): { ok: true; value: string } | { ok: false; error: string } {
  let out = "";
  let i = 1;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "'") {
      if (raw[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      const rest = raw.slice(i + 1).trim();
      if (rest !== "" && !rest.startsWith("#")) {
        return {
          ok: false,
          error: `YAML syntax error on line ${lineNo}: unexpected text after closing quote.`,
        };
      }
      return { ok: true, value: out };
    }
    out += ch;
    i++;
  }
  return {
    ok: false,
    error: `YAML syntax error on line ${lineNo}: unterminated single-quoted string.`,
  };
}

function parseFlowSequence(
  raw: string,
  lineNo: number,
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  // Find matching closing bracket outside quotes.
  let quote: '"' | "'" | null = null;
  let depth = 0;
  let closeIndex = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === '"') {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (raw[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex === -1) {
    return {
      ok: false,
      error: `YAML syntax error on line ${lineNo}: unterminated inline list.`,
    };
  }
  const trailing = raw.slice(closeIndex + 1).trim();
  if (trailing !== "" && !trailing.startsWith("#")) {
    return {
      ok: false,
      error: `YAML syntax error on line ${lineNo}: unexpected text after inline list.`,
    };
  }
  const inner = raw.slice(1, closeIndex).trim();
  if (inner === "") return { ok: true, value: [] };

  const items: unknown[] = [];
  let start = 0;
  quote = null;
  depth = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if (i < inner.length) {
      if (quote === '"') {
        if (ch === "\\") i++;
        else if (ch === '"') quote = null;
        continue;
      }
      if (quote === "'") {
        if (ch === "'") {
          if (inner[i + 1] === "'") i++;
          else quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "[" || ch === "{") {
        depth++;
        continue;
      }
      if (ch === "]" || ch === "}") {
        depth--;
        continue;
      }
      if (ch !== "," || depth > 0) continue;
    }
    const token = inner.slice(start, i).trim();
    start = i + 1;
    if (token === "" && i === inner.length) break;
    const parsed = parseYamlScalar(token, lineNo);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  return { ok: true, value: items };
}

function parseYamlScalar(
  rawInput: string,
  lineNo: number,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const raw = rawInput.trim();
  if (raw === "") return { ok: true, value: null };
  if (raw.startsWith('"')) return parseDoubleQuoted(raw, lineNo);
  if (raw.startsWith("'")) return parseSingleQuoted(raw, lineNo);
  if (raw.startsWith("[")) return parseFlowSequence(raw, lineNo);
  if (raw.startsWith("{")) {
    const withoutComment = stripInlineComment(raw);
    if (!withoutComment.endsWith("}")) {
      return {
        ok: false,
        error: `YAML syntax error on line ${lineNo}: unterminated inline mapping.`,
      };
    }
    try {
      const parsed = JSON.parse(withoutComment) as unknown;
      return { ok: true, value: parsed };
    } catch {
      return { ok: true, value: {} };
    }
  }
  const value = stripInlineComment(raw).trim();
  if (
    value === "" ||
    value === "null" ||
    value === "Null" ||
    value === "NULL" ||
    value === "~"
  ) {
    return { ok: true, value: null };
  }
  if (value === "true" || value === "True" || value === "TRUE") {
    return { ok: true, value: true };
  }
  if (value === "false" || value === "False" || value === "FALSE") {
    return { ok: true, value: false };
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return { ok: true, value: Number(value) };
  }
  return { ok: true, value };
}

interface BlockScalarHeader {
  style: "|" | ">";
  chomp: "clip" | "strip" | "keep";
  explicitIndent?: number;
}

function parseBlockScalarHeader(raw: string): BlockScalarHeader | null {
  const trimmed = stripInlineComment(raw).trim();
  const match = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?$/.exec(trimmed);
  if (!match) return null;
  const style = match[1] as "|" | ">";
  const chompChar = match[2] ?? match[5];
  const indentChar = match[3] ?? match[4];
  const chomp =
    chompChar === "-" ? "strip" : chompChar === "+" ? "keep" : "clip";
  return {
    style,
    chomp,
    ...(indentChar ? { explicitIndent: Number(indentChar) } : {}),
  };
}

function foldBlockLines(lines: readonly string[]): string {
  let out = "";
  let prevWasPlain = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isEmpty = line === "";
    const isMoreIndented =
      line.length > 0 && (line[0] === " " || line[0] === "\t");
    if (i === 0) {
      out = line;
      prevWasPlain = !isEmpty && !isMoreIndented;
      continue;
    }
    if (isEmpty) {
      out += "\n";
      prevWasPlain = false;
    } else if (isMoreIndented) {
      out += `\n${line}`;
      prevWasPlain = false;
    } else if (prevWasPlain) {
      out += ` ${line}`;
      prevWasPlain = true;
    } else {
      // Previous line was empty or more-indented.
      out +=
        lines[i - 1] === "" && i >= 2 && lines[i - 2] !== ""
          ? line
          : `\n${line}`;
      prevWasPlain = true;
    }
  }
  return out;
}

function readBlockScalar(
  lines: readonly string[],
  startIndex: number,
  parentIndent: number,
  header: BlockScalarHeader,
): { value: string; nextIndex: number } {
  const rawLines: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      rawLines.push(line);
      i++;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent <= parentIndent) break;
    rawLines.push(line);
    i++;
  }

  let baseIndent =
    header.explicitIndent !== undefined
      ? parentIndent + header.explicitIndent
      : -1;
  if (baseIndent === -1) {
    for (const line of rawLines) {
      if (line.trim() !== "") {
        baseIndent = leadingSpaces(line);
        break;
      }
    }
  }
  if (baseIndent === -1) {
    // Only blank lines inside the block.
    const emptyValue =
      header.chomp === "keep" ? "\n".repeat(rawLines.length) : "";
    return { value: emptyValue, nextIndex: i };
  }

  const stripped = rawLines.map((line) =>
    line.length <= baseIndent && line.trim() === ""
      ? ""
      : line.slice(Math.min(baseIndent, leadingSpaces(line))),
  );

  let lastContent = stripped.length - 1;
  while (lastContent >= 0 && stripped[lastContent] === "") lastContent--;

  const contentLines = stripped.slice(0, lastContent + 1);
  const trailingBlanks = stripped.length - 1 - lastContent;

  const body =
    header.style === ">"
      ? foldBlockLines(contentLines)
      : contentLines.join("\n");

  if (header.chomp === "strip") return { value: body, nextIndex: i };
  if (header.chomp === "keep") {
    return { value: `${body}\n${"\n".repeat(trailingBlanks)}`, nextIndex: i };
  }
  return { value: `${body}\n`, nextIndex: i };
}

const YAML_KEY_LINE = /^([a-z_][\w-]*)\s*:(?:\s(.*)|[ \t]*)$/i;

function parseTopLevelKey(line: string): { key: string; rest: string } | null {
  if (line.startsWith(" ") || line.startsWith("\t")) return null;
  const match = YAML_KEY_LINE.exec(line);
  if (!match) return null;
  return { key: match[1]!, rest: match[2] ?? "" };
}

function parseYamlMapping(text: string, lineOffset = 0): YamlParseResult {
  const lines = text.split("\n");
  const result: Record<string, unknown> = {};
  let sawKey = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    if (trimmed === "---" && !sawKey) {
      i++;
      continue;
    }
    if (trimmed === "...") {
      break;
    }

    const lineNo = lineOffset + i + 1;
    if (line.startsWith("- ") || trimmed === "-") {
      return {
        ok: false,
        error: `YAML must be a key-value mapping (unexpected list item on line ${lineNo}).`,
      };
    }

    const pair = parseTopLevelKey(line);
    if (!pair) {
      return {
        ok: false,
        error: `YAML syntax error on line ${lineNo}: expected "key: value".`,
      };
    }
    if (Object.hasOwn(result, pair.key)) {
      return {
        ok: false,
        error: `YAML contains duplicate key "${pair.key}" on line ${lineNo}.`,
      };
    }

    sawKey = true;
    const restTrimmed = pair.rest.trim();
    const blockHeader =
      restTrimmed !== "" ? parseBlockScalarHeader(restTrimmed) : null;

    if (blockHeader) {
      const block = readBlockScalar(lines, i + 1, 0, blockHeader);
      result[pair.key] = block.value;
      i = block.nextIndex;
      continue;
    }

    if (restTrimmed === "" || restTrimmed.startsWith("#")) {
      // Look ahead for block sequence or nested mapping.
      let j = i + 1;
      while (j < lines.length) {
        const nextTrimmed = lines[j]!.trim();
        if (nextTrimmed === "" || nextTrimmed.startsWith("#")) {
          j++;
          continue;
        }
        break;
      }

      if (j < lines.length) {
        const nextLine = lines[j]!;
        const nextIndent = leadingSpaces(nextLine);
        const nextAfterIndent = nextLine.slice(nextIndent);
        if (
          nextAfterIndent.startsWith("- ") ||
          nextAfterIndent.trim() === "-"
        ) {
          const items: unknown[] = [];
          const seqIndent = nextIndent;
          while (j < lines.length) {
            const itemLine = lines[j]!;
            const itemTrimmed = itemLine.trim();
            if (itemTrimmed === "" || itemTrimmed.startsWith("#")) {
              j++;
              continue;
            }
            const itemIndent = leadingSpaces(itemLine);
            if (itemIndent < seqIndent) break;
            if (itemIndent > seqIndent) {
              return {
                ok: false,
                error: `YAML syntax error on line ${lineOffset + j + 1}: unexpected indentation inside list "${pair.key}".`,
              };
            }
            const slice = itemLine.slice(seqIndent);
            if (!slice.startsWith("- ") && slice.trim() !== "-") break;
            const rawItem = slice.length > 2 ? slice.slice(2) : "";
            const parsedItem = parseYamlScalar(rawItem, lineOffset + j + 1);
            if (!parsedItem.ok) return parsedItem;
            items.push(parsedItem.value);
            j++;
          }
          result[pair.key] = items;
          i = j;
          continue;
        }

        if (nextIndent > 0) {
          // Consume indented nested object/lines so unknown nested blocks don't fail parsing.
          const nested: Record<string, unknown> = {};
          while (j < lines.length) {
            const subLine = lines[j]!;
            const subTrimmed = subLine.trim();
            if (subTrimmed === "" || subTrimmed.startsWith("#")) {
              j++;
              continue;
            }
            if (leadingSpaces(subLine) === 0) break;
            const subMatch = YAML_KEY_LINE.exec(subTrimmed);
            if (subMatch) {
              const parsedSub = parseYamlScalar(
                subMatch[2] ?? "",
                lineOffset + j + 1,
              );
              if (parsedSub.ok) nested[subMatch[1]!] = parsedSub.value;
            }
            j++;
          }
          result[pair.key] = nested;
          i = j;
          continue;
        }
      }

      result[pair.key] = null;
      i++;
      continue;
    }

    const parsed = parseYamlScalar(restTrimmed, lineNo);
    if (!parsed.ok) return parsed;
    result[pair.key] = parsed.value;
    i++;
  }

  if (!sawKey) {
    return {
      ok: false,
      error: "YAML document does not contain any bot configuration keys.",
    };
  }
  return { ok: true, value: result };
}

// ---------------------------------------------------------------------------
// Shared record -> ImportedBotDraft validator
// ---------------------------------------------------------------------------

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (!Object.hasOwn(record, key) || record[key] === undefined) {
    return { ok: true, value: undefined };
  }
  const value = record[key];
  if (typeof value !== "string") {
    return { ok: false, error: `Field "${key}" must be a string.` };
  }
  return { ok: true, value };
}

function readOptionalStringOrNull(
  record: Record<string, unknown>,
  key: string,
):
  | { ok: true; value: string | null | undefined }
  | { ok: false; error: string } {
  if (!Object.hasOwn(record, key) || record[key] === undefined) {
    return { ok: true, value: undefined };
  }
  const value = record[key];
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: `Field "${key}" must be a string or null.` };
  }
  const trimmed = value.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (!Object.hasOwn(record, key) || record[key] === undefined) {
    return { ok: true, value: undefined };
  }
  const value = record[key];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return {
      ok: false,
      error: `Field "${key}" must be an array of strings.`,
    };
  }
  return { ok: true, value: value.map((item) => item.trim()).filter(Boolean) };
}

function buildDraftFromRecord(
  record: Record<string, unknown>,
  options: {
    sourceKind: LocalBotSourceKind;
    file: FileParts;
    fallbackName?: string;
    instructionsOverride?: string;
  },
): LocalBotParseResult {
  const idRes = readOptionalString(record, "id");
  if (!idRes.ok) return idRes;

  const nameRes = readOptionalString(record, "name");
  if (!nameRes.ok) return nameRes;
  const rawName = nameRes.value?.trim();
  if (nameRes.value !== undefined && !rawName) {
    return { ok: false, error: 'Field "name" must not be empty.' };
  }
  const name = rawName || options.fallbackName || stemToName(options.file.stem);
  if (!name) {
    return {
      ok: false,
      error: 'Missing required field "name" (provide a name or filename).',
    };
  }

  let instructions: string;
  if (options.instructionsOverride !== undefined) {
    instructions = options.instructionsOverride;
  } else {
    const instrRes = readOptionalString(record, "instructions");
    if (!instrRes.ok) return instrRes;
    if (instrRes.value === undefined || instrRes.value.trim() === "") {
      return {
        ok: false,
        error: 'Missing required non-empty field "instructions".',
      };
    }
    instructions = instrRes.value;
  }

  const summaryRes = readOptionalString(record, "summary");
  if (!summaryRes.ok) return summaryRes;
  const descriptionRes = readOptionalString(record, "description");
  if (!descriptionRes.ok) return descriptionRes;
  const summary =
    summaryRes.value?.trim() ||
    descriptionRes.value?.trim() ||
    deriveSummary(instructions);

  const categoryRes = readOptionalString(record, "category");
  if (!categoryRes.ok) return categoryRes;
  const category = categoryRes.value?.trim() || DEFAULT_CATEGORY;

  const noteRes = readOptionalString(record, "note");
  if (!noteRes.ok) return noteRes;
  const note = noteRes.value?.trim();

  const ownsRes = readOptionalStringArray(record, "owns");
  if (!ownsRes.ok) return ownsRes;
  const doesNotOwnRes = readOptionalStringArray(record, "doesNotOwn");
  if (!doesNotOwnRes.ok) return doesNotOwnRes;
  const needsApprovalRes = readOptionalStringArray(record, "needsApproval");
  if (!needsApprovalRes.ok) return needsApprovalRes;
  const recommendedPluginsRes = readOptionalStringArray(
    record,
    "recommendedPlugins",
  );
  if (!recommendedPluginsRes.ok) return recommendedPluginsRes;

  const personaRes = readOptionalString(record, "persona");
  if (!personaRes.ok) return personaRes;

  let runtime: AgentRuntime | undefined;
  if (Object.hasOwn(record, "runtime") && record.runtime !== undefined) {
    if (typeof record.runtime !== "string" || !isAgentRuntime(record.runtime)) {
      return {
        ok: false,
        error: `Invalid "runtime" value "${String(record.runtime)}". Use a supported runtime (e.g. eta, claude, codex, opencode, pi, grok, qwen, or acp.<slug>).`,
      };
    }
    runtime = record.runtime;
  }

  const modelRes = readOptionalStringOrNull(record, "model");
  if (!modelRes.ok) return modelRes;

  let thinkingLevel: ThinkingLevel | null | undefined;
  if (
    Object.hasOwn(record, "thinkingLevel") &&
    record.thinkingLevel !== undefined
  ) {
    const rawLevel = record.thinkingLevel;
    if (rawLevel === null) {
      thinkingLevel = null;
    } else if (typeof rawLevel === "string" && isThinkingLevel(rawLevel)) {
      thinkingLevel = rawLevel;
    } else {
      return {
        ok: false,
        error: `Invalid "thinkingLevel" value "${String(rawLevel)}". Allowed values: ${THINKING_LEVELS.join(", ")}, or null.`,
      };
    }
  }

  const machineIdRes = readOptionalStringOrNull(record, "machineId");
  if (!machineIdRes.ok) return machineIdRes;

  const pluginsRes = readOptionalStringArray(record, "plugins");
  if (!pluginsRes.ok) return pluginsRes;

  const template: AgentTemplate = {
    id: toLocalId(idRes.value, options.file.stem || name),
    name,
    ...(note ? { note } : {}),
    category,
    summary,
    owns: ownsRes.value ?? [],
    doesNotOwn: doesNotOwnRes.value ?? [],
    needsApproval: needsApprovalRes.value ?? [],
    instructions,
    ...(recommendedPluginsRes.value && recommendedPluginsRes.value.length > 0
      ? { recommendedPlugins: recommendedPluginsRes.value }
      : {}),
  };

  return {
    ok: true,
    draft: {
      sourceKind: options.sourceKind,
      ...(options.file.clean ? { filename: options.file.clean } : {}),
      template,
      ...(runtime !== undefined ? { runtime } : {}),
      ...(modelRes.value !== undefined ? { model: modelRes.value } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(machineIdRes.value !== undefined
        ? { machineId: machineIdRes.value }
        : {}),
      ...(personaRes.value !== undefined ? { persona: personaRes.value } : {}),
      ...(pluginsRes.value !== undefined ? { plugins: pluginsRes.value } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Format parsers
// ---------------------------------------------------------------------------

function parseJsonBot(text: string, file: FileParts): LocalBotParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON: ${detail}` };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, error: "JSON bot config must be a plain object." };
  }
  return buildDraftFromRecord(parsed, { sourceKind: "json", file });
}

function parseYamlBot(text: string, file: FileParts): LocalBotParseResult {
  const parsed = parseYamlMapping(text);
  if (!parsed.ok) return parsed;
  return buildDraftFromRecord(parsed.value, { sourceKind: "yaml", file });
}

function tryRoleCard(
  text: string,
  file: FileParts,
): LocalBotParseResult | null {
  const cardInput = text.replace(/^\n+/, "");
  let card: AgentTemplate;
  try {
    card = parseRoleCard(file.basename || "local-bot.md", cardInput);
  } catch {
    return null;
  }
  if (!card.instructions.trim()) {
    return {
      ok: false,
      error: "Role card is missing instructions in its role description block.",
    };
  }
  return {
    ok: true,
    draft: {
      sourceKind: "role-card",
      ...(file.clean ? { filename: file.clean } : {}),
      template: {
        ...card,
        id: toLocalId(file.stem, card.name),
      },
    },
  };
}

interface FrontmatterSplit {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(text: string): FrontmatterSplit | null {
  const lines = text.split("\n");
  if (!/^---[ \t]*$/.test(lines[0] ?? "")) return null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i]!)) {
      return {
        frontmatter: lines.slice(1, i).join("\n"),
        body: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return null;
}

function extractLeadingHeading(
  markdown: string,
): { title: string; rest: string } | null {
  const lines = markdown.split("\n");
  const firstIdx = lines.findIndex((line) => line.trim() !== "");
  if (firstIdx === -1) return null;
  const match = /^#[ \t]+(\S.*)$/.exec(lines[firstIdx]!.trim());
  if (!match) return null;
  const title = match[1]!.replace(/[ \t]+#+$/, "").trim();
  if (!title) return null;
  const rest = lines
    .slice(firstIdx + 1)
    .join("\n")
    .trim();
  return { title, rest };
}

function parseMarkdownBot(text: string, file: FileParts): LocalBotParseResult {
  const split = splitFrontmatter(text);
  if (split) {
    const parsedFm =
      split.frontmatter.trim() === ""
        ? ({ ok: true, value: {} } as const)
        : parseYamlMapping(split.frontmatter, 1);
    if (!parsedFm.ok) return parsedFm;

    const bodyTrimmed = split.body.trim();
    if (!bodyTrimmed) {
      return {
        ok: false,
        error: "Markdown agent has empty instructions after frontmatter.",
      };
    }

    let fallbackName: string | undefined;
    let instructions = bodyTrimmed;
    if (!Object.hasOwn(parsedFm.value, "name")) {
      const heading = extractLeadingHeading(bodyTrimmed);
      if (heading) {
        fallbackName = heading.title;
        if (heading.rest) instructions = heading.rest;
      }
    }

    return buildDraftFromRecord(parsedFm.value, {
      sourceKind: "markdown-agent",
      file,
      fallbackName,
      instructionsOverride: instructions,
    });
  }

  const heading = extractLeadingHeading(text);
  if (heading) {
    if (!heading.rest) {
      return {
        ok: false,
        error: "Markdown bot has a heading but no instructions.",
      };
    }
    return buildDraftFromRecord(
      { name: heading.title, instructions: heading.rest },
      { sourceKind: "markdown-agent", file },
    );
  }

  const fromStem = stemToName(file.stem);
  if (!fromStem) {
    return {
      ok: false,
      error:
        'Could not determine bot name. Add a "# Title" heading, frontmatter, or import from a named file.',
    };
  }
  return buildDraftFromRecord(
    { name: fromStem, instructions: text.trim() },
    { sourceKind: "markdown-agent", file },
  );
}

function looksLikeYaml(text: string): boolean {
  const lines = text.split("\n");
  let firstKey: string | null = null;
  let knownCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed === "---" && firstKey === null) continue;
    if (trimmed === "...") break;
    if (
      line.startsWith(" ") ||
      line.startsWith("\t") ||
      line.startsWith("- ")
    ) {
      if (firstKey === null) return false;
      continue;
    }
    const pair = parseTopLevelKey(line);
    if (!pair) return false;
    if (firstKey === null) firstKey = pair.key;
    if (KNOWN_YAML_KEYS.has(pair.key)) knownCount++;
    const restTrimmed = pair.rest.trim();
    if (restTrimmed !== "" && parseBlockScalarHeader(restTrimmed)) {
      // Skip indented lines belonging to the block scalar.
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() === "" || leadingSpaces(next) > 0) i++;
        else break;
      }
    }
  }

  return firstKey !== null && KNOWN_YAML_KEYS.has(firstKey) && knownCount >= 1;
}

/** Parse a local bot file or pasted text (JSON, YAML, role-card MD, or Claude/Cursor frontmatter/plain MD). */
export function parseLocalBot(
  text: string,
  filename?: string,
): LocalBotParseResult {
  if (utf8ByteLength(text) > LOCAL_BOT_MAX_BYTES) {
    return {
      ok: false,
      error: `Input exceeds maximum allowed size (${LOCAL_BOT_MAX_BYTES / 1024} KiB).`,
    };
  }

  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (normalized.trim() === "") {
    return { ok: false, error: "Input is empty." };
  }

  const file = parseFilename(filename);

  if (file.ext === ".json") {
    return parseJsonBot(normalized, file);
  }
  if (file.ext === ".yaml" || file.ext === ".yml") {
    return parseYamlBot(normalized, file);
  }
  if (file.ext === ".md" || file.ext === ".markdown") {
    return tryRoleCard(normalized, file) ?? parseMarkdownBot(normalized, file);
  }

  // Auto-detect format when pasted without a filename or with a generic extension (.txt, etc.).
  const trimmedStart = normalized.trimStart();
  if (trimmedStart.startsWith("{")) {
    return parseJsonBot(normalized, file);
  }

  const roleCard = tryRoleCard(normalized, file);
  if (roleCard) return roleCard;

  if (splitFrontmatter(normalized)) {
    return parseMarkdownBot(normalized, file);
  }

  if (looksLikeYaml(normalized)) {
    return parseYamlBot(normalized, file);
  }

  return parseMarkdownBot(normalized, file);
}
