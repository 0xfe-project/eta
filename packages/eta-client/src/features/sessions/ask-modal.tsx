import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";

interface AskLike {
	questionId: string;
	question: string;
	options?: string[];
	multi?: boolean;
}

export function AskModal(props: { session: string; view: SessionView; visible?: boolean }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const ask = () => props.view.pendingAsk as AskLike | undefined;
	const [selected, setSelected] = createSignal<string[]>([]);
	const [freeform, setFreeform] = createSignal("");
	const [now, setNow] = createSignal(Date.now());

	createEffect(() => {
		if (props.view.pendingAskDeadline === undefined) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		onCleanup(() => clearInterval(timer));
	});

	const options = () => ask()?.options ?? [];
	const multi = () => ask()?.multi === true;
	const seconds = () => (props.view.pendingAskDeadline === undefined ? undefined : Math.max(0, Math.ceil((props.view.pendingAskDeadline - now()) / 1000)));

	const answer = (response: Record<string, unknown>) => {
		setSelected([]);
		setFreeform("");
		const current = ask();
		if (current !== undefined) store.send({ op: "answer", session: props.session, questionId: current.questionId, response });
	};

	const abort = () => {
		const current = ask();
		if (current !== undefined) store.send({ op: "askAbort", session: props.session, questionId: current.questionId });
	};

	return (
		<Dialog open={ask() !== undefined && (props.visible ?? true)}>
			<DialogContent class="max-w-[480px]" hideClose data-testid="ask-modal">
				<DialogHeader>
					<DialogTitle data-testid="ask-question" class="min-w-0 flex-1 normal-case">
						{ask()?.question}
					</DialogTitle>
				</DialogHeader>
				<div class="p-3">
					<Show when={seconds() !== undefined}>
						<p data-testid="ask-countdown" class="mb-2 font-mono text-[11px] text-warning">{i18n.t("ask.seconds", { seconds: seconds() })}</p>
					</Show>
					<Show when={options().length > 0}>
						<div class="mb-3 flex flex-wrap gap-2">
							<For each={options()}>
								{(option) => {
									const on = () => selected().includes(option);
									return (
										<Button
											data-testid={`ask-option-${option}`}
											variant={on() ? "invert" : "outline"}
											class="px-3 py-1.5 text-xs normal-case"
											onClick={() => {
												if (!multi()) {
													answer({ kind: "selection", selections: [option] });
													return;
												}
												setSelected(on() ? selected().filter((item) => item !== option) : [...selected(), option]);
											}}
										>
											{option}
										</Button>
									);
								}}
							</For>
						</div>
					</Show>
					<div class="flex gap-2">
						<input
							data-testid="ask-freeform"
							value={freeform()}
							placeholder={i18n.t("ask.freeform")}
							onInput={(event) => setFreeform(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && (selected().length > 0 || freeform().trim().length > 0)) {
									if (selected().length > 0) answer({ kind: "selection", selections: selected(), ...(freeform().trim().length > 0 ? { comment: freeform().trim() } : {}) });
									else answer({ kind: "freeform", text: freeform().trim() });
								}
							}}
							class="min-w-0 flex-1 border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-border-strong"
						/>
						<Button
							data-testid="ask-answer"
							variant="invert"
							disabled={selected().length === 0 && freeform().trim().length === 0}
							class="px-3 py-1.5 text-xs normal-case"
							onClick={() => {
								if (selected().length > 0) {
									answer({ kind: "selection", selections: selected(), ...(freeform().trim().length > 0 ? { comment: freeform().trim() } : {}) });
									return;
								}
								answer({ kind: "freeform", text: freeform().trim() });
							}}
						>
							{i18n.t("ask.answer")}
						</Button>
						<Button
							data-testid="ask-abort"
							variant="outline"
							title={i18n.t("ask.abortHint")}
							class="border-2 border-danger px-3 py-1.5 text-xs font-bold normal-case text-danger hover:bg-danger hover:text-background"
							onClick={abort}
						>
							{i18n.t("ask.abort")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
