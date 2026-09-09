import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { MessageMarkdown } from "./message-markdown.tsx";

type ToolResultLike = { toolCallId: string; content: unknown; isError?: boolean };

export function Timeline({ view, session }: { view: SessionView; session: string }) {
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

	const prompts = view.messages.filter((entry) => entry.message.role === "user");

	const jumpTo = (index: number) => {
		const node = document.getElementById(`eta-msg-${prompts[index]?.entryId ?? ""}`);
		node?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	return (
		<div className="relative min-h-0 flex-1">
			<div ref={scroller} onScroll={onScroll} data-testid="timeline" className="h-full overflow-y-auto px-4 py-3">
				{view.messages.length === 0 && view.systems.length === 0 ? <p className="p-4 text-sm text-muted">{t("timeline.empty")}</p> : null}
				{view.systems.map((row) => (
					<div key={row.entryId} data-testid="system-row" className="mono mx-auto my-2 w-fit bg-overlay px-3 py-1 text-[11px] text-muted">
						{t(`system.${row.kind}`, row.args)}
						{row.args.objective ?? row.args.question ?? row.args.note ?? row.args.summary ? <span className="ml-1 text-muted">{row.args.objective ?? row.args.question ?? row.args.note ?? row.args.summary}</span> : null}
					</div>
				))}
				{view.messages.map((entry) => (
					<div key={entry.entryId} id={`eta-msg-${entry.entryId}`}>
						<MessageRow role={entry.message.role} message={entry.message} session={session} />
					</div>
				))}
			</div>
			{prompts.length > 1 ? (
				<div data-testid="prompt-rail" className="absolute right-1 top-16 flex max-h-[60%] flex-col gap-1 overflow-y-auto">
					{prompts.map((entry, index) => (
						<button
							key={entry.entryId}
							data-testid={`prompt-rail-${index + 1}`}
							title={`${index + 1}`}
							onClick={() => jumpTo(index)}
							className="mono h-5 w-5 border border-border bg-elevated text-[9px] text-muted hover:border-border-strong hover:text-foreground"
						>
							{index + 1}
						</button>
					))}
				</div>
			) : null}
			{pinned ? null : (
				<button
					data-testid="new-activity"
					onClick={() => {
						setPinned(true);
						const node = scroller.current;
						if (node !== null) node.scrollTop = node.scrollHeight;
					}}
					className="absolute bottom-3 left-1/2 -translate-x-1/2 border border-border bg-elevated px-3 py-1 text-xs shadow-[var(--shadow)]"
				>
					{t("timeline.newActivity")}
				</button>
			)}
		</div>
	);
}

function MessageRow({ role, message, session }: { role: string; message: unknown; session: string }) {
	const { t } = useAppI18n();
	const content = (message as { content?: unknown }).content;
	const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
	const blocks = contentBlocks(content);
	if (role === "user") {
		return (
			<div className="my-2 flex justify-end" data-testid="user-message">
				<div className="max-w-[80%] bg-accent px-3 py-2 text-sm text-accent-foreground" style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}>
					{blocks.map((block, index) => (block.type === "text" ? <span key={index}>{String(block.text ?? "")}</span> : null))}
				</div>
			</div>
		);
	}
	if (role === "assistant") {
		const touched = [...new Set(
			blocks
				.filter((block) => block.type === "toolCall")
				.map((block) => {
					const args = (block.arguments ?? block.args) as Record<string, unknown> | undefined;
					if (args === undefined || typeof args !== "object") return null;
					for (const key of ["path", "file_path", "file"]) {
						const value = args[key];
						if (typeof value === "string" && value.length > 0) return value;
					}
					return null;
				})
				.filter((value): value is string => value !== null),
		)];
		return (
			<div className="my-2" data-testid="assistant-message">
				{blocks.map((block, index) => {
					if (block.type === "text") {
						return <MessageMarkdown key={index} text={String(block.text ?? "")} />;
					}
					if (block.type === "thinking") {
						return (
							<details key={index} className="my-1 border border-border text-xs text-muted">
								<summary className="cursor-pointer px-2 py-1">thinking</summary>
								<pre className="mono whitespace-pre-wrap px-2 pb-2">{String(block.thinking ?? "")}</pre>
							</details>
						);
					}
					if (block.type === "toolCall") {
						const callId = String(block.id ?? "");
						const args = block.arguments ?? block.args ?? {};
						return (
							<details key={index} data-testid={`tool-row-${String(block.name ?? "")}`} className="my-1 border border-border">
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
				{touched.length > 0 ? (
					<div data-testid="turn-file-chips" className="mt-1 flex flex-wrap gap-1">
						{touched.map((path) => (
							<button
								key={path}
								data-testid={`file-chip-${path}`}
								onClick={() => {
									void fetch(`/api/file?session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`)
										.then((response) => (response.ok ? (response.json() as Promise<{ path: string; text: string }>) : null))
										.then((body) => {
											if (body !== null) setPreview(body);
										})
										.catch(() => undefined);
								}}
								className="mono border border-border px-2 py-0.5 text-[10px] text-muted hover:text-foreground"
							>
								{path}
							</button>
						))}
					</div>
				) : null}
				{preview !== null ? (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="file-preview" onClick={() => setPreview(null)}>
						<div className="max-h-[80vh] w-full max-w-[720px] overflow-auto border border-border bg-elevated p-3" onClick={(event) => event.stopPropagation()}>
							<div className="mb-2 flex items-center gap-2">
								<span className="mono text-xs">{preview.path}</span>
								<button data-testid="file-preview-close" onClick={() => setPreview(null)} className="ml-auto border border-border px-2 py-0.5 text-[10px] text-muted">
									{t("common.close")}
								</button>
							</div>
							<pre className="mono max-h-[70vh] overflow-auto bg-code-bg p-2 text-[11px]">{preview.text}</pre>
						</div>
					</div>
				) : null}
			</div>
		);
	}
	if (role === "toolResult" || role === "tool") {
		const result = message as unknown as ToolResultLike;
		return (
			<details className="my-1 ml-4 border border-border text-xs" data-testid={`tool-result-${result.toolCallId ?? ""}`}>
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
