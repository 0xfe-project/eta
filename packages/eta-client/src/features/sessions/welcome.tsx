import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Composer, type ComposerCreate } from "./composer.tsx";
import { apiFetch, nativeAvailable } from "../../lib/host.ts";
import { NativeActions, onNativeActions, pickFolder } from "../../lib/native.ts";
import { remoteApiPath, remoteSessionName } from "../../lib/remotes.ts";
import { WorkspaceTarget } from "./workspace-target.tsx";

interface PersonaSummary {
	id: string;
	name: string;
	description: string;
	custom: boolean;
}

/**
 * The one new-session surface. It is what the empty sessions page shows and what `/new`
 * shows over an open session — one component, because both are the same question: which
 * persona, which folder, what first. The `/new` route adds nothing but the way back, so
 * the sharper folder it is handed arrives as `initialCwd` and everything else is decided here.
 */
export function Welcome(props: {
	onCreated: (name: string) => void;
	onNavigateSettings: () => void;
	/** Folder the caller already settled on — the group header's 「+」, or the session being left. */
	initialCwd?: string;
	initialRemoteId?: string;
}) {
	const i18n = useAppI18n();
	const store = etaStore();
	const [personas, setPersonas] = createSignal<PersonaSummary[]>([]);
	const [personaId, setPersonaId] = createSignal<string | null>(null);
	const [cwd, setCwd] = createSignal(props.initialCwd ?? "");
	const [remoteId, setRemoteId] = createSignal<string | undefined>(props.initialRemoteId);
	const [remembered, setRemembered] = createSignal(false);
	const [creating, setCreating] = createSignal(false);
	let pendingName: string | undefined;
	onCleanup(store.subscribe((frame) => {
		if (!pendingName || !frame || !("type" in frame)) return;
		if (frame.type === "created" && frame.name === pendingName) {
			pendingName = undefined;
			setCreating(false);
			store.send({ op: "focus", session: frame.name });
			props.onCreated(frame.name);
		} else if (frame.type === "error") {
			pendingName = undefined;
			setCreating(false);
			setPicking(false);
		}
	}));
	// The host's configured defaults: the folder a blank box should fall back to, and the
	// model a session started without touching the picker should get.
	const [defaults, setDefaults] = createSignal<{ personaId?: string; modelId?: string; cwd?: string }>({});
	// Set once the chat is on its way without a picked card, so the line under the composer
	// explains the pause before the first frame paints. It goes away with this view.
	const [picking, setPicking] = createSignal(false);
	let personaPicked = false;
	let settingsVersion = 0;
	let personasVersion = 0;
	const preselect = (cards: PersonaSummary[]) => {
		const preferred = defaults().personaId;
		if (!personaPicked) setPersonaId(cards.some(card => card.id === preferred) ? preferred! : null);
	};
	const loadPersonas = () => {
		const version = ++personasVersion;
		const query = cwd().trim() ? `?cwd=${encodeURIComponent(cwd().trim())}` : "";
		void apiFetch(remoteApiPath(`/api/personas${query}`, remoteId()))
			.then(response => response.ok ? response.json() as Promise<PersonaSummary[]> : undefined)
			.then(cards => {
				if (version !== personasVersion || !Array.isArray(cards)) return;
				setPersonas(cards);
				preselect(cards);
			})
			.catch(() => undefined);
	};
	const loadSettings = () => {
		const version = ++settingsVersion;
		void apiFetch(remoteApiPath("/api/settings", remoteId()))
			.then(response => response.ok ? response.json() as Promise<{ personaId?: string; modelId?: string; cwd?: string }> : undefined)
			.then(settings => {
				if (version !== settingsVersion || !settings) return;
				setDefaults(settings);
				preselect(personas());
				// A folder from the caller is the sharper intent and wins; the configured default
				// only fills a box nothing else managed to fill.
				if (cwd().trim().length === 0 && (settings.cwd ?? "").trim().length > 0) setCwd(settings.cwd!.trim());
			})
			.catch(() => undefined);
	};
	onMount(() => {
		window.addEventListener("eta:personas", loadPersonas);
		window.addEventListener("eta:settings", loadSettings);
		onCleanup(() => {
			settingsVersion += 1; personasVersion += 1;
			window.removeEventListener("eta:personas", loadPersonas);
			window.removeEventListener("eta:settings", loadSettings);
		});
	});
	createEffect(on(remoteId, () => {
		personaPicked = false;
		setPersonas([]);
		setPersonaId(null);
		setDefaults({});
		setRemembered(false);
		loadSettings();
	}));
	createEffect(loadPersonas);

	// Already on `/new`, another project's 「+」 is the same route with a sharper folder in the
	// url. Adopt a folder that actually changed — the person just named the project — and
	// ignore the same folder arriving again because the session list refreshed underneath us.
	let handed = (props.initialCwd ?? "").trim();
	let handedRemote = props.initialRemoteId;
	createEffect(() => {
		const next = (props.initialCwd ?? "").trim();
		const target = props.initialRemoteId;
		if (target !== handedRemote || (next.length > 0 && next !== handed)) {
			handed = next;
			handedRemote = target;
			setRemoteId(target);
			setCwd(next);
		}
	});

	/** The shell's own folder picker; a browser tab has no equivalent, so the button
	 * is not offered there rather than offered and dead. */
	const browse = async () => {
		if (remoteId()) return;
		const starting = cwd().trim();
		const picked = await pickFolder(starting.length > 0 ? starting : undefined);
		if (typeof picked === "string" && picked.length > 0) setCwd(picked);
	};
	// ⌘O lives in the shell's menu bar, so it arrives as an action and not a click. This
	// view is the only place a folder can still be chosen, so it is the only one that answers.
	onCleanup(onNativeActions({ [NativeActions.openFolder]: () => void browse() }));

	const create = {
		get remoteId() { return remoteId(); },
		get cwd() {
			return cwd();
		},
		onCwd: setCwd,
		...(nativeAvailable() ? { onBrowse: () => void browse() } : {}),
		onSend: (text: string, modelId?: string) => send(text, modelId),
	} satisfies ComposerCreate;

	/**
	 * One `session.create` for both ways out: the first message the composer sends, and the
	 * button that opens the session empty. Empty is only honest once a card is picked — with
	 * nothing to infer from, a persona chosen for you is a coin flip, not a choice.
	 */
	function send(text: string | undefined, modelId: string | undefined): void {
		if (creating()) return;
		const id = personaId();
		const folder = cwd().trim();
		const name = `eta-${Date.now().toString(36)}`;
		pendingName = remoteId() ? remoteSessionName(remoteId()!, name) : name;
		setCreating(true);
		store.send({
			op: "session.create",
			name,
			...(id === null ? {} : { personaId: id }),
			...(folder.length > 0 ? { cwd: folder } : {}),
			...(text === undefined || text.length === 0 ? {} : { prompt: text }),
			...(modelId === undefined ? {} : { modelId }),
			...(remoteId() === undefined ? {} : { remoteId: remoteId() }),
		});
		if (remembered() && folder.length > 0 && !remoteId())
			void apiFetch("/api/settings", { method: "POST", body: JSON.stringify({ cwd: folder }) }).catch(() => undefined);
		if (id === null && text !== undefined) setPicking(true);
	}

	const chips = (
		<div data-testid="persona-chips" class="flex flex-wrap justify-center gap-1.5">
			<For each={personas()}>
				{(persona) => (
					<button
						data-testid={`persona-${persona.id}`}
						title={persona.description}
						onClick={() => { personaPicked = true; setPersonaId(persona.id); }}
						class={`border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${personaId() === persona.id ? "border-2 border-primary bg-primary text-primary-foreground" : "border-border text-muted hover:border-border-strong"}`}
					>
						{persona.name}
						<Show when={persona.custom}>
							<span data-testid={`persona-custom-${persona.id}`} class="ml-1 border border-current px-1 text-[8px]">{i18n.t("persona.custom")}</span>
						</Show>
					</button>
				)}
			</For>
		</div>
	);

	return (
		<div data-testid="welcome" class="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4">
			<div data-testid="welcome-wordmark" class="mono pointer-events-none absolute inset-x-0 top-0 flex items-start justify-center pt-[35vh] text-[18vh] font-black leading-none tracking-[0.08em] select-none" style={{ color: "color-mix(in oklab, var(--foreground) 6%, transparent)" }}>
				Eta
			</div>
			<div class="relative z-10 mt-[5vh] w-full max-w-[860px]">
				<p data-testid="persona-hint" class="mb-2 text-center font-mono text-[11px] text-muted">
					{personaId() === null ? i18n.t(picking() ? "new.personaPicking" : "new.personaAutoPick") : ""}
				</p>
				<div class="mb-3">
					<WorkspaceTarget remoteId={remoteId()} cwd={cwd()} onRemoteId={setRemoteId} onCwd={setCwd} localDirectory={false} />
				</div>
				<Composer topSlot={chips} onNavigateSettings={props.onNavigateSettings} create={create} />
				{/* The folder is in the composer's own bar; what is said about it sits here, where
				    there is room for a sentence and for the two ways out. */}
				<div data-testid="create-bar" class="mt-2 flex flex-wrap items-center gap-2">
					<p data-testid="cwd-hint" class="mono min-w-0 flex-1 text-[11px] text-faint">
						{cwd().trim().length > 0 ? i18n.t("new.cwdHint", { cwd: cwd().trim() }) : i18n.t("new.cwdBlank")}
					</p>
					<button
						data-testid="cwd-remember"
						aria-pressed={remembered() ? "true" : "false"}
						onClick={() => setRemembered((current) => !current)}
						class={`shrink-0 border px-2 py-1 text-[11px] ${remembered() ? "border-primary text-primary" : "border-border text-muted hover:border-border-strong"}`}
					>
						{remembered() ? "✓ " : ""}
						{i18n.t("new.cwdRemember")}
					</button>
					<button
						data-testid="create-session"
						title={personaId() === null ? i18n.t("new.personaRequired") : undefined}
						disabled={creating() || personaId() === null}
						onClick={() => send(undefined, remoteId() ? undefined : defaults().modelId)}
						class="shrink-0 border-2 border-primary px-3 py-1 font-mono text-[11px] font-bold tracking-[0.12em] uppercase disabled:opacity-40"
						style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
					>
						{creating() ? i18n.t("new.creating") : i18n.t("new.create")}
					</button>
				</div>
			</div>
		</div>
	);
}
