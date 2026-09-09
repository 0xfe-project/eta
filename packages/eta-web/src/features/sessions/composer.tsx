import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";

export function Composer({ session, running, hasPendingAsk, userTexts = [] }: { session: string; running: boolean; hasPendingAsk: boolean; userTexts?: string[] }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [text, setText] = useState("");
	const textRef = useRef(text);
	textRef.current = text;
	const [files, setFiles] = useState<string[]>([]);
	const [pending, setPending] = useState<string[]>([]);

	useEffect(() => {
		setText(localStorage.getItem(`eta.draft.${session}`) ?? "");
	}, [session]);

	useEffect(() => {
		if (text.length === 0) localStorage.removeItem(`eta.draft.${session}`);
		else localStorage.setItem(`eta.draft.${session}`, text);
	}, [text, session]);

	const seen = userTexts.join("\n");
	useEffect(() => {
		setPending((current) => {
			const next = current.filter((item) => !seen.includes(item));
			return next.length === current.length ? current : next;
		});
	}, [seen]);

	const mention = /(^|\s)@([\w./-]*)$/.exec(text);
	const mentionQuery = mention?.[2] ?? null;

	useEffect(() => {
		if (mentionQuery === null || files.length > 0) return;
		void fetch(`/api/files?session=${encodeURIComponent(session)}`)
			.then((response) => response.json())
			.then((body: string[]) => setFiles(body))
			.catch(() => undefined);
	}, [mentionQuery !== null, session, files.length]);

	const choices = mentionQuery === null ? [] : files.filter((file) => file.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8);

	const pickFile = (file: string) => {
		setText((current) => current.replace(/(^|\s)@([\w./-]*)$/, (_match, lead: string) => `${lead}@${file} `));
	};

	const submit = (mode: "queue" | "steer") => {
		const value = text.trim();
		if (value.length === 0) {
			if (running) store.send({ op: "abort", session });
			return;
		}
		store.send({ op: "prompt", session, text: value, ...(mode === "steer" ? { mode } : {}) });
		setPending((current) => [...current, value]);
		setText("");
	};

	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
		if (event.shiftKey) return;
		if (choices.length > 0) {
			event.preventDefault();
			pickFile(choices[0]!);
			return;
		}
		event.preventDefault();
		submit(event.metaKey || event.ctrlKey ? "steer" : "queue");
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const pasted = event.clipboardData.getData("text");
		if (pasted.length <= 4096) return;
		event.preventDefault();
		void fetch(`/api/paste?session=${encodeURIComponent(session)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: pasted }),
		})
			.then((response) => response.json() as Promise<{ path: string | null }>)
			.then((body) => setText((current) => `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}@${body.path ?? ""} `))
			.catch(() => setText((current) => `${current}${pasted}`));
	};

	return (
		<footer className="relative border-t border-border p-3" data-testid="composer">
			{pending.length > 0 ? (
				<div data-testid="queued-bar" className="mx-auto mb-2 flex max-w-[880px] flex-wrap gap-1">
					{pending.map((item, index) => (
						<span key={`${item}-${index}`} className="max-w-[240px] truncate border border-border bg-elevated px-2 py-0.5 text-[10px] text-muted">
							{t("composer.queued")} · {item}
						</span>
					))}
				</div>
			) : null}
			{choices.length > 0 ? (
				<div data-testid="mention-popup" className="absolute bottom-full left-1/2 mb-1 w-[min(92%,420px)] -translate-x-1/2 border border-border bg-elevated p-1 shadow-[var(--shadow)]">
					{choices.map((file) => (
						<button key={file} data-testid={`mention-${file}`} onClick={() => pickFile(file)} className="mono block w-full px-2 py-1 text-left text-xs hover:bg-overlay">
							@{file}
						</button>
					))}
				</div>
			) : null}
			<div className="mx-auto flex max-w-[880px] items-end gap-2 border border-border bg-elevated p-2">
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
					onPaste={onPaste}
					className="max-h-[220px] min-h-[24px] flex-1 resize-none bg-transparent text-sm outline-none"
				/>
				<button
					data-testid="composer-submit"
					onClick={() => submit("queue")}
					disabled={hasPendingAsk}
					className="bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground disabled:opacity-50"
				>
					{text.trim().length > 0 ? t("composer.send") : running ? t("composer.stop") : t("composer.send")}
				</button>
			</div>
			{running ? (
				<p data-testid="composer-hint" className="mx-auto mt-1 max-w-[880px] text-center text-[10px] text-muted">
					{t("composer.runningHint")}
				</p>
			) : null}
		</footer>
	);
}
