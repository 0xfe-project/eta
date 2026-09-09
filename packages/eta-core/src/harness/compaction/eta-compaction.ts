/**
 * Deterministic compaction helpers, ported from the Rust core's compaction.rs.
 * Tool noise gets dropped in whole pairs, the fallback truncation is
 * max-min-fair, and the budget shrinker is what the old code used on
 * input-too-large.
 */

import type { AgentMessage } from "../../types.ts";
import { UNTRUSTED_SUMMARY_NOTE } from "../../prompts/summary.ts";

/** Tool-message share (percent) at which tool noise is dropped from the prefix. */
export const TOOL_MESSAGE_DROP_THRESHOLD = 25;

const MIN_USEFUL_CHARS = 200;

function toolResultIds(messages: AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") ids.add(message.toolCallId);
	}
	return ids;
}

export function toolResultShare(messages: AgentMessage[]): number {
	if (messages.length === 0) return 0;
	const tools = messages.filter((m) => m.role === "toolResult").length;
	return Math.floor((tools * 100) / messages.length);
}

/**
 * Drop tool results from the prefix when they make up at least the threshold
 * share — and only the assistant halves whose every tool call is answered in
 * the same prefix. A pair never lands on opposite sides of the cut.
 */
export function dropToolPairs(messages: AgentMessage[]): AgentMessage[] {
	if (messages.length === 0 || toolResultShare(messages) < TOOL_MESSAGE_DROP_THRESHOLD) return messages;
	const results = toolResultIds(messages);
	return messages.filter((message) => {
		if (message.role === "toolResult") return false;
		if (message.role !== "assistant") return true;
		const calls = message.content.filter((block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall");
		if (calls.length === 0) return true;
		return !calls.every((call) => results.has(call.id));
	});
}

/** Max-min-fair character allocations: small messages cap at their size, leftover redistributes upward. */
export function maxMinFairAllocations(sizes: readonly number[], budget: number): number[] {
	const n = sizes.length;
	if (n === 0) return [];
	const allocs = new Array<number>(n).fill(0);
	const indices = [...Array(n).keys()].sort((a, b) => sizes[a]! - sizes[b]!);
	let remaining = budget;
	let count = n;
	for (const i of indices) {
		const fair = Math.floor(remaining / count);
		const take = Math.min(fair, sizes[i]!);
		allocs[i] = take;
		remaining -= take;
		count -= 1;
	}
	return allocs;
}

function describe(message: AgentMessage): string {
	return JSON.stringify(message);
}

/** Deterministic fallback when the summarizer fails: fair-truncate to a char budget. */
export function truncateFairly(messages: readonly AgentMessage[], charBudget: number): string | undefined {
	const serialized = messages.map(describe);
	const sizes = serialized.map((s) => s.length);
	const allocs = maxMinFairAllocations(sizes, charBudget);
	const parts: string[] = [];
	let kept = 0;
	for (let i = 0; i < serialized.length; i++) {
		const size = sizes[i]!;
		const alloc = allocs[i]!;
		if (alloc >= size) {
			parts.push(serialized[i]!);
			kept += 1;
		} else if (alloc < MIN_USEFUL_CHARS) {
			parts.push(`[omitted message, ${size} chars]`);
		} else {
			parts.push(`${serialized[i]!.slice(0, alloc)}\n[... truncated, ${size} chars]`);
			kept += 1;
		}
	}
	if (kept === 0) return undefined;
	return parts.join("\n\n");
}

/** Fallback summary text: the untrusted note on top of fair-truncated context. */
export function untrustedFallback(messages: readonly AgentMessage[], charBudget: number): string | undefined {
	const body = truncateFairly(messages, charBudget);
	return body === undefined ? undefined : `${UNTRUSTED_SUMMARY_NOTE}\n\n${body}`;
}

/** Shrink the summarization prompt budget on input-too-large: /2, then /3, never below min. */
export function reducePromptBudget(current: number, attempt: number, originalLength: number, min: number): number {
	const divisor = attempt >= 2 ? 3 : 2;
	const next = Math.min(Math.floor(current / divisor), Math.floor((originalLength * 3) / 4));
	return Math.max(next, min);
}
