import type { ToolActivity } from "@eta/client-contracts";
/**
 * The tool calls of a run, kept short enough to live on the reply's row.
 *
 * The session's transcript holds the whole of every call; the row only has to redraw the card the
 * page showed while the run was going: the name, a line of what it was doing, the head of what it
 * printed, and what the tool left for the page (`details`: `publish_artifact` names its artifact).
 * So long strings are cut, big structures are dropped, and the list itself is bounded.
 */
import type { AgentMessage } from "@eta/core";

/** The longest string kept from a call's arguments, and from a result. */
const MAX_VALUE = 400;
const MAX_OUTPUT = 2000;
/** `details` larger than this (as JSON) is not kept: it was not meant for the page. */
const MAX_DETAILS = 4000;
const MAX_ARGUMENTS = 20;
const MAX_CALLS = 200;

const cut = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

/** The arguments of a call with every long value cut. */
export function shortInput(args: unknown): unknown {
  if (typeof args === "string") return cut(args, MAX_VALUE);
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return args === undefined
      ? undefined
      : cut(JSON.stringify(args), MAX_VALUE);
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, MAX_ARGUMENTS)) {
    kept[key] =
      typeof value === "string"
        ? cut(value, MAX_VALUE)
        : typeof value === "number" ||
            typeof value === "boolean" ||
            value === null
          ? value
          : cut(JSON.stringify(value) ?? "", MAX_VALUE);
  }
  return kept;
}

function shortDetails(details: unknown): unknown {
  if (details === undefined || details === null) return undefined;
  try {
    return JSON.stringify(details).length <= MAX_DETAILS ? details : undefined;
  } catch {
    return undefined;
  }
}

interface Part {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

const partsOf = (message: AgentMessage): Part[] => {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Part[]) : [];
};

/** Reads the run's messages as they end and keeps its tool calls. */
export class ActivityRecorder {
  readonly #calls = new Map<string, ToolActivity>();

  /** A message ended: an assistant one may have made calls, a tool result settles one. */
  see(message: AgentMessage): void {
    if (message.role === "assistant") {
      for (const part of partsOf(message)) {
        if (
          part.type !== "toolCall" ||
          part.id === undefined ||
          this.#calls.has(part.id) ||
          this.#calls.size >= MAX_CALLS
        )
          continue;
        const input = shortInput(part.arguments);
        this.#calls.set(part.id, {
          id: part.id,
          name: part.name ?? "",
          ...(input === undefined ? {} : { input }),
          status: "failed",
        });
      }
    } else if (message.role === "toolResult") {
      const call = this.#calls.get(message.toolCallId);
      if (call === undefined) return;
      const output = partsOf(message)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      const details = shortDetails(message.details);
      call.status = message.isError ? "failed" : "completed";
      if (output !== "") call.output = cut(output, MAX_OUTPUT);
      if (details !== undefined) call.details = details;
    }
  }

  /** The calls in the order they were made; one without a result is `failed`. */
  list(): ToolActivity[] {
    return [...this.#calls.values()];
  }
}
