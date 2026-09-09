import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";

type ToolResultLike = { toolCallId: string; content: unknown; isError?: boolean };

export function Timeline({ view }: { view: SessionView }) {
	const { t } = useAppI18n();
	const scroller = useRef<HTMLDivElement | null>(null);
	const [pinned, setPinned] = useState(true);

	useEffect(() => {
		if (pinned) {
			const node = scroller.current;
			if (node !== null) node.scrollTop = node.scrollHeight;
		}
	}, [view, pinned]);

	const onScroll = () => {
		const node = scroller.current;
		if (node === null) return;
		setPinned(node.scrollHeight - node.scrollTop - node.clientHeight <= 32);
	};

	return (
		<div className="relative min-h-0 flex-1">
			<div ref={scroller} onScroll={onScroll} data-testid="timeline" className="h-full overflow-y-auto px-4 py-3">
				{view.messages.length === 0 && view.systems.length === 0 ? <p className="p-4 text-sm text-muted">{t("timeline.empty")}</p> : null}
				{view.systems.map((row) => (
					<div key={row.entryId} data-testid="system-row" className="mono mx-auto my-2 w-fit rounded-full bg-overlay px-3 py-1 text-[11px] text-muted">
						{row.kind} · {row.text}
					</div>
				))}
				{view.messages.map((entry) => (
					<MessageRow key={entry.entryId} role={entry.message.role} message={entry.message} />
				))}
			</div>
			{pinned ? null : (
				<button
					data-testid="new-activity"
					onClick={() => {
						setPinned(true);
						const node = scroller.current;
						if (node !== null) node.scrollTop = node.scrollHeight;
					}}
					className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-elevated px-3 py-1 text-xs shadow-[var(--shadow)]"
				>
					{t("timeline.newActivity")}
				</button>
			)}
		</div>
	);
}

function MessageRow({ role, message }: { role: string; message: unknown }) {
	const content = (message as { content?: unknown }).content;
	const blocks = contentBlocks(content);
	if (role === "user") {
		return (
			<div className="my-2 flex justify-end" data-testid="user-message">
				<div className="max-w-[80%] rounded-xl rounded-br-sm bg-accent px-3 py-2 text-sm text-accent-foreground" style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}>
					{blocks.map((block, index) => (block.type === "text" ? <span key={index}>{String(block.text ?? "")}</span> : null))}
				</div>
			</div>
		);
	}
	if (role === "assistant") {
		return (
			<div className="my-2" data-testid="assistant-message">
				{blocks.map((block, index) => {
					if (block.type === "text") {
						return (
							<p key={index} className="whitespace-pre-wrap py-1 text-sm leading-relaxed">
								{String(block.text ?? "")}
							</p>
						);
					}
					if (block.type === "thinking") {
						return (
							<details key={index} className="my-1 rounded-lg border border-border text-xs text-muted">
								<summary className="cursor-pointer px-2 py-1">thinking</summary>
								<pre className="mono whitespace-pre-wrap px-2 pb-2">{String(block.thinking ?? "")}</pre>
							</details>
						);
					}
					if (block.type === "toolCall") {
						const callId = String(block.id ?? "");
						const args = block.arguments ?? block.args ?? {};
						return (
							<details key={index} data-testid={`tool-row-${String(block.name ?? "")}`} className="my-1 rounded-lg border border-border">
								<summary className="cursor-pointer px-2 py-1 text-xs">
									<span className="mono text-accent">{String(block.name ?? "?")}</span>
									<span className="ml-2 text-muted">{summarize(args)}</span>
								</summary>
								<pre className="mono max-h-60 overflow-auto bg-code-bg px-2 py-1 text-[11px]">{JSON.stringify(args, null, 2)}</pre>
							</details>
						);
					}
					return null;
				})}
			</div>
		);
	}
	if (role === "toolResult" || role === "tool") {
		const result = message as unknown as ToolResultLike;
		return (
			<details className="my-1 ml-4 rounded-lg border border-border text-xs" data-testid={`tool-result-${result.toolCallId ?? ""}`}>
				<summary className={`cursor-pointer px-2 py-1 ${result.isError === true ? "text-danger" : "text-muted"}`}>{result.isError === true ? "failed" : "done"}</summary>
				<pre className="mono max-h-60 overflow-auto bg-code-bg px-2 py-1 text-[11px]">{renderContent(result.content)}</pre>
			</details>
		);
	}
	return null;
}

function contentBlocks(content: unknown): { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown; arguments?: unknown; args?: unknown }[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as { type?: string }[];
	return [];
}

function summarize(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const entries = Object.entries(args as Record<string, unknown>);
	const first = entries.find(([, value]) => typeof value === "string");
	return first === undefined ? "" : String(first[1]).slice(0, 60);
}

function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: unknown }).text ?? "") : JSON.stringify(part))).join("\n");
	}
	return JSON.stringify(content, null, 2);
}

export type { ReactNode };
