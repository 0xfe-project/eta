/**
 * The YAML file `/agent` hands the editor: the agent's editable fields written out, and the
 * saved file read back into fields or into every problem it has.
 */
import type {
  AgentRuntime,
  AgentView,
  ThinkingLevel,
} from "@eta/client-contracts";
import type { Scalar, YAMLError } from "yaml";
import { AGENT_RUNTIMES } from "@eta/client-contracts";
import { Document, isMap, isScalar, LineCounter, parseDocument } from "yaml";

/** The keys of the file, in the order it lists them. */
export const AGENT_KEYS = [
  "name",
  "persona",
  "runtime",
  "model",
  "thinkingLevel",
  "machineId",
  "plugins",
  "instructions",
] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

const THINKING_LEVEL_SET = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} satisfies Record<ThinkingLevel, true>;

/** Every thinking level, in the host's order. */
export const THINKING_LEVELS = Object.keys(
  THINKING_LEVEL_SET,
) as readonly ThinkingLevel[];

/** What the file edits of an agent. */
export interface AgentFields {
  name: string;
  persona: string;
  runtime: AgentRuntime;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  machineId: string | null;
  plugins: string[];
  instructions: string;
}

export type ExpectedType = "text" | "text-or-null" | "list-of-text";

/** One thing wrong with a saved file. */
export type FileProblem =
  /** The YAML does not parse; `message` is the parser's, in English. */
  | { kind: "syntax"; line: number; column: number; message: string }
  | { kind: "duplicate-key"; key: string; line: number; column: number }
  | { kind: "not-a-mapping" }
  | { kind: "unknown-key"; key: string }
  | { kind: "missing-name" }
  | { kind: "blank-name" }
  | { kind: "wrong-type"; key: AgentKey; expected: ExpectedType }
  | { kind: "unknown-runtime"; value: string }
  | { kind: "unknown-thinking-level"; value: string }
  | { kind: "model-format"; value: string }
  | { kind: "model-runtime"; value: string; runtime: AgentRuntime };

/** A key missing from the file is missing from `fields`: the agent keeps that value. */
export type ReadResult =
  | { fields: Partial<AgentFields> }
  | { problems: FileProblem[] };

export function agentFields(agent: AgentView): AgentFields {
  return {
    name: agent.name,
    persona: agent.persona,
    runtime: agent.runtime,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    machineId: agent.machineId,
    plugins: [...agent.plugins],
    instructions: agent.instructions,
  };
}

/** The file for `fields`, under `header` written as comment lines. */
export function writeAgentFile(
  fields: AgentFields,
  header: readonly string[],
): string {
  const ordered = Object.fromEntries(
    AGENT_KEYS.map((key) => [key, fields[key]]),
  );
  const doc = new Document(ordered);
  if (fields.instructions.includes("\n")) {
    const instructions = doc.get("instructions", true) as Scalar;
    instructions.type = "BLOCK_LITERAL";
  }
  const body = doc.toString({ lineWidth: 0 });
  if (header.length === 0) return body;
  const comments = header
    .flatMap((line) => line.split(/\r?\n/))
    .map((line) => (line === "" ? "#" : `# ${line}`));
  return `${comments.join("\n")}\n\n${body}`;
}

function isAgentKey(key: string): key is AgentKey {
  return (AGENT_KEYS as readonly string[]).includes(key);
}

function isRuntime(value: string): value is AgentRuntime {
  return (AGENT_RUNTIMES as readonly string[]).includes(value);
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return Object.hasOwn(THINKING_LEVEL_SET, value);
}

/** The top-level key that starts at `offset` of `text`; the parser's error only gives its start. */
function keyAt(text: string, offset: number): string {
  const doc = parseDocument(text, { uniqueKeys: false });
  if (isMap(doc.contents))
    for (const { key } of doc.contents.items)
      if (isScalar(key) && key.range?.[0] === offset) return String(key.value);
  return text.slice(offset).split(/[:\n]/, 1)[0]?.trim() ?? "";
}

function parseProblem(
  error: YAMLError,
  text: string,
  lines: LineCounter,
): FileProblem {
  const { line, col } = lines.linePos(error.pos[0]);
  if (error.code === "DUPLICATE_KEY")
    return {
      kind: "duplicate-key",
      key: keyAt(text, error.pos[0]),
      line,
      column: col,
    };
  return { kind: "syntax", line, column: col, message: error.message };
}

/** The fields of the saved `text`, checked as far as can be without the host. */
export function readAgentFile(text: string, baseline: AgentFields): ReadResult {
  const lines = new LineCounter();
  const doc = parseDocument(text, { prettyErrors: false, lineCounter: lines });
  if (doc.errors.length > 0)
    return { problems: doc.errors.map((e) => parseProblem(e, text, lines)) };
  if (!isMap(doc.contents)) return { problems: [{ kind: "not-a-mapping" }] };

  const plain = doc.toJS() as Record<string, unknown>;
  const values = new Map<string, unknown>();
  const problems: FileProblem[] = [];
  for (const pair of doc.contents.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (isAgentKey(key)) values.set(key, plain[key]);
    else problems.push({ kind: "unknown-key", key });
  }

  const { fields, problems: fieldProblems } = checkFields(values, baseline);
  problems.push(...fieldProblems);
  return problems.length > 0 ? { problems } : { fields };
}

function checkFields(
  values: ReadonlyMap<string, unknown>,
  baseline: AgentFields,
): { fields: Partial<AgentFields>; problems: FileProblem[] } {
  const fields: Partial<AgentFields> = {};
  const problems: FileProblem[] = [];
  const wrongType = (key: AgentKey, expected: ExpectedType) =>
    problems.push({ kind: "wrong-type", key, expected });

  const text = (key: AgentKey): string | undefined => {
    if (!values.has(key)) return undefined;
    const value = values.get(key);
    if (typeof value === "string") return value;
    wrongType(key, "text");
    return undefined;
  };
  const textOrNull = (key: AgentKey): string | null | undefined => {
    if (!values.has(key)) return undefined;
    const value = values.get(key);
    if (value === null || typeof value === "string") return value;
    wrongType(key, "text-or-null");
    return undefined;
  };

  if (!values.has("name")) problems.push({ kind: "missing-name" });
  const name = text("name");
  if (name !== undefined) {
    if (name.trim() === "") problems.push({ kind: "blank-name" });
    else fields.name = name.trim();
  }

  const persona = text("persona");
  if (persona !== undefined) fields.persona = persona;

  const instructions = text("instructions");
  if (instructions !== undefined) fields.instructions = instructions;

  const runtime = text("runtime");
  if (runtime !== undefined) {
    if (isRuntime(runtime)) fields.runtime = runtime;
    else problems.push({ kind: "unknown-runtime", value: runtime });
  }

  const model = textOrNull("model");
  if (model !== undefined) {
    const modelRuntime = fields.runtime ?? baseline.runtime;
    if (model === null) fields.model = null;
    else if (!model.includes(":"))
      problems.push({ kind: "model-format", value: model });
    else if (
      modelRuntime !== "eta" &&
      model.slice(0, model.indexOf(":")) !== modelRuntime
    )
      problems.push({
        kind: "model-runtime",
        value: model,
        runtime: modelRuntime,
      });
    else fields.model = model;
  }

  const level = textOrNull("thinkingLevel");
  if (level !== undefined) {
    if (level === null) fields.thinkingLevel = null;
    else if (isThinkingLevel(level)) fields.thinkingLevel = level;
    else problems.push({ kind: "unknown-thinking-level", value: level });
  }

  const machineId = textOrNull("machineId");
  if (machineId !== undefined) fields.machineId = machineId;

  if (values.has("plugins")) {
    const plugins = values.get("plugins");
    if (
      Array.isArray(plugins) &&
      plugins.every((plugin) => typeof plugin === "string")
    )
      fields.plugins = plugins;
    else wrongType("plugins", "list-of-text");
  }

  return { fields, problems };
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((name) => right.has(name));
}

/**
 * The fields of `edited` whose values differ from `baseline`; plugins compare as a set. A new
 * runtime brings the file's model with it, changed or not.
 */
export function changedFields(
  edited: Partial<AgentFields>,
  baseline: AgentFields,
): Partial<AgentFields> {
  const changed: Record<string, unknown> = {};
  for (const key of AGENT_KEYS) {
    const value = edited[key];
    if (value === undefined) continue;
    const before = baseline[key];
    const same =
      Array.isArray(value) && Array.isArray(before)
        ? sameNames(value, before)
        : value === before;
    if (!same) changed[key] = value;
  }
  // The host clears the model of an agent that moves to another runtime unless the move names
  // one, so a model the file still holds goes with a new runtime.
  if ("runtime" in changed && edited.model !== undefined)
    changed.model = edited.model;
  return changed as Partial<AgentFields>;
}
