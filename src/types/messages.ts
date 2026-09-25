/**
 * Message vocabulary.
 *
 * AgentMessage = pi-ai's LLM Message union, extensible by declaration merging
 * (same shape as eta-agent's types.ts — port of the fork, minus nothing).
 */
import type { Message } from "@earendil-works/pi-ai";

export type { Api, AssistantMessage, Message, Model, StopReason, Tool, ToolCall, Usage } from "@earendil-works/pi-ai";

/** Model thinking-level knob, mirrored from the fork. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Extensible interface for custom app messages (declaration merging). */
export interface CustomAgentMessages {
	// Empty by default — apps extend via declaration merging.
}

/** Union of LLM messages + custom messages. */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
