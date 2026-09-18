import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";
import { forkFromMessage, forkPicked } from "../../lib/fork.ts";

/** One thing the branch could be cut at. */
interface ForkRow {
	entryId: string;
	at: number;
	text: string;
}

/**
 * Pick a message, get a session that ends there. The rows are the user messages of the view —
 * the same window the transcript above is showing, newest first, because the message worth
 * cutting at is almost always one you just sent. A row carries the entry id the server forks on
 * rather than a position in this list, so the copy is cut where the journal says it is.
 */
export function ForkDialog(props: { session: string; view: SessionView; open: boolean; onOpenChange: (open: boolean) => void }) {
	const i18n = useAppI18n();
	const [query, setQuery] = createSignal("");
	const [picked, setPicked] = createSignal(0);
	let search: HTMLInputElement | undefined;

	const rows = createMemo<ForkRow[]>(() =>
		props.view.messages
			.filter((entry) => entry.message.role === "user")
			.map((entry) => ({ entryId: entry.entryId, at: entry.at, text: userLine(entry.message) }))
			.filter((row) => row.text.length > 0)
			.reverse(),
	);

	const shown = createMemo(() => {
		const needle = query().trim().toLowerCase();
		return needle.length === 0 ? rows() : rows().filter((row) => row.text.toLowerCase().includes(needle));
	});

	const selected = () => shown()[Math.min(picked(), Math.max(shown().length - 1, 0))];

	const choose = (row: ForkRow | undefined): void => {
		if (row === undefined) return;
		props.onOpenChange(false);
		forkFromMessage(props.session, row.entryId);
	};

	createEffect(() => {
		if (!props.open) return;
		setQuery("");
		const wanted = forkPicked();
		const index = wanted === undefined ? -1 : rows().findIndex((row) => row.entryId === wanted);
		setPicked(Math.max(index, 0));
		search?.focus();
	});

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent class="max-w-[560px]" data-testid="fork-dialog">
				<DialogHeader>
					<DialogTitle data-testid="fork-title">{i18n.t("fork.title")}</DialogTitle>
				</DialogHeader>
				<div class="flex items-center gap-2 border-b border-border px-3 py-2">
					<span class="mono text-[11px] text-faint">/</span>
					<input
						data-testid="fork-search"
						ref={search}
						value={query()}
						placeholder={i18n.t("fork.search")}
						class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
						onInput={(event) => {
							setQuery(event.currentTarget.value);
							setPicked(0);
						}}
						onKeyDown={(event) => {
							const count = shown().length;
							if (count === 0) return;
							if (event.key === "ArrowDown") {
								event.preventDefault();
								setPicked((index) => (index + 1) % count);
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								setPicked((index) => (index - 1 + count) % count);
							} else if (event.key === "Enter") {
								event.preventDefault();
								choose(selected());
							} else if (event.key === "Escape") {
								props.onOpenChange(false);
							}
						}}
					/>
				</div>
				<DialogBody class="p-0">
					<Show
						when={shown().length > 0}
						fallback={<p data-testid="fork-empty" class="mono p-3 text-[11px] text-faint">{i18n.t("fork.empty")}</p>}
					>
						<ul data-testid="fork-list" class="max-h-[46vh] overflow-y-auto">
							<For each={shown()}>
								{(row, index) => (
									<li>
										<button
											type="button"
											data-testid={`fork-row-${row.entryId}`}
											data-picked={index() === picked() ? "1" : undefined}
											class={`flex w-full items-baseline gap-3 border-b border-border px-3 py-2 text-left hover:bg-overlay ${index() === picked() ? "bg-elevated" : ""}`}
											onMouseEnter={() => setPicked(index())}
											onClick={() => choose(row)}
										>
											<span class="min-w-0 flex-1 truncate text-sm">{row.text}</span>
											<span class="mono shrink-0 text-[10px] text-faint">
												{new Date(row.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
											</span>
										</button>
									</li>
								)}
							</For>
						</ul>
					</Show>
				</DialogBody>
				<DialogFooter>
					<span class="mono mr-auto text-[10px] text-faint">{i18n.t("fork.hint")}</span>
					<button
						type="button"
						data-testid="fork-confirm"
						class="border border-border-strong px-3 py-1 text-xs hover:bg-primary hover:text-primary-foreground disabled:text-faint"
						disabled={selected() === undefined}
						onClick={() => choose(selected())}
					>
						{i18n.t("fork.action")}
					</button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The line a message shows as in the chooser: its text, or what it held when it had none. */
function userLine(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const text = content
		.flatMap((block) => {
			const record = block as { type?: string; text?: unknown };
			return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
		})
		.join(" ")
		.trim();
	if (text.length > 0) return text.replace(/\s*\n\s*/g, " ");
	const images = content.filter((block) => (block as { type?: string }).type === "image").length;
	return images > 0 ? `[${images === 1 ? "image" : `${images} images`}]` : "";
}
