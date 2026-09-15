import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { useAppI18n } from "../i18n.ts";
import { etaStore, useEta } from "../lib/eta-store.ts";
import { apiFetch, host } from "../lib/host.ts";
import { NativeActions, onNativeActions, pickFolder } from "../lib/native.ts";

interface PersonaSummary {
	id: string;
	name: string;
	description: string;
	custom: boolean;
}

export function NewSessionPage() {
	const i18n = useAppI18n();
	const store = etaStore();
	const state = useEta();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const [personas, setPersonas] = createSignal<PersonaSummary[]>([]);
	const [personaId, setPersonaId] = createSignal<string | null>(null);
	/*
	 * The folder a session is born into decides its memory, its skills and its git status,
	 * so an empty box is not neutral: the server takes its own launch directory, and the
	 * person gets a project they never picked. The box is therefore prefilled, in order of
	 * how explicitly it was asked for — the group header's 「+」 (`/new?cwd=`), the configured
	 * default folder, the folder of the session just open — and creating with it blank says
	 * so on the way out rather than deciding in silence.
	 */
	const [cwd, setCwd] = createSignal(
		[
			typeof params.cwd === "string" ? params.cwd : "",
			state.sessions.find((session) => session.cwd !== undefined)?.cwd ?? "",
		].find((value) => value.trim().length > 0)?.trim() ?? "",
	);
	const [prompt, setPrompt] = createSignal("");
	const [creating, setCreating] = createSignal(false);
	const [remembered, setRemembered] = createSignal(false);
	// The host's configured defaults, so a fresh browser doesn't start blank.
	const [defaults, setDefaults] = createSignal<{ personaId?: string; modelId?: string; cwd?: string }>({});

	// Nothing picked by hand yet — take the configured default when it actually exists.
	const preselect = (list: PersonaSummary[]) => {
		const preferred = defaults().personaId;
		if (personaId() === null && preferred !== undefined && list.some((persona) => persona.id === preferred)) {
			setPersonaId(preferred);
		}
	};

	onMount(() => {
		let live = true;
		void apiFetch("/api/settings")
			.then((response) => response.json())
			.then((body: { personaId?: string; modelId?: string; cwd?: string }) => {
				if (!live) return;
				setDefaults(body ?? {});
				preselect(personas());
				// A folder in the URL is the sharper intent and wins; otherwise a configured
				// default folder fills a box nothing else managed to fill.
				const picked = typeof params.cwd === "string" ? params.cwd.trim() : "";
				const stored = (body?.cwd ?? "").trim();
				if (picked.length === 0 && stored.length > 0) setCwd((current) => (current.trim().length > 0 ? current : stored));
			})
			.catch(() => undefined);
		const load = () => {
			void apiFetch("/api/personas")
				.then((response) => response.json())
				.then((body: PersonaSummary[]) => {
					if (!live) return;
					setPersonas(body);
					preselect(body);
				})
				.catch(() => undefined);
		};
		load();
		window.addEventListener("eta:personas", load);
		onCleanup(() => {
			live = false;
			window.removeEventListener("eta:personas", load);
		});
	});

	/** The shell's own folder picker; a browser tab has no equivalent, so the button
 * is not offered there rather than offered and dead. */
	const browse = async () => {
		const starting = cwd().trim();
		const picked = await pickFolder(starting.length > 0 ? starting : undefined);
		if (typeof picked === "string" && picked.length > 0) setCwd(picked);
	};

	/* ⌘O lives in the shell's menu bar, so it arrives as an action and not a click.
	 * The item exists whether or not this page is on screen; answering it here, and
	 * only here, is what keeps it from opening a dialog over some other view. */
	const stopFolderAction = onNativeActions({ [NativeActions.openFolder]: () => void browse() });
	onCleanup(stopFolderAction);

	const create = () => {
		const id = personaId();
		const firstPrompt = prompt().trim();
		// With neither a card nor a message there is nothing to infer a persona from, and a chat
		// that opens on a card the model invented for an empty box is a coin flip, not a choice.
		if (id === null && firstPrompt.length === 0) return;
		setCreating(true);
		const folder = cwd().trim();
		store.send({
			op: "session.create",
			name: `eta-${Date.now().toString(36)}`,
			...(id === null ? {} : { personaId: id }),
			...(folder.length > 0 ? { cwd: folder } : {}),
			...(firstPrompt.length > 0 ? { prompt: firstPrompt } : {}),
			...(defaults().modelId === undefined ? {} : { modelId: defaults().modelId }),
		});
		if (remembered() && folder.length > 0)
			void apiFetch("/api/settings", { method: "POST", body: JSON.stringify({ cwd: folder }) }).catch(() => undefined);
		void navigate("/");
	};

	return (
		<main class="mx-auto flex h-full w-full max-w-[720px] flex-col gap-4 overflow-y-auto p-6" data-testid="new-page">
			<div class="flex items-center gap-2">
				<h1 class="text-lg font-semibold">{i18n.t("new.title")}</h1>
				{/* The page replaces the whole transcript area, so it has to give that space back. */}
				<button
					data-testid="new-close"
					title={i18n.t("new.close")}
					onClick={() => navigate("/")}
					class="ml-auto border border-border px-2.5 py-1 text-sm leading-none text-muted hover:bg-foreground hover:text-background"
				>
					×
				</button>
			</div>
			<p data-testid="persona-hint" class="text-sm text-muted">{i18n.t("new.pickPersona")}</p>
			<div class="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="persona-grid">
				<For each={personas()}>
					{(persona) => (
						<button
							data-testid={`persona-card-${persona.id}`}
							data-selected={personaId() === persona.id ? "1" : "0"}
							onClick={() => setPersonaId(persona.id)}
							class={`border-2 p-3 text-left ${personaId() === persona.id ? "border-primary bg-primary text-primary-foreground shadow-[4px_4px_0_0_var(--shadow)]" : "border-border hover:border-border-strong"}`}
						>
							<div class="flex items-center gap-1.5 text-sm font-medium">
								{persona.name}
								<Show when={persona.custom}>
									<span data-testid={`persona-custom-${persona.id}`} class="border border-current px-1 text-[8px] uppercase">{i18n.t("persona.custom")}</span>
								</Show>
							</div>
							<div class={`mt-1 line-clamp-2 text-xs ${personaId() === persona.id ? "text-primary-foreground/70" : "text-muted"}`}>{persona.description}</div>
						</button>
					)}
				</For>
			</div>
			<div class="flex items-center gap-2">
				<input data-testid="cwd-input" value={cwd()} placeholder={i18n.t("new.cwd")} onInput={(event) => setCwd(event.currentTarget.value)} class="min-w-0 flex-1 border-2 border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-strong" />
				<Show when={host().kind === "desktop"}>
					<button
						data-testid="cwd-browse"
						title={i18n.t("new.browse")}
						onClick={() => void browse()}
						class="shrink-0 whitespace-nowrap border-2 border-border bg-background px-3 py-2 text-sm text-muted hover:border-border-strong"
					>
						{i18n.t("new.browse")}
					</button>
				</Show>
			</div>
			<p data-testid="cwd-hint" class="-mt-2 text-[11px] text-faint">
				{cwd().trim().length > 0 ? i18n.t("new.cwdHint", { cwd: cwd().trim() }) : i18n.t("new.cwdBlank")}
			</p>
			<button
				data-testid="cwd-remember"
				aria-pressed={remembered() ? "true" : "false"}
				onClick={() => setRemembered((current) => !current)}
				class={`-mt-2 self-start border px-2 py-1 text-[11px] ${remembered() ? "border-primary text-primary" : "border-border text-muted hover:border-border-strong"}`}
			>
				{remembered() ? "✓ " : ""}
				{i18n.t("new.cwdRemember")}
			</button>
			<textarea data-testid="prompt-input" rows={3} value={prompt()} placeholder={i18n.t("new.firstPrompt")} onInput={(event) => setPrompt(event.currentTarget.value)} class="border-2 border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-strong" />
			<div class="flex items-center gap-3">
				<button
					data-testid="create-session"
					disabled={creating() || (personaId() === null && prompt().trim().length === 0)}
					onClick={create}
					class="border-2 border-primary bg-primary px-4 py-2 font-mono text-sm font-bold tracking-[0.12em] text-primary-foreground uppercase disabled:opacity-40"
					style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
				>
					{creating() ? i18n.t("new.creating") : i18n.t("new.create")}
				</button>
				<Show when={personaId() === null}>
					<span data-testid={prompt().trim().length > 0 ? "persona-auto" : "persona-required"} class="text-xs text-warning">
						{i18n.t(prompt().trim().length > 0 ? "new.personaAutoPick" : "new.personaRequired")}
					</span>
				</Show>
			</div>
		</main>
	);
}
