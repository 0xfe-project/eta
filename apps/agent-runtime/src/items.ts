// How a Codex thread item (app-server v2) shows in the transcript: a reply's
// text, or an activity with a name, an input and an output, clipped, and the
// one thing it made or touched when its tool says so. The control plane
// projects these views onto message blocks (item.updated).

type Json = Record<string, unknown>;

const KINDS: Record<string, string> = {
  agentMessage: "agent_message",
  commandExecution: "command",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool",
  dynamicToolCall: "tool",
  webSearch: "web_search",
  collabAgentToolCall: "agent",
  imageGeneration: "image",
  contextCompaction: "compaction",
};
const FAILED = new Set(["failed", "declined", "error"]);
// How much of a tool call the transcript shows; the rest stays in Codex.
const DETAIL_CHARS = { name: 100, input: 1000, output: 4000 } as const;
// A longer reply is cut, so every event stays small.
const MESSAGE_CHARS = 100_000;

export interface ItemView {
  id: string;
  kind: string;
  status: "running" | "completed" | "failed";
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  ref?: Json;
}

// Where an MCP tool's result names the one thing it made or touched (a task,
// a routine, a pull request), for the transcript to link to. The control
// plane checks its fields; the runtime knows no plugin.
const REF_META = "axp/ref";

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** The text parts of an MCP result or a dynamic tool's output. */
function texts(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is Json =>
        typeof part === "object" &&
        part !== null &&
        typeof (part as Json).text === "string",
    )
    .map((part) => part.text as string)
    .join("\n");
}

function args(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && Object.keys(value).length === 0) {
    return "";
  }
  return JSON.stringify(value);
}

/** A tool call's name, input and output. */
function detail(kind: string, item: Json): [string, string, string] {
  switch (kind) {
    case "command":
      return ["", str(item.command), str(item.aggregatedOutput)];
    case "file_change": {
      const changes = Array.isArray(item.changes)
        ? (item.changes as Json[])
        : [];
      return [
        "",
        changes.map((c) => str(c.path)).join(", "),
        changes.map((c) => str(c.diff)).join("\n"),
      ];
    }
    case "mcp_tool":
    case "tool": {
      const prefix = str(item.server) || str(item.namespace);
      const name = [prefix, str(item.tool)].filter(Boolean).join(".");
      const output =
        kind === "mcp_tool"
          ? str((item.error as Json | null)?.message) ||
            texts((item.result as Json | null)?.content)
          : texts(item.contentItems);
      return [name, args(item.arguments), output];
    }
    case "web_search":
      return ["", str(item.query), ""];
    case "agent":
      return [str(item.tool), str(item.prompt), ""];
    case "image":
      return ["", str(item.revisedPrompt), ""];
    default:
      return ["", "", ""];
  }
}

/** The item's view, or null for what the transcript does not show (user echoes, reasoning, plans). */
export function itemView(item: Json, completed: boolean): ItemView | null {
  const kind = KINDS[str(item.type)];
  if (kind === undefined) {
    return null;
  }
  const status = FAILED.has(str(item.status))
    ? "failed"
    : completed
      ? "completed"
      : "running";
  const view: ItemView = { id: str(item.id), kind, status };
  if (kind === "agent_message") {
    view.text = str(item.text).slice(0, MESSAGE_CHARS);
    return view;
  }
  const [name, input, output] = detail(kind, item);
  if (name) {
    view.name = name.slice(0, DETAIL_CHARS.name);
  }
  if (input) {
    view.input = input.slice(0, DETAIL_CHARS.input);
  }
  if (output) {
    view.output = output.slice(0, DETAIL_CHARS.output);
  }
  const meta = (item.result as Json | null | undefined)?._meta as
    | Json
    | null
    | undefined;
  const ref = meta?.[REF_META];
  if (
    kind === "mcp_tool" &&
    view.status === "completed" &&
    typeof ref === "object" &&
    ref !== null
  ) {
    view.ref = ref as Json;
  }
  return view;
}

/** A reply's text so far, as its view. */
export function textView(id: string, text: string): ItemView {
  return {
    id,
    kind: "agent_message",
    status: "running",
    text: text.slice(0, MESSAGE_CHARS),
  };
}
