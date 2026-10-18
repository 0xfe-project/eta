/**
 * Message vocabulary.
 *
 * AgentMessage = pi-ai's LLM Message union, extensible by declaration merging
 * (same shape as eta-agent's types.ts — port of the fork, minus nothing).
 */
import type { Message } from "@earendil-works/pi-ai";

export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  StopReason,
  TextContent,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";

/** Model thinking-level knob, mirrored from the fork. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** A compaction summary standing in for the history it replaced. */
export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/** A branch summary standing in for the branch it replaced. */
export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}

/** Extensible interface for custom app messages (declaration merging). */
export interface CustomAgentMessages {
  compactionSummary: CompactionSummaryMessage;
  branchSummary: BranchSummaryMessage;
}

/** Union of LLM messages + custom messages. */
export type AgentMessage =
  | Message
  | CustomAgentMessages[keyof CustomAgentMessages];
