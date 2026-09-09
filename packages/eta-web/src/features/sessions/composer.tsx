import { useState, type KeyboardEvent } from "react";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";

export function Composer({ session, running, hasPendingAsk }: { session: string; running: boolean; hasPendingAsk: boolean }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [text, setText] = useState("");

	const submit = () => {
		const value = text.trim();
		if (value.length === 0) {
			if (running) store.send({ op: "abort", session });
			return;
		}
		store.send({ op: "prompt", session, text: value });
		setText("");
	};

	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<footer className="border-t border-border p-3" data-testid="composer">
			<div className="mx-auto flex max-w-[880px] items-end gap-2 rounded-xl border border-border bg-elevated p-2">
				<textarea
					data-testid="composer-input"
					rows={1}
					value={text}
					placeholder={t("composer.placeholder")}
					onChange={(event) => {
						setText(event.target.value);
						const node = event.target;
						node.style.height = "auto";
						node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
					}}
					onKeyDown={onKey}
					className="max-h-[220px] min-h-[24px] flex-1 resize-none bg-transparent text-sm outline-none"
				/>
				<button
					data-testid="composer-submit"
					onClick={submit}
					disabled={hasPendingAsk}
					className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground disabled:opacity-50"
					style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
				>
					{text.trim().length > 0 ? t("composer.send") : running ? t("composer.stop") : t("composer.send")}
				</button>
			</div>
			{running ? <p className="mx-auto mt-1 max-w-[880px] text-center text-[10px] text-muted">{t("composer.queueHint")}</p> : null}
		</footer>
	);
}
