/**
 * The `memory` target: what the memory sidecar remembers for each agent.
 *
 * It exists only when the host was given a sidecar to talk to, and has no state of its own: the
 * sidecar is the store, so these are plain calls that pass through. An agent's own sessions reach
 * the same memories through its `remember`, `recall` and `forget` tools; this is the user's view
 * of them.
 */
import type { CallFrame } from "@eta/client-wire-proto";

/** How a memory came to be: extracted from a finished turn, or written by the agent or the user. */
export type MemorySource = "conversation" | "agent" | "user";

export interface MemoryView {
  id: string;
  text: string;
  /** Relevance to the query, on search results only. */
  score: number | null;
  /** Epoch milliseconds, when the sidecar recorded it. */
  createdAt: number | null;
  /** Null on memories from before sources were recorded. */
  source: MemorySource | null;
  /** The conversation it was remembered in, when it was. */
  conversationId: string | null;
  /** Set when Captain soft-deleted the memory. */
  deletedAt: number | null;
  /** Who deleted it, when recorded. */
  deletedBy: string | null;
}

export const MEMORY_ACTIONS = [
  "list",
  "remember",
  "forget",
  "restore",
] as const;
export type MemoryAction = (typeof MEMORY_ACTIONS)[number];

export interface MemoryArgs {
  /** Newest first; with a `query`, the ones matching it, best first. */
  list: {
    agentId: string;
    query?: string;
    source?: MemorySource;
    conversationId?: string;
    includeDeleted?: boolean;
  };
  /** The user adds one by hand. */
  remember: { agentId: string; text: string };
  forget: { agentId: string; id: string };
  restore: { agentId: string; id: string };
}
export interface MemoryResults {
  list: { memories: MemoryView[] };
  remember: { memory: MemoryView };
  forget: { id: string };
  restore: { id: string };
}
export type MemoryCall = {
  [A in MemoryAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "memory";
    action: A;
    args: MemoryArgs[A];
  };
}[MemoryAction];
