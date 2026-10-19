/**
 * The session entry union — first-class types, no customType parasites.
 *
 * Ported from eta-agent's harness/session/types.ts (shape-compatible payloads)
 * minus the "custom" escape hatch: anything the system understands gets its
 * own type; plugins that need new entry kinds extend the union, they do not
 * smuggle data through a stringly-typed bucket.
 *
 * Leaf types only: storage, plugins, and the runner all share this vocabulary,
 * so nothing here may import upward.
 */
import type {
  AssistantMessage,
  StopReason,
  Usage,
} from "@earendil-works/pi-ai";
import type { JsonValue } from "./json";
import type { AgentMessage } from "./messages";

/** All first-class entry kinds. New kinds join this union explicitly. */
export type EntryType =
  | "message"
  | "compaction"
  | "branch_summary"
  | "merge"
  | "goal"
  | "ask"
  | "answer"
  | "btw"
  | "run_failed"
  | "interrupt";

export interface EntryBase {
  id: string;
  /** Single-parent lineage; the merge entry carries a second parent. */
  parentId: string | null;
  seq: number;
  timestamp: number;
  type: EntryType;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: AgentMessage;
  /**
   * The run ended here: a tool asked to terminate, so no further assistant
   * request follows this entry (eta-agent's terminate marker).
   */
  terminate?: true;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  /** Whatever the compaction plugin wants to keep alongside the summary. */
  details?: JsonValue;
  usage?: Usage;
}

export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string | null;
  summary: string;
  details?: JsonValue;
  usage?: Usage;
}

export interface MergeEntry extends EntryBase {
  type: "merge";
  /** Second parent: tip of the branch being merged in; its chain joins here. */
  mergedParentId: string;
  summary: string;
  details?: JsonValue;
  usage?: Usage;
}

/** Goal change recorded in the session log; the goal primitive replays these. */
export interface GoalPayload {
  kind: "set" | "pause" | "resume" | "achieved" | "cleared" | "blocked";
  objective?: string;
  reason?: string;
}

export interface GoalEntry extends EntryBase {
  type: "goal";
  payload: GoalPayload;
}

/** ask_user question recorded before waiting for a human. */
export interface AskPayload {
  questionId: string;
  question: string;
  options?: string[];
  multi?: boolean;
}

export interface AskEntry extends EntryBase {
  type: "ask";
  payload: AskPayload;
}

/** The human's backfill for an ask entry. */
export interface AnswerPayload {
  questionId: string;
  answers: string[];
}

export interface AnswerEntry extends EntryBase {
  type: "answer";
  payload: AnswerPayload;
}

/** Visible note left by a side thread (btw). */
export interface BtwPayload {
  note: string;
  sourceEntryId?: string;
}

export interface BtwEntry extends EntryBase {
  type: "btw";
  payload: BtwPayload;
}

/**
 * A run that ended in failure (`model_unavailable`, a provider error…). The
 * failed generation itself is not history — it is never sent back to the model
 * — but the fact that the run failed, and why, is: this system record is what a
 * client that reconnects or reopens the session reads to show it. The entry's
 * `timestamp` is when the failure was recorded. No transcript message is
 * projected from it.
 */
export interface RunFailedPayload {
  runId: string;
  error: string;
}

export interface RunFailedEntry extends EntryBase {
  type: "run_failed";
  payload: RunFailedPayload;
}

/**
 * A generation that was stopped and regenerated (a streaming rule fired). The
 * discarded output is not recorded anywhere; this entry is the fact that it
 * existed, and `source`/`reason` say who stopped it and why. The reminder the
 * interrupt injected is the ordinary message entry that follows. No transcript
 * message is projected from it.
 */
export interface InterruptPayload {
  runId: string;
  turnId: string;
  reason: string;
  source?: string;
  discardedChars: number;
}

export interface InterruptEntry extends EntryBase {
  type: "interrupt";
  payload: InterruptPayload;
}

export type Entry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | MergeEntry
  | GoalEntry
  | AskEntry
  | AnswerEntry
  | BtwEntry
  | RunFailedEntry
  | InterruptEntry;

/** Entry supplied before storage assigns sequence and timestamp. */
export type NewEntry<TEntry extends Entry = Entry> = TEntry extends Entry
  ? Omit<TEntry, "seq" | "timestamp">
  : never;

/** A fully settled assistant message (stopReason resolved). */
export type SettledAssistantMessage = AssistantMessage & {
  stopReason: Exclude<StopReason, "pending">;
};
