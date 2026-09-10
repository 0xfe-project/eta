import { For, Show, createSignal } from "solid-js";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";

interface Thread {
	id: string;
	kind: string;
	exchanges: { question: string; answer: string; at: number }[];
	saveState: string;
}

export function BtwDialog(props: { session: string; view: SessionView; open: boolean; onOpenChange: (open: boolean) => void }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const [question, setQuestion] = createSignal("");
	const thread = () => props.view.sideThread as unknown as Thread[];
	const last = () => thread()[thread().length - 1];

	const ask = () => {
		const value = question().trim();
		const current = last();
		if (value.length === 0 || current === undefined) return;
		store.send({ op: "btwAsk", session: props.session, threadId: current.id, question: value });
		setQuestion("");
	};

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent class="max-h-[70vh] max-w-[680px]" data-testid="btw-dialog">
				<DialogHeader>
					<DialogTitle>{i18n.t("btw.title")}</DialogTitle>
				</DialogHeader>
				<DialogBody class="p-3">
					<Show
						when={last() !== undefined && (last()?.exchanges.length ?? 0) > 0}
						fallback={<p class="mono text-[11px] text-muted">{i18n.t("btw.empty")}</p>}
					>
						<div class="flex flex-col gap-2">
							<For each={last()?.exchanges ?? []}>
								{(exchange, index) => (
									<div data-testid={`btw-exchange-${index()}`} class="border border-border p-2">
										<p class="text-[12px]">{exchange.question}</p>
										<p class="mono mt-1 text-[11px] text-muted">{exchange.answer}</p>
									</div>
								)}
							</For>
						</div>
					</Show>
				</DialogBody>
				<DialogFooter>
					<Show when={last()}>
						{(current) => (
							<>
								<Button variant="ghost" size="sm" onClick={() => store.send({ op: "btwSave", session: props.session, threadId: current().id })}>
									{i18n.t("btw.save")}
								</Button>
								<Button variant="ghost" size="sm" onClick={() => store.send({ op: "btwClear", session: props.session, threadId: current().id })}>
									{i18n.t("btw.clear")}
								</Button>
							</>
						)}
					</Show>
					<input
						data-testid="btw-input"
						value={question()}
						placeholder={i18n.t("btw.ask")}
						onInput={(event) => setQuestion(event.currentTarget.value)}
						onKeyDown={(event) => event.key === "Enter" && ask()}
						class="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-sm outline-none focus:border-border-strong"
					/>
					<Button variant="invert" size="sm" data-testid="btw-ask" disabled={last() === undefined || question().trim().length === 0} onClick={ask}>
						{i18n.t("btw.ask")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
