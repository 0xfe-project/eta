import { For, Show, createEffect, createSignal } from "solid-js";
import type { SessionView, SessionViewBtwThread } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";

/**
 * The side thread: a temporary conversation opened beside a run that cannot be
 * interrupted. A question goes to a standalone request that inherits the main agent's
 * model, thinking level, prompt and tools — inherited, never configured here — so what
 * the session is right now is what the side request is, including a model or toolset
 * the user switched while the dialog was open. It answers while the run is mid-turn.
 *
 * The same channel is a note pad: a bare note can be recorded instead of asked, and
 * either kind can be saved into the main session or handed to the running agent.
 */
export function BtwDialog(props: { session: string; view: SessionView; open: boolean; onOpenChange: (open: boolean) => void }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const [note, setNote] = createSignal("");
	const send = (op: Parameters<ReturnType<typeof etaStore>["send"]>[0]) => store.send(op);
	const thread = () => props.view.sideThread as SessionViewBtwThread[];
	const current = () => thread()[thread().length - 1];
	const session = () => props.session;
	const threadId = () => current()?.id ?? "";

	/** Opening the dialog is what opens the thread — `/btw` should never need a second click. */
	createEffect(() => {
		if (props.open && current() === undefined) send({ op: "btwOpen", session: props.session, kind: "contextual" });
	});

	const busy = () => current()?.pending !== undefined;
	const submit = () => {
		const value = note().trim();
		if (value.length === 0 || current() === undefined || busy()) return;
		send({ op: "btwAsk", session: session(), threadId: threadId(), question: value });
		setNote("");
	};
	/** Record without asking: a note for the main agent to find later, no model involved. */
	const record = () => {
		const value = note().trim();
		if (value.length === 0 || current() === undefined) return;
		send({ op: "btwAnswer", session: session(), threadId: threadId(), question: value, answer: "" });
		setNote("");
	};

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent class="max-h-[70vh] max-w-[680px]" data-testid="btw-dialog">
				<DialogHeader>
					<DialogTitle>{i18n.t("btw.title")}</DialogTitle>
				</DialogHeader>
				<DialogBody class="p-3">
					<Show when={current() !== undefined}>
						<div class="mono mb-2 flex flex-wrap items-center gap-2 text-[10px] text-muted">
							<span>{current()?.id}</span>
							<span>{current()?.kind}</span>
							{/* Inherited, not configured: the session's own model, thinking and tools. */}
							<span data-testid="btw-inherited">
								{props.view.model} · {props.view.thinkingLevel} · {props.view.tools.length}{" "}
								{i18n.t("btw.tools")}
							</span>
						</div>
						<details class="mono mb-2 text-[10px] text-muted">
							<summary data-testid="btw-tools-toggle">{i18n.t("btw.tools")}</summary>
							<ul data-testid="btw-tools" class="mt-1 flex flex-wrap gap-1">
								<For each={props.view.tools}>
									{(tool) => (
										<li class="border border-border px-1" title={tool.description}>
											{tool.name}
										</li>
									)}
								</For>
							</ul>
						</details>
					</Show>
					<Show
						when={(current()?.exchanges.length ?? 0) > 0 || current()?.pending !== undefined || current()?.error !== undefined}
						fallback={<p class="mono text-[11px] text-muted">{i18n.t("btw.empty")}</p>}
					>
						<div class="flex flex-col gap-2">
							<For each={current()?.exchanges ?? []}>
								{(exchange, index) => (
									<div data-testid={`btw-exchange-${index()}`} class="border border-border p-2">
										<p class="text-[12px]">{exchange.question}</p>
										<Show when={exchange.answer.length > 0}>
											<p class="mono mt-1 text-[11px] text-muted">{exchange.answer}</p>
										</Show>
										<Show when={exchange.steps !== undefined}>
											{/* How the answer was reached: a side answer that looked something up says so. */}
											<p data-testid={`btw-steps-${index()}`} class="mono mt-1 text-[10px] text-faint">
												{i18n.t("btw.ranTools", {
													tools: (exchange.steps ?? [])
														.map((step) => (step.ok ? step.tool : `${step.tool}×`))
														.join(", "),
												})}
											</p>
										</Show>
									</div>
								)}
							</For>
							<Show when={current()?.pending !== undefined}>
								<div
									data-testid="btw-pending"
									class="mono border border-border p-2 text-[11px] text-muted"
								>
									{current()?.pending?.question}
									<span class="text-faint"> · {i18n.t("btw.waiting")}</span>
								</div>
							</Show>
							<Show when={current()?.error !== undefined}>
								<p data-testid="btw-error" class="mono text-[11px] text-faint">
									{i18n.t("btw.failed")}: {current()?.error}
								</p>
							</Show>
						</div>
					</Show>
				</DialogBody>
				<DialogFooter>
					<Show when={current() !== undefined}>
						<Button
							variant="ghost"
							size="sm"
							data-testid="btw-save"
							disabled={(current()?.exchanges.length ?? 0) === 0}
							onClick={() => send({ op: "btwSave", session: session(), threadId: threadId() })}
						>
							{i18n.t("btw.save")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							data-testid="btw-handoff"
							disabled={(current()?.exchanges.length ?? 0) === 0}
							onClick={() => send({ op: "btwHandoff", session: session(), threadId: threadId() })}
						>
							{i18n.t("btw.handoff")}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => send({ op: "btwClear", session: session(), threadId: threadId() })}>
							{i18n.t("btw.clear")}
						</Button>
					</Show>
					<input
						data-testid="btw-input"
						value={note()}
						placeholder={i18n.t("btw.title")}
						disabled={busy()}
						onInput={(event) => setNote(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								submit();
							}
						}}
						class="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-sm outline-none focus:border-border-strong"
					/>
					<Button
						variant="ghost"
						size="sm"
						data-testid="btw-record"
						disabled={current() === undefined || note().trim().length === 0}
						onClick={record}
					>
						{i18n.t("btw.note")}
					</Button>
					<Button
						variant="invert"
						size="sm"
						data-testid="btw-ask"
						disabled={current() === undefined || busy() || note().trim().length === 0}
						onClick={submit}
					>
						{i18n.t("btw.ask")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
