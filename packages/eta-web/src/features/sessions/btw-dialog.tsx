import { useState } from "react";
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

export function BtwDialog({ session, view, open, onOpenChange }: { session: string; view: SessionView; open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [question, setQuestion] = useState("");
	const thread = view.sideThread as unknown as Thread[];
	const last = thread[thread.length - 1];

	const ask = () => {
		const value = question.trim();
		if (value.length === 0 || last === undefined) return;
		store.send({ op: "btwAsk", session, threadId: last.id, question: value });
		setQuestion("");
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[70vh] max-w-[680px]" data-testid="btw-dialog">
				<DialogHeader>
					<DialogTitle>{t("btw.title")}</DialogTitle>
				</DialogHeader>
				<DialogBody className="p-3">
					{last === undefined || last.exchanges.length === 0 ? (
						<p className="mono text-[11px] text-muted">{t("btw.empty")}</p>
					) : (
						<div className="flex flex-col gap-2">
							{last.exchanges.map((exchange, index) => (
								<div key={index} data-testid={`btw-exchange-${index}`} className="border border-border p-2">
									<p className="text-[12px]">{exchange.question}</p>
									<p className="mono mt-1 text-[11px] text-muted">{exchange.answer}</p>
								</div>
							))}
						</div>
					)}
				</DialogBody>
				<DialogFooter>
					{last !== undefined ? (
						<>
							<Button variant="ghost" size="sm" onClick={() => store.send({ op: "btwSave", session, threadId: last.id })}>
								{t("btw.save")}
							</Button>
							<Button variant="ghost" size="sm" onClick={() => store.send({ op: "btwClear", session, threadId: last.id })}>
								{t("btw.clear")}
							</Button>
						</>
					) : null}
					<input
						data-testid="btw-input"
						value={question}
						placeholder={t("btw.ask")}
						onChange={(event) => setQuestion(event.target.value)}
						onKeyDown={(event) => event.key === "Enter" && ask()}
						className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-sm outline-none focus:border-border-strong"
					/>
					<Button variant="invert" size="sm" data-testid="btw-ask" disabled={last === undefined || question.trim().length === 0} onClick={ask}>
						{t("btw.ask")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
