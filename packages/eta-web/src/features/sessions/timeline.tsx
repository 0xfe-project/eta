import { For, Index, Show, Match, Switch, createEffect, createMemo, createSignal } from "solid-js";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { MessageMarkdown } from "./message-markdown.tsx";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";

type ToolResultLike = { toolCallId: string; content: unknown; isError?: boolean };
type ContentBlock = { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown; arguments?: unknown; args?: unknown };

const EMPTY_RESULTS = new Map<string, ToolResultLike>();

const RAIL_NUM = "mono flex h-5 min-w-5 shrink-0 items-center justify-center border border-border bg-elevated px-1 text-[9px] leading-none hover:border-border-strong hover:text-foreground";
const RAIL_ACTIVE = "border-border-strong bg-foreground text-background";

/** Cheap "did the transcript change shape" reading, for the follow-scroll effect. */
function contentChars(message: { content?: unknown } | undefined): number {
	const content = message?.content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content as ContentBlock[]) {
		total += String(block.text ?? "").length + String(block.thinking ?? "").length;
	}
	return total;
}

export function Timeline(props: { view: SessionView; session: string; running?: boolean }) {
	const i18n = useAppI18n();
	let scroller: HTMLDivElement | undefined;
	let railWrap: HTMLDivElement | undefined;
	let railFrame = 0;
	const [pinned, setPinned] = createSignal(true);

	// Follow the tail while pinned. Reconciled views keep the snapshot's object
	// identity across frames, so nothing fires when a token only rewrites text:
	// the trigger has to be the tail content itself, read in here.
	const tail = createMemo(() => {
		const messages = props.view.messages;
		return (
			messages.length +
			props.view.systems.length +
			contentChars(messages[messages.length - 1]?.message as { content?: unknown } | undefined) +
			contentChars(props.view.streaming as { content?: unknown } | undefined)
		);
	});

	createEffect(() => {
		if (!pinned()) return;
		tail();
		const node = scroller;
		if (node !== undefined) node.scrollTop = node.scrollHeight;
	});

	const onScroll = () => {
		const node = scroller;
		if (node === undefined) return;
		setPinned(node.scrollHeight - node.scrollTop - node.clientHeight <= 32);
		if (railFrame === 0) railFrame = requestAnimationFrame(markActive);
	};

	// Which rail number you are looking at. A long run puts a few hundred identical
	// squares on the wall, and a list of those is noise without a position in it.
	const [activeEntry, setActiveEntry] = createSignal("");
	function markActive() {
		railFrame = 0;
		const node = scroller;
		if (node === undefined) return;
		const edge = node.getBoundingClientRect().top + 8;
		let current = "";
		// Wrappers come out in document order, so the first one below the edge ends the scan.
		for (const el of node.querySelectorAll<HTMLElement>("[id^='eta-msg-']")) {
			if (el.getBoundingClientRect().top > edge) break;
			current = el.id.slice("eta-msg-".length);
		}
		setActiveEntry(current);
		if (railWrap !== undefined && !railWrap.matches(":hover")) {
			railWrap.querySelector<HTMLElement>(`[data-entry="${CSS.escape(current)}"]`)?.scrollIntoView({ block: "nearest" });
		}
	}

	const prompts = createMemo(() => props.view.messages.filter((entry) => entry.message.role === "user"));
	// Agent turns, the other axis the rail navigates: one prompt that set the agent
	// off for sixty replies has exactly one prompt number, which navigates nothing.
	const turns = createMemo(() => props.view.messages.filter((entry) => entry.message.role === "assistant"));
	// The rail takes a lane on the right, so the transcript yields it one.
	const railShown = createMemo(() => prompts().length > 1 || turns().length > 1);
	const results = createMemo(() => {
		const map = new Map<string, ToolResultLike>();
		for (const entry of props.view.messages) {
			if (entry.message.role === "toolResult") {
				const result = entry.message as unknown as ToolResultLike;
				map.set(String(result.toolCallId ?? ""), result);
			}
		}
		return map;
	});

	const jumpToEntry = (entryId: string) => {
		document.getElementById(`eta-msg-${entryId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	const jumpTo = (index: number) => {
		jumpToEntry(prompts()[index]?.entryId ?? "");
	};

	/** Where a rail number lands, in words — a bare number says nothing about the destination. */
	const previewOf = (entry: { message: unknown }) => {
		const content = (entry.message as { content?: unknown }).content;
		const blocks: ContentBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as ContentBlock[]) : [];
		const squash = (value: string) => value.trim().replace(/\s+/g, " ").slice(0, 44);
		const prose = squash(blocks.map((block) => String(block.text ?? "")).join(" "));
		if (prose !== "") return prose;
		// A turn that is nothing but tool calls has no words to quote; its tools say enough.
		const tools = blocks.filter((block) => block.type === "toolCall").map((block) => String(block.name ?? "?"));
		if (tools.length > 0) return tools.join(" · ");
		return squash(blocks.map((block) => String(block.thinking ?? "")).join(" "));
	};

	return (
		<div class="relative min-h-0 flex-1">
			<div
				ref={(node) => {
					scroller = node;
				}}
				onScroll={onScroll}
				data-testid="timeline"
				class={`no-scrollbar h-full overflow-y-auto py-4 pl-6 ${railShown() ? "pr-14" : "pr-6"}`}
			>
				<div class="mx-auto max-w-[860px]">
					<Show when={props.view.messages.length === 0 && props.view.systems.length === 0}>
						<p class="p-4 text-sm text-muted">{i18n.t("timeline.empty")}</p>
					</Show>
					<For each={props.view.systems}>
						{(row) => (
							<div data-testid="system-row" class="system-message mono mx-auto my-2 w-fit bg-overlay px-3 py-1 text-[11px] text-muted">
								{i18n.t(`system.${row.kind}`, row.args)}
								<Show when={row.args.objective ?? row.args.question ?? row.args.note ?? row.args.summary}>
									{(extra) => <span class="ml-1 text-muted">{extra()}</span>}
								</Show>
							</div>
						)}
					</For>
					<For each={props.view.messages}>
						{(entry, index) => (
							<div id={`eta-msg-${entry.entryId}`}>
								<MessageRow
									role={entry.message.role}
									message={entry.message}
									session={props.session}
									at={entry.at}
									results={results()}
									isLast={index() === props.view.messages.length - 1 && props.view.streaming === undefined}
									streaming={(props.running ?? false) && index() === props.view.messages.length - 1 && entry.message.role === "assistant"}
								/>
							</div>
						)}
					</For>
					<Show when={props.view.streaming}>
						{(streaming) => {
							const startedAt = Date.now();
							return (
								<div data-testid="streaming-row">
									<MessageRow role={streaming().role} message={streaming()} session={props.session} at={startedAt} results={results()} streaming />
								</div>
							);
						}}
					</Show>
				</div>
			</div>
			<Show when={railShown()}>
				<div
					ref={(node) => {
						railWrap = node;
					}}
					data-testid="rail"
					class="absolute right-1 top-16 flex flex-row items-start gap-1"
				>
					<Show when={turns().length > 1}>
						<div data-testid="turn-rail" class="no-scrollbar flex max-h-[60vh] flex-col items-end gap-1 overflow-y-auto overscroll-contain pb-1">
							<For each={turns()}>
								{(entry, index) => (
									<button
										data-testid={`turn-rail-${index() + 1}`}
										data-entry={entry.entryId}
										aria-current={activeEntry() === entry.entryId}
										title={`${index() + 1} · ${previewOf(entry)}`}
										onClick={() => jumpToEntry(entry.entryId)}
										class={`${RAIL_NUM} ${activeEntry() === entry.entryId ? RAIL_ACTIVE : "text-muted"}`}
									>
										{index() + 1}
									</button>
								)}
							</For>
						</div>
					</Show>
					<Show when={prompts().length > 1}>
						<div data-testid="prompt-rail" class="no-scrollbar flex max-h-[60vh] flex-col items-end gap-1 overflow-y-auto overscroll-contain pb-1">
							<For each={prompts()}>
								{(entry, index) => (
									<button
										data-testid={`prompt-rail-${index() + 1}`}
										data-entry={entry.entryId}
										aria-current={activeEntry() === entry.entryId}
										title={`${index() + 1} · ${previewOf(entry)}`}
										onClick={() => jumpTo(index())}
										class={`${RAIL_NUM} rounded-full border-border-strong ${activeEntry() === entry.entryId ? RAIL_ACTIVE : "text-foreground"}`}
									>
										{index() + 1}
									</button>
								)}
							</For>
						</div>
					</Show>
				</div>
			</Show>
			<Show when={!pinned()}>
				<button
					data-testid="new-activity"
					onClick={() => {
						setPinned(true);
						const node = scroller;
						if (node !== undefined) node.scrollTop = node.scrollHeight;
					}}
					class="absolute bottom-3 left-1/2 -translate-x-1/2 border border-border bg-elevated px-3 py-1 text-xs shadow-[var(--shadow)]"
				>
					{i18n.t("timeline.newActivity")}
				</button>
			</Show>
		</div>
	);
}

function MessageRow(props: { role: string; message: unknown; session: string; streaming?: boolean; at?: number; results?: Map<string, ToolResultLike>; isLast?: boolean }) {
	if (props.role === "user") return <UserMessage message={props.message} at={props.at ?? 0} />;
	if (props.role === "assistant") {
		return (
			<AssistantMessage
				message={props.message}
				session={props.session}
				streaming={props.streaming === true}
				at={props.at ?? 0}
				results={props.results ?? EMPTY_RESULTS}
			/>
		);
	}
	if (props.role === "toolResult") return <OrphanToolResult message={props.message} results={props.results ?? EMPTY_RESULTS} />;
	return null;
}

function UserMessage(props: { message: unknown; at: number }) {
	const blocks = createMemo(() => contentBlocks((props.message as { content?: unknown }).content));
	return (
		<div class="message user my-2 flex justify-end" data-testid="user-message">
			<div class="message-content max-w-[80%] px-3 py-2 text-sm text-accent-foreground">
				<Index each={blocks()}>
					{(block) => (
						<Show when={block().type === "text"}>
							<span>{String(block().text ?? "")}</span>
						</Show>
					)}
				</Index>
				<MessageFooter at={props.at} blocks={blocks()} />
			</div>
		</div>
	);
}

function AssistantMessage(props: { message: unknown; session: string; streaming: boolean; at: number; results: Map<string, ToolResultLike> }) {
	const i18n = useAppI18n();
	const [preview, setPreview] = createSignal<{ path: string; text: string } | null>(null);
	const blocks = createMemo(() => contentBlocks((props.message as { content?: unknown }).content));
	const touched = createMemo(() => [...new Set(
		blocks()
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
	)]);

	return (
		<div class="message assistant my-2" data-testid="assistant-message">
			<Index each={blocks()}>
				{(block) => <AssistantBlock block={block()} streaming={props.streaming} results={props.results} />}
			</Index>
			<Show when={touched().length > 0}>
				<div data-testid="turn-file-chips" class="turn-file-chips">
					<For each={touched()}>
						{(path) => (
							<button
								data-testid={`file-chip-${path}`}
								onClick={() => {
									void fetch(`/api/file?session=${encodeURIComponent(props.session)}&path=${encodeURIComponent(path)}`)
										.then((response) => (response.ok ? (response.json() as Promise<{ path: string; text: string }>) : null))
										.then((body) => {
											if (body !== null) setPreview(body);
										})
										.catch(() => undefined);
								}}
								class="turn-file-chip mono border border-border px-2 py-0.5 text-[10px] text-muted hover:text-foreground"
							>
								{path}
							</button>
						)}
					</For>
				</div>
			</Show>
			<MessageFooter at={props.at} blocks={blocks()} />
			<Dialog open={preview() !== null} onOpenChange={(open) => !open && setPreview(null)}>
				<DialogContent class="max-w-[720px]" data-testid="file-preview">
					<DialogHeader>
						<DialogTitle data-testid="file-preview-path" class="min-w-0 flex-1 truncate normal-case">{preview()?.path}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<pre class="mono bg-code-bg p-2 text-[11px]">{preview()?.text}</pre>
					</DialogBody>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/**
 * Branches on `type` reactively and reads `results` lazily: once the reconciled
 * store stops re-creating rows, a row is built once and then only its
 * expressions re-run, so anything captured into a const here would freeze at
 * whatever it was when the block first appeared (a tool card stuck on
 * "running" forever).
 */
function AssistantBlock(props: { block: ContentBlock; streaming: boolean; results: Map<string, ToolResultLike> }) {
	const i18n = useAppI18n();
	const block = () => props.block;
	const callId = () => String(block().id ?? "");
	const args = () => (block().arguments ?? block().args ?? {}) as Record<string, unknown>;
	const result = () => props.results.get(callId());
	const toolState = () => (result() === undefined ? "running" : result()!.isError === true ? "failed" : "done");
	return (
		<Switch>
			<Match when={block().type === "text"}>
				<MessageMarkdown content={String(block().text ?? "")} streaming={props.streaming} />
			</Match>
			<Match when={block().type === "thinking"}>
				<details class="thinking-block">
					<summary class="thinking-block-header"><span class="thinking-block-chevron">▸</span>thinking</summary>
					<pre class="thinking-block-content">{String(block().thinking ?? "")}</pre>
				</details>
			</Match>
			<Match when={block().type === "toolCall"}>
				<details data-testid={`tool-row-${String(block().name ?? "")}`} class="tool-card">
					<summary class="tool-card-head">
						<span class="tool-card-label">{String(block().name ?? "?")}</span>
						<span class="tool-card-status">{summarize(args())}</span>
						<span class={`tool-badge ${toolState()}`} data-testid={`tool-badge-${callId() || String(block().name ?? "")}`}>{i18n.t(`timeline.tool.${toolState()}`)}</span>
					</summary>
					<pre class="tool-card-block tool-card-block-content">{JSON.stringify(args(), null, 2)}</pre>
					<Show when={result()}>
						{(found) => <pre class="tool-card-block tool-card-block-content">{renderContent(found().content)}</pre>}
					</Show>
				</details>
			</Match>
		</Switch>
	);
}

function OrphanToolResult(props: { message: unknown; results: Map<string, ToolResultLike> }) {
	const i18n = useAppI18n();
	const result = () => props.message as unknown as ToolResultLike;
	return (
		<Show when={!props.results.has(String(result().toolCallId ?? ""))}>
			<details class="tool-card ml-4" data-testid={`tool-result-${result().toolCallId ?? ""}`}>
				<summary class={`tool-card-head ${result().isError === true ? "text-danger" : ""}`}>
					<span class="tool-card-label">{String((result() as unknown as { toolName?: string }).toolName ?? "tool")}</span>
					<span class={`tool-badge ${result().isError === true ? "failed" : "done"}`}>{i18n.t(`timeline.tool.${result().isError === true ? "failed" : "done"}`)}</span>
				</summary>
				<pre class="tool-card-block tool-card-block-content">{renderContent(result().content)}</pre>
			</details>
		</Show>
	);
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as ContentBlock[];
	return [];
}

function MessageFooter(props: { at: number; blocks: { type?: string; text?: unknown }[] }) {
	const i18n = useAppI18n();
	const [copied, setCopied] = createSignal(false);
	const text = () => props.blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n").trim();
	return (
		<Show when={props.at !== 0}>
			<div class="msg-footer mono flex items-center gap-2 pt-1 text-[10px] text-muted">
				<span data-testid="msg-time">{new Date(props.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
				<Show when={text().length > 0}>
					<button
						data-testid="msg-copy"
						onClick={() => {
							void navigator.clipboard.writeText(text()).then(() => {
								setCopied(true);
								setTimeout(() => setCopied(false), 1_200);
							});
						}}
						class="border border-transparent px-1 hover:border-border hover:text-foreground"
					>
						{copied() ? "\u2713" : i18n.t("timeline.copy")}
					</button>
				</Show>
			</div>
		</Show>
	);
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
