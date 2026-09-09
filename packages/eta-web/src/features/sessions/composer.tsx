import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { useAppI18n } from "../../i18n.ts";
import { etaStore, useEta } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { themeStorageKey, themeChangeEvent } from "../../app/theme.tsx";
import { useShellOptional } from "../../app/app-shell.tsx";

interface SlashCommand {
	name: string;
	description: string;
	run: (args: string) => void;
}

export interface ComposerCreate {
	personaReady: boolean;
	cwd: string;
	onCwd: (cwd: string) => void;
	onSend: (text: string, modelId?: string) => void;
}

export function Composer({
	session,
	running = false,
	hasPendingAsk = false,
	queue = [],
	topSlot,
	create,
	onNavigateSettings,
	onToggleTerminal,
}: {
	session?: string;
	running?: boolean;
	hasPendingAsk?: boolean;
	queue?: { entryId: string; kind: string; text: string }[];
	topSlot?: ReactNode;
	create?: ComposerCreate;
	onNavigateSettings?: () => void;
	onToggleTerminal?: () => void;
}) {
	const createMode = create !== undefined;
	const { t, locale, setLocale } = useAppI18n();
	const toggleTheme = () => {
		try {
			localStorage.setItem(themeStorageKey, localStorage.getItem(themeStorageKey) === "dark" ? "light" : "dark");
		} catch {
			/* private mode */
		}
		window.dispatchEvent(new CustomEvent(themeChangeEvent));
	};
	const shell = useShellOptional();
	const store = etaStore();
	const state = useEta();
	const cycleThinking = () => {
		const level = (state.views[session ?? ""]?.thinkingLevel ?? "off") as (typeof THINKING_LEVELS)[number];
		const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf(level) + 1) % THINKING_LEVELS.length];
		store.send({ op: "thinkingLevel", session: session ?? "", level: next });
	};
	const commands: SlashCommand[] = [
		...(createMode || session === undefined
			? []
			: [
					{ name: "compact", description: t("cmd.compact"), run: () => store.send({ op: "compact", session }) },
					{ name: "abort", description: t("cmd.abort"), run: () => store.send({ op: "abort", session }) },
					{ name: "btw", description: t("cmd.btw"), run: () => store.send({ op: "btwOpen", session, kind: "contextual" }) },
					{ name: "goal", description: t("cmd.goal"), run: (args: string) => (args.length > 0 ? store.send({ op: "goal", session, action: "set", objective: args }) : setText("/goal ")) },
					{ name: "loop", description: t("cmd.loop"), run: (args: string) => (args.length > 0 ? store.send({ op: "loopCreate", session, id: `ui-${Date.now().toString(36)}`, note: args }) : setText("/loop ")) },
					{ name: "thinking", description: t("cmd.thinking"), run: () => cycleThinking() },
					{ name: "delete", description: t("cmd.delete"), run: () => store.send({ op: "session.delete", name: session }) },
			  ]),
		{ name: "new", description: t("cmd.new"), run: () => window.location.assign("/new") },
		...(onToggleTerminal === undefined ? [] : [{ name: "terminal", description: t("cmd.terminal"), run: () => onToggleTerminal() }]),
		{ name: "theme", description: t("cmd.theme"), run: () => toggleTheme() },
		{ name: "lang", description: t("cmd.lang"), run: () => setLocale(locale === "en" ? "zh-CN" : "en") },
		{ name: "settings", description: t("cmd.settings"), run: () => onNavigateSettings?.() },
		...(shell === undefined ? [] : [{ name: "help", description: t("cmd.help"), run: () => shell.setPaletteOpen(true) }]),
	];
	const [text, setText] = useState("");
	const [files, setFiles] = useState<string[]>([]);
	const [pickedModel, setPickedModel] = useState<string | undefined>(undefined);
	const [slashIndex, setSlashIndex] = useState(0);
	const [atIndex, setAtIndex] = useState(0);
	const [menuClosed, setMenuClosed] = useState(false);

	const draftKey = `eta.draft.${session ?? "new"}`;
	useEffect(() => {
		setText(localStorage.getItem(draftKey) ?? "");
	}, [draftKey]);

	useEffect(() => {
		if (text.length === 0) localStorage.removeItem(draftKey);
		else localStorage.setItem(draftKey, text);
	}, [text, draftKey]);

	const mention = /(^|\s)@([\w./-]*)$/.exec(text);
	const mentionQuery = mention?.[2] ?? null;

	useEffect(() => {
		if (mentionQuery === null || files.length > 0 || session === undefined) return;
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

	const runCommand = (command: SlashCommand, args = "") => {
		command.run(args);
		setText("");
	};

	const submit = (mode: "queue" | "steer") => {
		const value = text.trim();
		if (createMode && create !== undefined) {
			const plain = value.startsWith("//") ? value.slice(1) : value;
			if (plain.length === 0 || !create.personaReady) return;
			create.onSend(plain, pickedModel);
			setText("");
			return;
		}
		if (session === undefined) return;
		if (value.length === 0) {
			if (running) store.send({ op: "abort", session });
			return;
		}
		if (value.startsWith("//")) {
			store.send({ op: "prompt", session, text: value.slice(1), ...(mode === "steer" ? { mode } : {}) });
		} else if (value.startsWith("/")) {
			const name = /^\/([^\s]+)/.exec(value)?.[1] ?? "";
			const args = value.slice(name.length + 1).trim();
			const command = commands.find((entry) => entry.name === name);
			if (command !== undefined) {
				runCommand(command, args);
				return;
			}
			store.send({ op: "prompt", session, text: value, ...(mode === "steer" ? { mode } : {}) });
		} else {
			store.send({ op: "prompt", session, text: value, ...(mode === "steer" ? { mode } : {}) });
		}
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
				if (slashMatches.length > 0) runCommand(slashMatches[Math.min(slashIndex, slashMatches.length - 1)]!, text.trim().split(/\s+/).slice(1).join(" "));
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
		if (pasted.length <= 4096 || session === undefined) return;
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

	const autoGrow = (node: HTMLTextAreaElement) => {
		node.style.height = "auto";
		node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
	};

	return (
		<footer className="input-area" data-testid="composer">
			<div className="input-outer">
				{topSlot}
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
								<span className="skill-slash-option-name">/{command.name}</span>
								<span className="skill-slash-option-desc">{command.description}</span>
							</button>
						))}
					</div>
				) : null}
				{mentionQuery !== null && !menuClosed ? (
					<div className="at-file-mention-menu" role="listbox" data-testid="mention-popup">
						{atChoices.length === 0 ? <p className="skill-slash-empty">{t("mention.empty")}</p> : null}
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
								<span className="at-file-mention-option-name">@{file}</span>
							</button>
						))}
					</div>
				) : null}
				<form
					className="composer-card"
					data-testid="composer-card"
					onSubmit={(event) => {
						event.preventDefault();
						submit("queue");
					}}
				>
					<textarea
						id="message-input"
						data-testid="composer-input"
						rows={2}
						ref={(node) => { if (node !== null) autoGrow(node); }}
						value={text}
						placeholder={t("composer.placeholder")}
						autoComplete="off"
						onChange={(event) => {
							setText(event.target.value);
							setMenuClosed(false);
							autoGrow(event.target);
						}}
						onKeyDown={onKey}
						onPaste={onPaste}
						className="composer-editor"
					/>
					<div className="composer-toolbar">
						<div className="flex min-w-0 items-center gap-2">
							{createMode || session !== undefined ? (
								<span className={createMode && !create.personaReady ? "opacity-60" : undefined}>
									<ModelPicker {...(session === undefined ? {} : { session })} {...(createMode ? { onPick: setPickedModel } : {})} />
								</span>
							) : null}
							{!createMode && session !== undefined ? <ThinkingChip session={session} /> : null}
							{createMode && create !== undefined ? (
								<input
									data-testid="composer-cwd"
									value={create.cwd}
									placeholder={t("new.cwd")}
									onChange={(event) => create.onCwd(event.target.value)}
									className="mono min-w-0 max-w-[180px] flex-1 border border-border bg-transparent px-1.5 py-0.5 text-[10px] text-muted outline-none focus:border-border-strong"
								/>
							) : null}
							<span className="composer-toolbar-hints min-w-0 truncate">{running ? t("composer.runningHint") : t("composer.hint")}</span>
						</div>
						<Button type="submit" variant="invert" data-testid="composer-submit" disabled={hasPendingAsk || (createMode && create !== undefined && !create.personaReady)}>
							{text.trim().length > 0 || !running ? t("composer.send") : t("composer.stop")}
						</Button>
					</div>
				</form>
			</div>
		</footer>
	);
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

function ThinkingChip({ session }: { session: string }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const state = useEta();
	const level = (state.views[session]?.thinkingLevel ?? "off") as (typeof THINKING_LEVELS)[number];
	const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf(level) + 1) % THINKING_LEVELS.length];
	return (
		<button
			data-testid="thinking-chip"
			title={t("composer.thinkingHint")}
			onClick={() => store.send({ op: "thinkingLevel", session, level: next })}
			className={`mono shrink-0 border border-border-strong px-2 py-1 text-[10px] uppercase tracking-[0.1em] ${level === "off" ? "text-muted" : "text-foreground"}`}
		>
			{t("composer.thinking")}:{level}
		</button>
	);
}
