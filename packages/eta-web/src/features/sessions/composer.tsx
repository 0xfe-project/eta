import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";

interface SlashCommand {
	name: string;
	description: string;
	run: () => void;
}

export function Composer({
	session,
	running,
	hasPendingAsk,
	userTexts = [],
	onNavigateSettings,
}: {
	session: string;
	running: boolean;
	hasPendingAsk: boolean;
	userTexts?: string[];
	onNavigateSettings?: () => void;
}) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [text, setText] = useState("");
	const textRef = useRef(text);
	textRef.current = text;
	const [files, setFiles] = useState<string[]>([]);
	const [pending, setPending] = useState<string[]>([]);
	const [slashIndex, setSlashIndex] = useState(0);
	const [atIndex, setAtIndex] = useState(0);
	const [menuClosed, setMenuClosed] = useState(false);

	const commands: SlashCommand[] = [
		{ name: "compact", description: t("cmd.compact"), run: () => store.send({ op: "compact", session }) },
		{ name: "abort", description: t("cmd.abort"), run: () => store.send({ op: "abort", session }) },
		{ name: "settings", description: t("cmd.settings"), run: () => onNavigateSettings?.() },
	];

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

	const slashQuery = !menuClosed && !mentionQuery && text.startsWith("/") && !text.startsWith("//") && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
	const slashMatches = slashQuery === null ? [] : commands.filter((command) => command.name.startsWith(slashQuery));
	const atChoices = mentionQuery === null ? [] : files.filter((file) => file.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8);
	const menuOpen = slashMatches.length > 0 || atChoices.length > 0;

	const pickFile = (file: string) => {
		setText((current) => current.replace(/(^|\s)@([\w./-]*)$/, (_match, lead: string) => `${lead}@${file} `));
	};

	const runCommand = (command: SlashCommand) => {
		command.run();
		setText("");
	};

	const submit = (mode: "queue" | "steer") => {
		const value = text.trim();
		if (value.length === 0) {
			if (running) store.send({ op: "abort", session });
			return;
		}
		if (value.startsWith("//")) {
			store.send({ op: "prompt", session, text: value.slice(1), ...(mode === "steer" ? { mode } : {}) });
		} else if (value.startsWith("/")) {
			const name = /^\/([^\s]+)/.exec(value)?.[1] ?? "";
			const command = commands.find((entry) => entry.name === name);
			if (command !== undefined) {
				command.run();
				setText("");
				return;
			}
			store.send({ op: "prompt", session, text: value, ...(mode === "steer" ? { mode } : {}) });
		} else {
			store.send({ op: "prompt", session, text: value, ...(mode === "steer" ? { mode } : {}) });
		}
		setPending((current) => [...current, value]);
		setText("");
	};

	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (menuOpen && !menuClosed) {
			if (event.key === "Escape") {
				event.preventDefault();
				setMenuClosed(true);
				return;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const size = slashMatches.length > 0 ? slashMatches.length : atChoices.length;
				const step = event.key === "ArrowDown" ? 1 : -1;
				if (slashMatches.length > 0) setSlashIndex((index) => (index + step + size) % size);
				else setAtIndex((index) => (index + step + size) % size);
				return;
			}
			if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
				event.preventDefault();
				if (slashMatches.length > 0) runCommand(slashMatches[Math.min(slashIndex, slashMatches.length - 1)]!);
				else if (atChoices.length > 0) pickFile(atChoices[Math.min(atIndex, atChoices.length - 1)]!);
				return;
			}
		}
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
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
		<footer className="input-area" data-testid="composer">
			{pending.length > 0 ? (
				<div data-testid="queued-bar" className="queued-messages">
					{pending.map((item, index) => (
						<div key={`${item}-${index}`} className="queued-message-chip">
							{t("composer.queued")} · {item}
						</div>
					))}
				</div>
			) : null}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					submit("queue");
				}}
			>
				<div className="composer-card" data-testid="composer-card">
					{slashMatches.length > 0 ? (
						<div className="skill-slash-menu" role="listbox" data-testid="slash-menu">
							{slashMatches.map((command, index) => (
								<button
									key={command.name}
									type="button"
									role="option"
									aria-selected={index === slashIndex}
									data-testid={`slash-${command.name}`}
									className={`skill-slash-option${index === slashIndex ? " selected" : ""}`}
									onClick={() => runCommand(command)}
								>
									<span className="skill-slash-icon">/</span>
									<span className="skill-slash-name">{command.name}</span>
									<span className="skill-slash-description">{command.description}</span>
								</button>
							))}
						</div>
					) : (
						<div className="skill-slash-menu hidden" />
					)}
					{atChoices.length > 0 ? (
						<div className="at-file-mention-menu" role="listbox" data-testid="mention-popup">
							{atChoices.map((file, index) => (
								<button
									key={file}
									type="button"
									role="option"
									aria-selected={index === atIndex}
									data-testid={`mention-${file}`}
									className={`at-file-mention-option${index === atIndex ? " selected" : ""}`}
									onClick={() => pickFile(file)}
								>
									<span className="at-file-mention-name">@{file}</span>
								</button>
							))}
						</div>
					) : (
						<div className="at-file-mention-menu hidden" />
					)}
					<textarea
						id="message-input"
						data-testid="composer-input"
						rows={2}
						value={text}
						placeholder={t("composer.placeholder")}
						autoComplete="off"
						onChange={(event) => {
							setText(event.target.value);
							setMenuClosed(false);
							const node = event.target;
							node.style.height = "auto";
							node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
						}}
						onKeyDown={onKey}
						onPaste={onPaste}
					/>
					<div className="composer-toolbar">
						<div className="composer-toolbar-left">
							<span className="shortcuts-hint">{running ? t("composer.runningHint") : t("composer.hint")}</span>
						</div>
						<button
							type="submit"
							data-testid="composer-submit"
							disabled={hasPendingAsk}
							className="ui-button ui-button--primary"
						>
							{text.trim().length > 0 ? t("composer.send") : running ? t("composer.stop") : t("composer.send")}
						</button>
					</div>
				</div>
			</form>
		</footer>
	);
}
