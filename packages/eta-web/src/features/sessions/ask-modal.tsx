import { useEffect, useState } from "react";
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

export function AskModal({ session, view, visible = true }: { session: string; view: SessionView; visible?: boolean }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const ask = view.pendingAsk as AskLike | undefined;
	const [selected, setSelected] = useState<string[]>([]);
	const [freeform, setFreeform] = useState("");
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (view.pendingAskDeadline === undefined) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [view.pendingAskDeadline]);

	const options = ask?.options ?? [];
	const multi = ask?.multi === true;
	const seconds = view.pendingAskDeadline === undefined ? undefined : Math.max(0, Math.ceil((view.pendingAskDeadline - now) / 1000));

	const answer = (response: Record<string, unknown>) => {
		setSelected([]);
		setFreeform("");
		if (ask !== undefined) store.send({ op: "answer", session, questionId: ask.questionId, response });
	};

	return (
		<Dialog open={ask !== undefined && visible}>
			<DialogContent className="max-w-[480px]" hideClose data-testid="ask-modal">
				<DialogHeader>
					<DialogTitle data-testid="ask-question" className="min-w-0 flex-1 normal-case">
						{ask?.question}
					</DialogTitle>
				</DialogHeader>
				<div className="p-3">
					{seconds !== undefined ? <p data-testid="ask-countdown" className="mb-2 font-mono text-[11px] text-warning">{t("ask.seconds", { seconds })}</p> : null}
					{options.length > 0 ? (
						<div className="mb-3 flex flex-wrap gap-2">
							{options.map((option) => {
								const on = selected.includes(option);
								return (
									<Button
										key={option}
										data-testid={`ask-option-${option}`}
										variant={on ? "invert" : "outline"}
										className="px-3 py-1.5 text-xs normal-case"
										onClick={() => {
											if (!multi) {
												answer({ kind: "selection", selections: [option] });
												return;
											}
											setSelected(on ? selected.filter((item) => item !== option) : [...selected, option]);
										}}
									>
										{option}
									</Button>
								);
							})}
						</div>
					) : null}
					<div className="flex gap-2">
						<input
							data-testid="ask-freeform"
							value={freeform}
							placeholder={t("ask.freeform")}
							onChange={(event) => setFreeform(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && (selected.length > 0 || freeform.trim().length > 0)) {
									if (selected.length > 0) answer({ kind: "selection", selections: selected, ...(freeform.trim().length > 0 ? { comment: freeform.trim() } : {}) });
									else answer({ kind: "freeform", text: freeform.trim() });
								}
							}}
							className="min-w-0 flex-1 border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-border-strong"
						/>
						<Button
							data-testid="ask-answer"
							variant="invert"
							disabled={selected.length === 0 && freeform.trim().length === 0}
							className="px-3 py-1.5 text-xs normal-case"
							onClick={() => {
								if (selected.length > 0) {
									answer({ kind: "selection", selections: selected, ...(freeform.trim().length > 0 ? { comment: freeform.trim() } : {}) });
									return;
								}
								answer({ kind: "freeform", text: freeform.trim() });
							}}
						>
							{t("ask.answer")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
