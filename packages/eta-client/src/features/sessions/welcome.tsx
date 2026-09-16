import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Composer, type ComposerCreate } from "./composer.tsx";
import { apiFetch, host } from "../../lib/host.ts";
import { NativeActions, onNativeActions, pickFolder } from "../../lib/native.ts";

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
}) {
	const i18n = useAppI18n();
	const store = etaStore();
	const [personas, setPersonas] = createSignal<PersonaSummary[]>([]);
	const [personaId, setPersonaId] = createSignal<string | null>(null);
	const [cwd, setCwd] = createSignal(props.initialCwd ?? "");
	const [remembered, setRemembered] = createSignal(false);
	const [creating, setCreating] = createSignal(false);
	// The host's configured defaults: the folder a blank box should fall back to, and the
	// model a session started without touching the picker should get.
	const [defaults, setDefaults] = createSignal<{ personaId?: string; modelId?: string; cwd?: string }>({});
	// Set once the chat is on its way without a picked card, so the line under the composer
	// explains the pause before the first frame paints. It goes away with this view.
	const [picking, setPicking] = createSignal(false);
	let personaPicked = false;

	const load = () => {
		void Promise.all([
			apiFetch("/api/personas").then(response => response.json() as Promise<PersonaSummary[]>),
			apiFetch("/api/settings").then(response => response.json() as Promise<{ personaId?: string; modelId?: string; cwd?: string }>).catch(() => ({} as { personaId?: string; modelId?: string; cwd?: string })),
		])
			.then(([cards, settings]) => {
				if (!Array.isArray(cards)) return;
				setDefaults(settings ?? {});
				setPersonas(cards);
				if (!personaPicked) setPersonaId(cards.some(card => card.id === settings?.personaId) ? settings.personaId! : null);
				// A folder from the caller is the sharper intent and wins; the configured default
				// only fills a box nothing else managed to fill.
				if (cwd().trim().length === 0 && (settings?.cwd ?? "").trim().length > 0) setCwd(settings!.cwd!.trim());
			})
			.catch(() => undefined);
	};
	onMount(() => {
		load();
		window.addEventListener("eta:personas", load);
		window.addEventListener("eta:settings", load);
		onCleanup(() => { window.removeEventListener("eta:personas", load); window.removeEventListener("eta:settings", load); });
	});

	// Already on `/new`, another project's 「+」 is the same route with a sharper folder in the
	// url. Adopt a folder that actually changed — the person just named the project — and
	// ignore the same folder arriving again because the session list refreshed underneath us.
	let handed = (props.initialCwd ?? "").trim();
	createEffect(() => {
		const next = (props.initialCwd ?? "").trim();
		if (next.length > 0 && next !== handed) {
			handed = next;
			setCwd(next);
		}
	});

	/** The shell's own folder picker; a browser tab has no equivalent, so the button
	 * is not offered there rather than offered and dead. */
	const browse = async () => {
		const starting = cwd().trim();
		const picked = await pickFolder(starting.length > 0 ? starting : undefined);
		if (typeof picked === "string" && picked.length > 0) setCwd(picked);
	};
	// ⌘O lives in the shell's menu bar, so it arrives as an action and not a click. This
	// view is the only place a folder can still be chosen, so it is the only one that answers.
	onCleanup(onNativeActions({ [NativeActions.openFolder]: () => void browse() }));

	const create = {
		get cwd() {
			return cwd();
		},
		onCwd: setCwd,
		...(host().kind === "desktop" ? { onBrowse: () => void browse() } : {}),
		onSend: (text: string, modelId?: string) => send(text, modelId),
	} satisfies ComposerCreate;

	/**
	 * One `session.create` for both ways out: the first message the composer sends, and the
	 * button that opens the session empty. Empty is only honest once a card is picked — with
	 * nothing to infer from, a persona chosen for you is a coin flip, not a choice.
	 */
	function send(text: string | undefined, modelId: string | undefined): void {
		const id = personaId();
		const folder = cwd().trim();
		const name = `eta-${Date.now().toString(36)}`;
		setCreating(true);
		store.send({
			op: "session.create",
			name,
			...(id === null ? {} : { personaId: id }),
			...(folder.length > 0 ? { cwd: folder } : {}),
			...(text === undefined || text.length === 0 ? {} : { prompt: text }),
			...(modelId === undefined ? {} : { modelId }),
		});
		if (remembered() && folder.length > 0)
			void apiFetch("/api/settings", { method: "POST", body: JSON.stringify({ cwd: folder }) }).catch(() => undefined);
		if (id === null && text !== undefined) setPicking(true);
		props.onCreated(name);
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
						onClick={() => send(undefined, defaults().modelId)}
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
