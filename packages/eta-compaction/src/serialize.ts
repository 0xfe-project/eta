/**
 * Turning messages into the text a summary prompt reads, and the file lists a
 * summary ends with (ported from eta-agent's compaction/utils.ts).
 *
 * Serialization is lossy on purpose: tool output is capped, thinking is kept
 * labeled, and the shape stays plain text so a summary request needs no schema.
 */
import type { AgentMessage } from "@eta/core";

/** What a compaction summary notes about the files the history touched. */
export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Add file operations from one assistant message's tool calls. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return;
	for (const block of content as { type?: string; name?: string; arguments?: Record<string, unknown> }[]) {
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		const path = block.arguments?.path;
		if (typeof path !== "string" || path.length === 0) continue;
		if (block.name === "read") fileOps.read.add(path);
		else if (block.name === "write") fileOps.written.add(path);
		else if (block.name === "edit") fileOps.edited.add(path);
	}
}

/** Read-only files and modified files, both sorted. A file both read and written counts as modified. */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((file) => !modified.has(file)).sort();
	return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

/** The metadata block appended to a summary, so the next reader knows what was touched. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** Plain text of one message's content blocks. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: string; text?: string }[])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

/** Serialize messages to plain text for a summarization prompt. */
export function serializeConversation(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const content = contentText((message as { content?: unknown }).content);
			if (content) parts.push(`[User]: ${content}`);
			continue;
		}
		if (message.role === "assistant") {
			const content = (message as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];
			let hasText = false;
			for (const block of content as {
				type?: string;
				thinking?: string;
				name?: string;
				arguments?: Record<string, unknown>;
				text?: string;
			}[]) {
				if (block.type === "thinking" && block.thinking) thinkingParts.push(block.thinking);
				else if (block.type === "toolCall") {
					const args = Object.entries(block.arguments ?? {})
						.map(([key, value]) => `${key}=${safeJsonStringify(value)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${args})`);
				} else if (block.type === "text") hasText = true;
			}
			if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			if (hasText) parts.push(`[Assistant]: ${contentText(content)}`);
			if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			continue;
		}
		if (message.role === "toolResult") {
			const content = contentText((message as { content?: unknown }).content);
			if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
		}
	}
	return parts.join("\n\n");
}

/** Serialized conversation, measured with the chars-per-token rate the kernel estimates with. */
export function serializedTokens(messages: readonly AgentMessage[]): number {
	return Math.ceil(serializeConversation(messages).length / 4);
}
