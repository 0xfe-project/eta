import type { AgentMessage } from "./data";
import type { ViewMessageRow } from "./types";

/**
 * How full a session's context window is, split by where the characters came from.
 *
 * This is the rule the web app's member ring draws (apps/web member-ring.tsx), kept here so every
 * client draws the same ring from the same numbers. What it measures is the conversation the model
 * is sent, not what the session has spent over its life: the transcript from the last compaction
 * on, plus the prompt and the tool definitions. Characters become tokens at four per token, the
 * estimate the panel has always used.
 */

/** The window assumed for a model whose window nobody published. */
export const CONTEXT_FALLBACK_WINDOW = 128_000;

/** Where a slice of the window came from, in the order the ring draws them. */
export type ContextSource =
  | "system"
  | "context"
  | "user"
  | "assistant"
  | "toolDefs"
  | "tool";

export interface ContextSlice {
  source: ContextSource;
  tokens: number;
}

export interface ContextUsage {
  slices: ContextSlice[];
  /** Tokens in the window, all slices together. */
  used: number;
  /** The model's window (or the fallback). */
  window: number;
  /** What the ring is drawn against: never less than what is in it. */
  cap: number;
  /** Used against the real window, so over 100% stays visible; at most 999. */
  percent: number;
  /** When the last compaction summary in the transcript was written, if there is one. */
  compactedAt: number | undefined;
}

/** The characters a message brings into the window. Thinking and tool arguments are sent too. */
export function contextChars(message: AgentMessage): number {
  const candidate = message as { content?: unknown; summary?: unknown };
  if (typeof candidate.summary === "string") return candidate.summary.length;
  if (typeof candidate.content === "string") return candidate.content.length;
  if (!Array.isArray(candidate.content)) return 0;
  let chars = 0;
  for (const block of candidate.content as {
    text?: unknown;
    thinking?: unknown;
    arguments?: unknown;
  }[]) {
    if (typeof block.text === "string") chars += block.text.length;
    if (typeof block.thinking === "string") chars += block.thinking.length;
    if (block.arguments !== undefined)
      chars += JSON.stringify(block.arguments).length;
  }
  return chars;
}

/**
 * Characters by role over the transcript the model is actually sent: from the last compaction
 * summary on. Before that point the conversation exists on disk but not in the window.
 */
export function contextShare(
  messages: readonly ViewMessageRow[],
  tools: readonly { name: string; description: string }[],
): { user: number; assistant: number; tool: number; toolDefs: number } {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.message.role === "compactionSummary") {
      start = index;
      break;
    }
  }
  let user = 0;
  let assistant = 0;
  let tool = 0;
  for (const row of messages.slice(start)) {
    const chars = contextChars(row.message);
    if (row.message.role === "toolResult") tool += chars;
    else if (row.message.role === "user") user += chars;
    else assistant += chars;
  }
  const toolDefs = tools.reduce(
    (sum, one) => sum + one.name.length + one.description.length,
    0,
  );
  return { user, assistant, tool, toolDefs };
}

/** A session's context usage from its view sections and its model's window. */
export function contextUsage(input: {
  messages: readonly ViewMessageRow[];
  tools: readonly { name: string; description: string }[];
  prompt?: { stableChars: number; adaptiveChars: number } | undefined;
  window?: number | undefined;
}): ContextUsage {
  const share = contextShare(input.messages, input.tools);
  const stable = input.prompt?.stableChars ?? 0;
  const adaptive = input.prompt?.adaptiveChars ?? 0;
  const estimate = (chars: number) => Math.round(chars / 4);
  const slices: ContextSlice[] = [
    { source: "system", tokens: estimate(stable) },
    { source: "context", tokens: estimate(Math.max(0, adaptive - stable)) },
    { source: "user", tokens: estimate(share.user) },
    { source: "assistant", tokens: estimate(share.assistant) },
    { source: "toolDefs", tokens: estimate(share.toolDefs) },
    { source: "tool", tokens: estimate(share.tool) },
  ];
  const used = slices.reduce((sum, slice) => sum + slice.tokens, 0);
  const window = input.window ?? CONTEXT_FALLBACK_WINDOW;
  let compactedAt: number | undefined;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const row = input.messages[index];
    if (row?.message.role === "compactionSummary") {
      compactedAt = row.at;
      break;
    }
  }
  return {
    slices,
    used,
    window,
    cap: Math.max(window, used, 1),
    percent: Math.min(999, Math.round((used / Math.max(window, 1)) * 100)),
    compactedAt,
  };
}

/**
 * Where each slice sits on a ring of this circumference: its dash length and its offset from the
 * start. A slice no longer than the gap between slices is nothing but gap, so it is left out.
 */
export function contextRingDashes(
  usage: Pick<ContextUsage, "slices" | "cap">,
  circumference: number,
  gap: number,
): { source: ContextSource; tokens: number; dash: number; at: number }[] {
  let offset = 0;
  const dashes: {
    source: ContextSource;
    tokens: number;
    dash: number;
    at: number;
  }[] = [];
  for (const slice of usage.slices) {
    const length = (slice.tokens / usage.cap) * circumference;
    const at = offset;
    offset += length;
    if (length > gap) dashes.push({ ...slice, dash: length - gap, at });
  }
  return dashes;
}
