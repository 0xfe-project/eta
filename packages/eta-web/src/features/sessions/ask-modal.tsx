import { useEffect, useState } from "react";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";

interface AskLike {
	questionId: string;
	question: string;
	options?: string[];
	multi?: boolean;
}

export function AskModal({ session, view }: { session: string; view: SessionView }) {
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

	if (ask === undefined) return null;
	const options = ask.options ?? [];
	const multi = ask.multi === true;
	const seconds = view.pendingAskDeadline === undefined ? undefined : Math.max(0, Math.ceil((view.pendingAskDeadline - now) / 1000));

	const answer = (response: Record<string, unknown>) => {
		setSelected([]);
		setFreeform("");
		store.send({ op: "answer", session, questionId: ask.questionId, response });
	};

	return (
		<div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center" data-testid="ask-modal">
			<div className="w-full max-w-[480px] rounded-xl border border-border bg-elevated p-4 shadow-[var(--shadow)]">
				<p data-testid="ask-question" className="text-sm font-medium">
					{ask.question}
				</p>
				{seconds !== undefined ? <p data-testid="ask-countdown" className="mt-1 text-[11px] text-warning">{t("ask.seconds", { seconds })}</p> : null}
				{options.length > 0 ? (
					<div className="mt-3 flex flex-wrap gap-2">
						{options.map((option) => {
							const on = selected.includes(option);
							return (
								<button
									key={option}
									data-testid={`ask-option-${option}`}
									onClick={() => {
										if (!multi) {
											answer({ kind: "selection", selections: [option] });
											return;
										}
										setSelected(on ? selected.filter((item) => item !== option) : [...selected, option]);
									}}
									className={`rounded-lg border px-3 py-1.5 text-xs ${on ? "border-accent text-accent" : "border-border hover:bg-overlay"}`}
								>
									{option}
								</button>
							);
						})}
					</div>
				) : null}
				<div className="mt-3 flex gap-2">
					<input
						data-testid="ask-freeform"
						value={freeform}
						placeholder={t("ask.freeform")}
						onChange={(event) => setFreeform(event.target.value)}
						className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-border-strong"
					/>
					<button
						data-testid="ask-answer"
						disabled={selected.length === 0 && freeform.trim().length === 0}
						onClick={() => {
							if (selected.length > 0) {
								answer({ kind: "selection", selections: selected, ...(freeform.trim().length > 0 ? { comment: freeform.trim() } : {}) });
								return;
							}
							answer({ kind: "freeform", text: freeform.trim() });
						}}
						className="rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50"
						style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
					>
						{t("ask.answer")}
					</button>
				</div>
			</div>
		</div>
	);
}
