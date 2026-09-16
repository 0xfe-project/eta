import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Composer } from "./composer.tsx";
import { apiFetch } from "../../lib/host.ts";
import { remoteApiPath, remoteSessionName } from "../../lib/remotes.ts";
import { WorkspaceTarget } from "./workspace-target.tsx";

interface PersonaSummary {
	id: string;
	name: string;
	description: string;
	custom: boolean;
}

export function Welcome(props: { onCreated: (name: string) => void; onNavigateSettings: () => void }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const [personas, setPersonas] = createSignal<PersonaSummary[]>([]);
	const [personaId, setPersonaId] = createSignal<string | null>(null);
	const [cwd, setCwd] = createSignal("");
	const [remoteId, setRemoteId] = createSignal<string | undefined>();
	// Set once the chat is on its way without a picked card, so the line under the composer
	// explains the pause before the first frame paints. It goes away with this view.
	const [picking, setPicking] = createSignal(false);
	let personaPicked = false;
	let loadVersion = 0;

	const load = () => {
		const version = ++loadVersion;
		const target = remoteId();
		void Promise.all([
			apiFetch(remoteApiPath("/api/personas", target)).then(response => response.json() as Promise<PersonaSummary[]>),
			apiFetch(remoteApiPath("/api/settings", target)).then(response => response.json() as Promise<{ personaId?: string; cwd?: string }>).catch(() => ({} as { personaId?: string; cwd?: string })),
		])
			.then(([cards, defaults]) => {
				if (version !== loadVersion || !Array.isArray(cards)) return;
				setPersonas(cards);
				if (!personaPicked) setPersonaId(cards.some(card => card.id === defaults?.personaId) ? defaults.personaId! : null);
				if (!cwd() && defaults?.cwd) setCwd(defaults.cwd);
			})
			.catch(() => undefined);
	};
	onMount(() => {
		window.addEventListener("eta:personas", load);
		window.addEventListener("eta:settings", load);
		onCleanup(() => { loadVersion += 1; window.removeEventListener("eta:personas", load); window.removeEventListener("eta:settings", load); });
	});
	createEffect(() => { void remoteId(); personaPicked = false; setPersonas([]); setPersonaId(null); load(); });

	const create = {
		get remoteId() { return remoteId(); },
		get cwd() {
			return cwd();
		},
		onCwd: setCwd,
		onSend: (text: string, modelId?: string) => {
			const id = personaId();
			const name = `s-${Date.now().toString(36)}`;
			store.send({
				op: "session.create",
				name,
				...(id === null ? {} : { personaId: id }),
				...(cwd().trim().length > 0 ? { cwd: cwd().trim() } : {}),
				prompt: text,
				...(modelId === undefined ? {} : { modelId }),
				...(remoteId() === undefined ? {} : { remoteId: remoteId() }),
			});
			if (id === null) setPicking(true);
			props.onCreated(remoteId() ? remoteSessionName(remoteId()!, name) : name);
		},
	};

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
					<WorkspaceTarget remoteId={remoteId()} cwd={cwd()} onRemoteId={setRemoteId} onCwd={setCwd} browse={false} />
				</div>
				<Composer topSlot={chips} onNavigateSettings={props.onNavigateSettings} create={create} />
			</div>
		</div>
	);
}
