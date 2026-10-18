/**
 * Deterministic helpers (ported from eta-agent's compaction/eta-compaction.ts,
 * itself a port of the Rust core's compaction.rs).
 *
 * These are the paths that do not ask a model: dropping tool noise from a
 * prefix, and — when the summarizer cannot answer — digesting the context
 * mechanically, max-min-fair, so no single large message can crowd out every
 * other one.
 *
 * `reducePromptBudget` was not ported: nothing in eta-agent called it except
 * its own test.
 */
import type { AgentMessage } from "@eta/core";
import { UNTRUSTED_SUMMARY_NOTE } from "./prompts";

/** Tool-message share (percent) at which tool noise is dropped from the prefix. */
export const TOOL_MESSAGE_DROP_THRESHOLD = 25;

const MIN_USEFUL_CHARS = 200;

function toolResultIds(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") ids.add((message as { toolCallId: string }).toolCallId);
	}
	return ids;
}

export function toolResultShare(messages: readonly AgentMessage[]): number {
	if (messages.length === 0) return 0;
	const tools = messages.filter((message) => message.role === "toolResult").length;
	return Math.floor((tools * 100) / messages.length);
}

/**
 * Drop tool results from the prefix when they make up at least the threshold
 * share — and only the assistant halves whose every tool call is answered in
 * the same prefix. A pair never lands on opposite sides of the cut.
 */
export function dropToolPairs(messages: readonly AgentMessage[]): AgentMessage[] {
	if (messages.length === 0 || toolResultShare(messages) < TOOL_MESSAGE_DROP_THRESHOLD) return [...messages];
	const results = toolResultIds(messages);
	return messages.filter((message) => {
		if (message.role === "toolResult") return false;
		if (message.role !== "assistant") return true;
		const content = (message as { content: { type: string; id?: string }[] }).content;
		const calls = content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) return true;
		return !calls.every((call) => results.has(call.id ?? ""));
	});
}

/** Max-min-fair character allocations: small messages cap at their size, leftover redistributes upward. */
export function maxMinFairAllocations(sizes: readonly number[], budget: number): number[] {
	const n = sizes.length;
	if (n === 0) return [];
	const allocations = new Array<number>(n).fill(0);
	const indices = [...Array(n).keys()].sort((a, b) => sizes[a]! - sizes[b]!);
	let remaining = budget;
	let count = n;
	for (const index of indices) {
		const fair = Math.floor(remaining / count);
		const take = Math.min(fair, sizes[index]!);
		allocations[index] = take;
		remaining -= take;
		count -= 1;
	}
	return allocations;
}

/** Deterministic fallback when the summarizer fails: fair-truncate to a char budget. */
export function truncateFairly(messages: readonly AgentMessage[], charBudget: number): string | undefined {
	const serialized = messages.map((message) => JSON.stringify(message));
	const sizes = serialized.map((text) => text.length);
	const allocations = maxMinFairAllocations(sizes, charBudget);
	const parts: string[] = [];
	let kept = 0;
	for (let index = 0; index < serialized.length; index += 1) {
		const size = sizes[index]!;
		const allocation = allocations[index]!;
		if (allocation >= size) {
			parts.push(serialized[index]!);
			kept += 1;
		} else if (allocation < MIN_USEFUL_CHARS) {
			parts.push(`[omitted message, ${size} chars]`);
		} else {
			parts.push(`${serialized[index]!.slice(0, allocation)}\n[... truncated, ${size} chars]`);
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

/**
 * The digest that never comes back empty.
 *
 * Fair truncation spreads a budget over every message, so a tight budget across
 * many messages writes off all of them ("omitted") and returns nothing — which
 * would drop the history at the moment it is needed most. When that happens the
 * newest messages are kept instead: what the retained tail continues from is
 * the end of the prefix, not its beginning.
 */
export function digestContext(messages: readonly AgentMessage[], charBudget: number): string | undefined {
	const whole = untrustedFallback(messages, charBudget);
	if (whole !== undefined) return whole;
	const newest: AgentMessage[] = [];
	let spent = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		const size = JSON.stringify(message).length;
		// At least one message is kept, and later ones only while room remains.
		if (newest.length > 0 && spent + Math.min(size, MIN_USEFUL_CHARS) > charBudget) break;
		newest.unshift(message);
		spent += size;
	}
	return (
		untrustedFallback(newest, charBudget) ??
		untrustedFallback(newest.slice(-1), Math.max(charBudget, MIN_USEFUL_CHARS))
	);
}
