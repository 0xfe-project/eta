import { For, Show, createSignal } from "solid-js";
import type { SessionView, SessionViewBtwThread } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function BtwDialog(props: { session: string; view: SessionView; open: boolean; onOpenChange: (open: boolean) => void }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const [question, setQuestion] = createSignal("");
	const [modelDraft, setModelDraft] = createSignal("");
	const send = (op: Parameters<ReturnType<typeof etaStore>["send"]>[0]) => store.send(op);
	const thread = () => props.view.sideThread as SessionViewBtwThread[];
	const current = () => thread()[thread().length - 1];
	const pending = () => current()?.pending;
	const failed = () => current()?.error;
	const answered = () => current()?.exchanges.length ?? 0;
	const session = () => props.session;
	const threadId = () => current()?.id ?? "";

	const ask = () => {
		const value = question().trim();
		if (value.length === 0 || current() === undefined) return;
		send({ op: "btwAsk", session: session(), threadId: threadId(), question: value });
		setQuestion("");
	};

	// An empty model box means "inherit the main session", which is an override cleared.
	const commitModel = () => {
		const value = modelDraft().trim();
		if (value === (current()?.model ?? "")) return;
		send({ op: "btwOverride", session: session(), threadId: threadId(), model: value.length === 0 ? null : value });
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
							<label class="flex items-center gap-1">
								{i18n.t("btw.model")}
								<input
									data-testid="btw-model"
									value={modelDraft()}
									placeholder={i18n.t("btw.inherit")}
									onInput={(event) => setModelDraft(event.currentTarget.value)}
									onBlur={commitModel}
									onKeyDown={(event) => event.key === "Enter" && commitModel()}
									class="w-[160px] border border-border bg-background px-1 py-0.5 text-[10px] outline-none"
								/>
							</label>
							<label class="flex items-center gap-1">
								{i18n.t("btw.thinking")}
								<select
									data-testid="btw-thinking"
									value={current()?.thinking ?? ""}
									onChange={(event) =>
										send({
											op: "btwOverride",
											session: session(),
											threadId: threadId(),
											thinking: event.currentTarget.value.length === 0 ? null : (event.currentTarget.value as (typeof THINKING_LEVELS)[number]),
										})
									}
									class="border border-border bg-background px-1 py-0.5 text-[10px] outline-none"
								>
									<option value="">{i18n.t("btw.inherit")}</option>
									<For each={THINKING_LEVELS}>{(level) => <option value={level}>{level}</option>}</For>
								</select>
							</label>
						</div>
					</Show>
					<Show
						when={answered() > 0 || pending() !== undefined || failed() !== undefined}
						fallback={<p class="mono text-[11px] text-muted">{i18n.t("btw.empty")}</p>}
					>
						<div class="flex flex-col gap-2">
							<For each={current()?.exchanges ?? []}>
								{(exchange, index) => (
									<div data-testid={`btw-exchange-${index()}`} class="border border-border p-2">
										<p class="text-[12px]">{exchange.question}</p>
										<p class="mono mt-1 text-[11px] text-muted">{exchange.answer}</p>
									</div>
								)}
							</For>
							<Show when={pending()}>
								{(waiting) => (
									<div data-testid="btw-pending" class="border border-border p-2">
										<p class="text-[12px]">{waiting().question}</p>
										<p class="mono mt-1 text-[11px] text-muted">{i18n.t("btw.pending")}</p>
									</div>
								)}
							</Show>
							<Show when={failed()}>
								{(message) => (
									<p data-testid="btw-error" class="mono border border-border p-2 text-[11px] text-danger">
										{i18n.t("btw.failed")} {message()}
									</p>
								)}
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
							disabled={answered() === 0}
							onClick={() => send({ op: "btwSave", session: session(), threadId: threadId() })}
						>
							{i18n.t("btw.save")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							data-testid="btw-handoff"
							disabled={answered() === 0}
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
						value={question()}
						placeholder={i18n.t("btw.ask")}
						onInput={(event) => setQuestion(event.currentTarget.value)}
						onKeyDown={(event) => event.key === "Enter" && ask()}
						class="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-sm outline-none focus:border-border-strong"
					/>
					<Button variant="invert" size="sm" data-testid="btw-ask" disabled={current() === undefined || question().trim().length === 0} onClick={ask}>
						{pending() === undefined ? i18n.t("btw.ask") : i18n.t("btw.waiting")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
