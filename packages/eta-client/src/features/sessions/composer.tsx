import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js";
import { useAppI18n } from "../../i18n.ts";
import { etaStore, useEta } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuChevron } from "../../components/ui/dropdown-menu.tsx";
import { themeStorageKey, themeChangeEvent } from "../../app/theme.tsx";
import { useShellOptional } from "../../app/app-shell.tsx";
import { apiFetch, goto } from "../../lib/host.ts";
import type { ThinkingLevel } from "@eta/core";
import { registerDraftSink } from "../../lib/queue-actions.ts";

/** Subsequence fuzzy score: higher = better match; -1 = no match. */
function fuzzyScore(query: string, target: string): number {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let qi = 0;
	let score = 0;
	let streak = 0;
	for (let i = 0; i < t.length && qi < q.length; i += 1) {
		if (t[i] === q[qi]) {
			streak += 1;
			qi += 1;
			const boundary = i === 0 || /[/.\-_\\]/.test(t[i - 1] ?? "/");
			score += 1 + streak * 2 + (boundary ? 3 : 0);
		} else {
			streak = 0;
		}
	}
	return qi === q.length ? score : -1;
}

interface SlashCommand {
	name: string;
	description: string;
	run: (args: string) => void;
}

export interface ComposerCreate {
	remoteId?: string;
	cwd: string;
	onCwd: (cwd: string) => void;
	/** The server picks a persona when the person did not, so any non-empty text may send. */
	onSend: (text: string, modelId?: string) => void;
}

/**
 * `/loop 5m <note>`: a leading duration is the cadence and the rest is the note.
 * A note with no cadence is still sent, because the server turns it down and says why —
 * inventing a default interval here would schedule something the person did not ask for.
 */
function createLoop(session: string, args: string, setText: (text: string) => void): void {
	const parts = args.trim().split(/\s+/);
	const head = parts[0] ?? "";
	const rest = parts.slice(1).join(" ").trim();
	const every = /^\d+(ms|s|m|h|d)?$/i.test(head) && rest.length > 0 ? head : undefined;
	const note = every === undefined ? args.trim() : rest;
	if (note.length === 0) {
		setText("/loop ");
		return;
	}
	etaStore().send({
		op: "loopCreate",
		session,
		id: `ui-${Date.now().toString(36)}`,
		note,
		...(every === undefined ? {} : { every }),
	});
}

export function Composer(props: {
	session?: string;
	running?: boolean;
	hasPendingAsk?: boolean;
	queue?: { entryId: string; kind: string; text: string }[];
	topSlot?: JSX.Element;
	create?: ComposerCreate;
	onNavigateSettings?: () => void;
	onToggleTerminal?: () => void;
	/** Raise the btw dialog: `/btw` is answered by the dialog, not by a message. */
	onBtw?: () => void;
}) {
	const i18n = useAppI18n();
	const createMode = () => props.create !== undefined;
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
	const availableThinking = () => state.views[props.session ?? ""]?.supportedThinkingLevels ?? THINKING_LEVELS;
	const cycleThinking = () => {
		const level = state.views[props.session ?? ""]?.thinkingLevel ?? "off";
		const levels = availableThinking();
		if (levels.length < 2 || !props.session) return;
		const next = levels[(levels.indexOf(level as ThinkingLevel) + 1) % levels.length];
		store.send({ op: "thinkingLevel", session: props.session ?? "", level: next });
	};

	const [text, setText] = createSignal("");
	const [files, setFiles] = createSignal<string[]>([]);
	const [pickedModel, setPickedModel] = createSignal<string | undefined>(undefined);
	createEffect(on(() => props.create?.remoteId, () => setPickedModel(undefined)));
	const [slashIndex, setSlashIndex] = createSignal(0);
	const [atIndex, setAtIndex] = createSignal(0);
	const [menuClosed, setMenuClosed] = createSignal(false);
	const [pendingImages, setPendingImages] = createSignal<{ name: string; mime: string; dataBase64: string }[]>([]);
	const [toolboxOpen, setToolboxOpen] = createSignal(false);
	const [toolFiles, setToolFiles] = createSignal<string[]>([]);
	const [toolQuery, setToolQuery] = createSignal("");
	/** Only while a file is actually over the box: the border is the whole answer to
	 * "can I drop here", so it must not sit there permanently. */
	const [dragOver, setDragOver] = createSignal(false);
	let fileInput: HTMLInputElement | undefined;
	let imageInput: HTMLInputElement | undefined;

	const commands = createMemo<SlashCommand[]>(() => {
		const t = i18n.t;
		const session = props.session;
		return [
			...(createMode() || session === undefined
				? []
				: [
						{ name: "compact", description: t("cmd.compact"), run: () => store.send({ op: "compact", session }) },
						{ name: "abort", description: t("cmd.abort"), run: () => store.send({ op: "abort", session }) },
						{ name: "btw", description: t("cmd.btw"), run: () => props.onBtw?.() },
						{ name: "goal", description: t("cmd.goal"), run: (args: string) => (args.length > 0 ? store.send({ op: "goal", session, action: "set", objective: args }) : setText("/goal ")) },
						{ name: "loop", description: t("cmd.loop"), run: (args: string) => createLoop(session, args, setText) },
						{ name: "thinking", description: t("cmd.thinking"), run: () => cycleThinking() },
						{ name: "delete", description: t("cmd.delete"), run: () => store.send({ op: "session.delete", name: session }) },
					]),
			{ name: "new", description: t("cmd.new"), run: () => goto("/new") },
			...(props.onToggleTerminal === undefined ? [] : [{ name: "terminal", description: t("cmd.terminal"), run: () => props.onToggleTerminal?.() }]),
			{ name: "theme", description: t("cmd.theme"), run: () => toggleTheme() },
			{ name: "lang", description: t("cmd.lang"), run: () => i18n.setLocale(i18n.locale === "en" ? "zh-CN" : "en") },
			{ name: "settings", description: t("cmd.settings"), run: () => props.onNavigateSettings?.() },
			...(shell === undefined ? [] : [{ name: "help", description: t("cmd.help"), run: () => shell.setPaletteOpen(true) }]),
		];
	});

	const draftKey = () => `eta.draft.${props.session ?? "new"}`;
	createEffect(
		on(draftKey, (key) => {
			setText(localStorage.getItem(key) ?? "");
		}),
	);
	createEffect(() => {
		const key = draftKey();
		const value = text();
		if (value.length === 0) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	});

	const mentionQuery = createMemo(() => {
		const mention = /(^|\s)@([\w./-]*)$/.exec(text());
		return mention?.[2] ?? null;
	});
	const mentionOpen = createMemo(() => mentionQuery() !== null);

	createEffect(() => {
		const open = mentionOpen();
		const session = props.session;
		const n = files().length;
		if (!open || n > 0 || session === undefined) return;
		void apiFetch(`/api/files?session=${encodeURIComponent(session)}`)
			.then((response) => response.json())
			.then((body: string[]) => setFiles(body))
			.catch(() => undefined);
	});

	const slashQuery = createMemo(() => {
		const value = text();
		return !menuClosed() && mentionQuery() === null && value.startsWith("/") && !value.startsWith("//") && !/\s/.test(value) ? value.slice(1).toLowerCase() : null;
	});
	const slashMatches = createMemo(() => {
		const query = slashQuery();
		return query === null ? [] : commands().filter((command) => command.name.startsWith(query));
	});
	const atChoices = createMemo(() => {
		const query = mentionQuery();
		return query === null ? [] : files().map((file) => ({ file, score: fuzzyScore(query, file) })).filter((entry) => entry.score >= 0).sort((a, b) => b.score - a.score).slice(0, 8).map((entry) => entry.file);
	});
	const menuOpen = createMemo(() => slashMatches().length > 0 || atChoices().length > 0);

	const pickFile = (file: string) => {
		setText((current) => current.replace(/(^|\s)@([\w./-]*)$/, (_match, lead: string) => `${lead}@${file} `));
	};

	const runCommand = (command: SlashCommand, args = "") => {
		command.run(args);
		setText("");
	};

	const openToolbox = () => {
		const next = !toolboxOpen();
		setToolboxOpen(next);
		setToolQuery("");
		if (!next || toolFiles().length > 0) return;
		const session = props.session;
		if (session !== undefined) void apiFetch(`/api/files?session=${encodeURIComponent(session)}`).then((r) => r.json() as Promise<string[]>).then(setToolFiles).catch(() => undefined);

	};
	const toolChoices = createMemo(() => {
		const query = toolQuery();
		const list = toolFiles();
		return query.length === 0 ? list.slice(0, 12) : list.map((file) => ({ file, score: fuzzyScore(query, file) })).filter((entry) => entry.score >= 0).sort((a, b) => b.score - a.score).slice(0, 12).map((entry) => entry.file);
	});

	const attachFile = (file: File, asImage: boolean) => {
		const session = props.session;
		if (session === undefined) return;
		const form = new FormData();
		form.append("file", file);
		void apiFetch(`/api/upload?session=${encodeURIComponent(session)}`, { method: "POST", body: form })
			.then((response) => response.json() as Promise<{ path?: string }>)
			.then((body) => {
				if (body.path === undefined) return;
				setText((textValue) => `${textValue}${textValue.endsWith(" ") || textValue.length === 0 ? "" : " "}@${body.path} `);
				void apiFetch(`/api/files?session=${encodeURIComponent(session)}`)
					.then((response) => response.json() as Promise<string[]>)
					.then(setFiles)
					.catch(() => undefined);
				if (!asImage) return;
				const reader = new FileReader();
				reader.onload = () => {
					const url = String(reader.result ?? "");
					setPendingImages((list) => [...list, { name: file.name, mime: file.type || "application/octet-stream", dataBase64: url.slice(url.indexOf(",") + 1) }]);
				};
				reader.readAsDataURL(file);
			})
			.catch(() => undefined);
	};

	/** The box itself, so a draft handed back by a queue chip can take the caret. */
	let editor: HTMLTextAreaElement | undefined;

	/**
	 * Where「拉回」lands: *above* what is being typed, blank line between, so pulling an
	 * entry back never swallows half a sentence and two pulls in a row land newest-first.
	 * Registered rather than subscribed because two composers can be mounted at once (the
	 * empty sessions page shows a welcome one) — see the note in lib/queue-actions.ts.
	 */
	onCleanup(
		registerDraftSink((pulled) => {
			setText((current) => (current.trim().length === 0 ? pulled : `${pulled}\n\n${current}`));
			// It came back to be edited, so the caret goes where the editing happens.
			editor?.focus();
		}),
	);

	const submit = (mode: "queue" | "steer") => {
		const value = text().trim();
		const imagesPayload = pendingImages().length > 0 ? { images: pendingImages().map((image) => ({ mime: image.mime, dataBase64: image.dataBase64 })) } : {};
		const create = props.create;
		if (createMode() && create !== undefined) {
			const plain = value.startsWith("//") ? value.slice(1) : value;
			if (plain.length === 0) return;
			create.onSend(plain, pickedModel());
			setText("");
			return;
		}
		const session = props.session;
		if (session === undefined) return;
		if (value.length === 0 && pendingImages().length > 0) {
			store.send({ op: "prompt", session, text: "", ...imagesPayload });
			setPendingImages([]);
			return;
		}
		if (value.length === 0) {
			if (props.running) store.send({ op: "abort", session });
			return;
		}
		if (value.startsWith("//")) {
			store.send({ op: "prompt", session, text: value.slice(1), ...(mode === "steer" ? { mode } : {}), ...imagesPayload });
		} else if (value.startsWith("/")) {
			const name = /^\/([^\s]+)/.exec(value)?.[1] ?? "";
			const args = value.slice(name.length + 1).trim();
			const command = commands().find((entry) => entry.name === name);
			if (command !== undefined) {
				runCommand(command, args);
				return;
			}
			store.send({ op: "prompt", session, text: value, ...(mode === "steer" ? { mode } : {}) });
		} else {
			store.send({ op: "prompt", session, text: value, ...(mode === "steer" ? { mode } : {}), ...imagesPayload });
		}
		setPendingImages([]);
		setText("");
	};

	/**
	 * Is this Enter the IME finishing a word rather than the user sending?
	 *
	 * Three engines, three orders, so all three are answered — measured in a real
	 * browser, not assumed:
	 * - Chrome mid-composition flags the key: `isComposing`.
	 * - WebKit reports nothing but the legacy `keyCode: 229`, with isComposing false.
	 * - macOS Pinyin typed as ASCII commits the letters on Enter and closes the
	 *   composition *before* it delivers the key, so the keydown looks ordinary.
	 *
	 * The window after compositionend is short on purpose: long enough to swallow the
	 * Enter that committed the text, too short to eat a deliberate second press.
	 */
	const ime = { composing: false, endedAt: 0 };
	const imeOwnedEnter = (event: KeyboardEvent): boolean =>
		event.isComposing
		|| event.keyCode === 229
		|| ime.composing
		|| performance.now() - ime.endedAt < 120;

	const onKey = (event: KeyboardEvent) => {
		// ⌘⏎ means "send" whatever the menu is offering: steering a running turn must
		// not depend on whether a slash menu happens to be open at that moment.
		const forceSend = (event.metaKey || event.ctrlKey) && !event.shiftKey;
		if (menuOpen() && !menuClosed() && !forceSend) {
			if (event.key === "Escape") {
				event.preventDefault();
				setMenuClosed(true);
				return;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const size = slashMatches().length > 0 ? slashMatches().length : atChoices().length;
				const step = event.key === "ArrowDown" ? 1 : -1;
				if (slashMatches().length > 0) setSlashIndex((index) => (index + step + size) % size);
				else setAtIndex((index) => (index + step + size) % size);
				return;
			}
			if (event.key === "Enter" && !event.shiftKey && !imeOwnedEnter(event)) {
				event.preventDefault();
				if (slashMatches().length > 0) runCommand(slashMatches()[Math.min(slashIndex(), slashMatches().length - 1)]!, text().trim().split(/\s+/).slice(1).join(" "));
				else if (atChoices().length > 0) pickFile(atChoices()[Math.min(atIndex(), atChoices().length - 1)]!);
				return;
			}
		}
		if (event.key !== "Enter" || event.shiftKey || imeOwnedEnter(event)) return;
		event.preventDefault();
		submit(event.metaKey || event.ctrlKey ? "steer" : "queue");
	};

	/** One uploaded file becomes an `@path` at the caret; paste and drop share it. */
	const uploadFiles = (uploaded: File[]): void => {
		const session = props.session;
		if (uploaded.length === 0 || session === undefined) return;
		for (const file of uploaded) {
			const form = new FormData();
			form.append("file", file);
			void apiFetch(`/api/upload?session=${encodeURIComponent(session)}`, { method: "POST", body: form })
				.then((response) => response.json() as Promise<{ path?: string }>)
				.then((body) => setText((current) => `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}${body.path ? `@${body.path}` : ""} `))
				.catch(() => undefined);
		}
		void apiFetch(`/api/files?session=${encodeURIComponent(session)}`)
			.then((response) => response.json() as Promise<string[]>)
			.then(setFiles)
			.catch(() => undefined);
	};

	/** A file dropped anywhere else on the page would navigate the browser to
	 * `file:///…` and lose the draft; the global rule swallows it, here we answer it. */
	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		setDragOver(false);
		uploadFiles(Array.from(event.dataTransfer?.files ?? []));
	};

	const onPaste = (event: ClipboardEvent) => {
		const pastedFiles = Array.from(event.clipboardData?.files ?? []);
		const session = props.session;
		if (pastedFiles.length > 0) {
			if (session === undefined) return;
			event.preventDefault();
			uploadFiles(pastedFiles);
			return;
		}
		const pasted = event.clipboardData?.getData("text") ?? "";
		if (pasted.length <= 4096 || session === undefined) return;
		event.preventDefault();
		void apiFetch(`/api/paste?session=${encodeURIComponent(session)}`, {
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
		<footer class="input-area" data-testid="composer">
			<div class="input-outer">
				{props.topSlot}
				<Show when={toolboxOpen()}>
					<div data-testid="composer-toolbox" class="absolute bottom-[calc(100%+6px)] left-0 right-0 z-30 max-h-[60vh] overflow-y-auto border-2 border-border-strong bg-elevated p-2 shadow-[4px_4px_0_0_var(--shadow)]">
						<div class="mb-2 flex flex-wrap gap-1.5">
							<button data-testid="attach-upload" class="border border-border px-2 py-1 text-xs uppercase tracking-[0.08em] hover:bg-overlay" onClick={() => fileInput?.click()}>
								{i18n.t("composer.uploadFile")}
							</button>
							<button data-testid="attach-image" class="border border-border px-2 py-1 text-xs uppercase tracking-[0.08em] hover:bg-overlay" onClick={() => imageInput?.click()}>
								{i18n.t("composer.pickImage")}
							</button>
							<Show when={props.session !== undefined && !createMode()}>
								<button
									data-testid="attach-btw"
									class="border border-border px-2 py-1 text-xs uppercase tracking-[0.08em] hover:bg-overlay"
									onClick={() => {
										setToolboxOpen(false);
										store.send({ op: "btwOpen", session: props.session ?? "", kind: "tangent" });
									}}
								>
									{i18n.t("composer.newBtw")}
								</button>
							</Show>
						</div>
						<Show when={!createMode() && props.session !== undefined}>
							<p class="mono mb-1 text-[10px] uppercase tracking-[0.12em] text-muted">{i18n.t("composer.files")}</p>
							<input
								data-testid="toolbox-file-search"
								value={toolQuery()}
								onInput={(event) => setToolQuery(event.currentTarget.value)}
								placeholder={i18n.t("composer.fileSearch")}
								class="mono mb-1 w-full border border-border bg-transparent px-2 py-1 text-[11px] outline-none focus:border-border-strong"
							/>
							<div data-testid="toolbox-files" class="mb-2 grid max-h-[30vh] gap-0.5 overflow-y-auto">
								<Show when={toolChoices().length === 0}>
									<p class="skill-slash-empty">{i18n.t("mention.empty")}</p>
								</Show>
								<For each={toolChoices()}>
									{(file) => (
										<button
											data-testid={`toolbox-file-${file}`}
											onClick={() => {
												setText((current) => `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}@${file} `);
												setToolboxOpen(false);
											}}
											class="mono truncate border border-border px-2 py-1 text-left text-[11px] hover:bg-overlay"
										>
											@{file}
										</button>
									)}
								</For>
							</div>
						</Show>
						<p class="mono mb-1 text-[10px] uppercase tracking-[0.12em] text-muted">{i18n.t("composer.commands")}</p>
						<div data-testid="toolbox-commands" class="grid gap-0.5">
							<For each={commands().filter(command => command.name !== "thinking")}>
								{(command) => (
									<button
										data-testid={`toolbox-command-${command.name}`}
										onClick={() => {
											command.run("");
											setToolboxOpen(false);
										}}
										class="border border-border px-2 py-1 text-left text-xs hover:bg-overlay"
									>
										<span class="mono">/{command.name}</span> <span class="text-muted">{command.description}</span>
									</button>
								)}
							</For>
						</div>
					</div>
				</Show>
				<Show when={pendingImages().length > 0}>
					<div data-testid="attach-chips" class="flex flex-wrap gap-1 pb-1">
						<For each={pendingImages()}>
							{(image, index) => (
								<span data-testid={`attach-chip-${index()}`} class="flex items-center gap-1 border border-border-strong bg-elevated px-1.5 py-0.5 text-[10px]">
									<img src={`data:${image.mime};base64,${image.dataBase64}`} alt="" class="h-5 w-5 object-cover" />
									<span class="mono max-w-[120px] truncate">{image.name}</span>
									<button data-testid={`attach-chip-drop-${index()}`} class="text-muted hover:text-foreground" onClick={() => setPendingImages((list) => list.filter((_, position) => position !== index()))}>
										×
									</button>
								</span>
							)}
						</For>
					</div>
				</Show>
				<Show when={slashMatches().length > 0}>
					<div class="skill-slash-menu" role="listbox" data-testid="slash-menu">
						<For each={slashMatches()}>
							{(command, index) => (
								<button
									type="button"
									role="option"
									aria-selected={index() === slashIndex()}
									data-testid={`slash-${command.name}`}
									class={`skill-slash-option${index() === slashIndex() ? " selected" : ""}`}
									onClick={() => runCommand(command)}
								>
									<span class="skill-slash-option-name">/{command.name}</span>
									<span class="skill-slash-option-desc">{command.description}</span>
								</button>
							)}
						</For>
					</div>
				</Show>
				<Show when={mentionQuery() !== null && !menuClosed()}>
					<div class="at-file-mention-menu" role="listbox" data-testid="mention-popup">
						<Show when={atChoices().length === 0}>
							<p class="skill-slash-empty">{i18n.t("mention.empty")}</p>
						</Show>
						<For each={atChoices()}>
							{(file, index) => (
								<button
									type="button"
									role="option"
									aria-selected={index() === atIndex()}
									data-testid={`mention-${file}`}
									class={`at-file-mention-option${index() === atIndex() ? " selected" : ""}`}
									onClick={() => pickFile(file)}
								>
									<span class="at-file-mention-option-name">@{file}</span>
								</button>
							)}
						</For>
					</div>
				</Show>
				<form
					class={`composer-card${dragOver() ? " drag-over" : ""}`}
					data-testid="composer-card"
					onDragOver={(event: DragEvent) => {
						if (props.session === undefined) return;
						event.preventDefault();
						event.stopPropagation();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={onDrop}
					onSubmit={(event) => {
						event.preventDefault();
						submit("queue");
					}}
				>
					<textarea
						id="message-input"
						data-testid="composer-input"
						rows={2}
						/* A chat box is not a document: the red squiggle under a filename
						   or a pinyin transliteration is the loudest web-page tell there is. */
						spellcheck={false}
						onCompositionStart={() => {
							ime.composing = true;
						}}
						onCompositionEnd={() => {
							ime.composing = false;
							ime.endedAt = performance.now();
						}}
						ref={(node) => {
							editor = node;
							if (node !== undefined) autoGrow(node);
						}}
						value={text()}
						placeholder={i18n.t("composer.placeholder")}
						autocomplete="off"
						onInput={(event) => {
							setText(event.currentTarget.value);
							setMenuClosed(false);
							autoGrow(event.currentTarget);
						}}
						onKeyDown={onKey}
						onPaste={onPaste}
						class="composer-editor"
					/>
					<div class="composer-toolbar">
						<div class="composer-controls flex min-w-0 items-center gap-2">
							<Show when={!createMode() && props.session !== undefined}>
								<div class="relative shrink-0">
									<button
										type="button"
										data-testid="composer-plus"
										title={i18n.t("composer.attach")}
										class="composer-control composer-control-icon"
										onClick={openToolbox}
									>
										+
									</button>
									<input
										ref={(node) => {
											fileInput = node;
										}}
										type="file"
										class="hidden"
										onChange={(event) => {
											const file = event.currentTarget.files?.[0];
											if (file !== undefined) attachFile(file, false);
											event.currentTarget.value = "";
										}}
									/>
									<input
										ref={(node) => {
											imageInput = node;
										}}
										type="file"
										accept="image/*"
										class="hidden"
										onChange={(event) => {
											const file = event.currentTarget.files?.[0];
											if (file !== undefined) attachFile(file, true);
											event.currentTarget.value = "";
										}}
									/>
								</div>
							</Show>
							<Show when={createMode() || props.session !== undefined}>
								<span class="composer-model-container">
									<ModelPicker remoteId={props.create?.remoteId} {...(props.session === undefined ? {} : { session: props.session })} {...(createMode() ? { onPick: setPickedModel } : {})} />
								</span>
							</Show>
							<Show when={!createMode() && props.session !== undefined}>
								<ThinkingChip session={props.session ?? ""} />
							</Show>
							<Show when={createMode() && props.create !== undefined}>
								<input
									data-testid="composer-cwd"
									value={props.create?.cwd ?? ""}
									placeholder={i18n.t("new.cwd")}
									onInput={(event) => props.create?.onCwd(event.currentTarget.value)}
									class="mono min-w-0 max-w-[180px] flex-1 border border-border bg-transparent px-1.5 py-0.5 text-[10px] text-muted outline-none focus:border-border-strong"
								/>
							</Show>
							<span class="composer-toolbar-hints min-w-0 truncate max-md:hidden">{props.running ? i18n.t("composer.runningHint") : i18n.t("composer.hint")}</span>
						</div>
						<Button type="submit" variant="invert" class="composer-control composer-submit-control" data-testid="composer-submit" disabled={props.hasPendingAsk === true}>
							{text().trim().length > 0 || !props.running ? i18n.t("composer.send") : i18n.t("composer.stop")}
						</Button>
					</div>
				</form>
			</div>
		</footer>
	);
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

function ThinkingChip(props: { session: string }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const state = useEta();
	const level = () => state.views[props.session]?.thinkingLevel ?? "off";
	const levels = () => state.views[props.session]?.supportedThinkingLevels ?? THINKING_LEVELS;
	const label = () => `${i18n.t("composer.thinking")}:${levels().length === 0 ? i18n.t("composer.providerThinking") : level()}`;
	return <DropdownMenu>
		<DropdownMenuTrigger data-testid="thinking-chip" class="composer-control composer-thinking-control" disabled={levels().length < 2} title={i18n.t("composer.thinkingHint")}>
			<span class="composer-control-label">{label()}</span><DropdownMenuChevron />
		</DropdownMenuTrigger>
		<DropdownMenuContent side="top" align="end" data-testid="thinking-menu">
			<For each={levels()}>{choice => <DropdownMenuItem data-testid={`thinking-option-${choice}`} role="menuitemradio" aria-checked={choice === level()} onClick={() => {
				if (choice !== level()) store.send({ op: "thinkingLevel", session: props.session, level: choice });
			}}><span class="mono">{choice}</span><Show when={choice === level()}><span class="ml-auto" aria-hidden="true">✓</span></Show></DropdownMenuItem>}</For>
		</DropdownMenuContent>
	</DropdownMenu>;
}
