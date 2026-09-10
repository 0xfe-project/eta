import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Composer } from "./composer.tsx";
import { apiFetch } from "../../lib/host.ts";

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

	const load = () => {
		void apiFetch("/api/personas")
			.then((response) => response.json() as Promise<PersonaSummary[]>)
			.then(setPersonas)
			.catch(() => undefined);
	};
	onMount(() => {
		load();
		window.addEventListener("eta:personas", load);
		onCleanup(() => window.removeEventListener("eta:personas", load));
	});

	const create = {
		get personaReady() {
			return personaId() !== null;
		},
		get cwd() {
			return cwd();
		},
		onCwd: setCwd,
		onSend: (text: string, modelId?: string) => {
			const id = personaId();
			if (id === null) return;
			const name = `s-${Date.now().toString(36)}`;
			store.send({ op: "session.create", name, personaId: id, ...(cwd().trim().length > 0 ? { cwd: cwd().trim() } : {}), prompt: text, ...(modelId === undefined ? {} : { modelId }) });
			props.onCreated(name);
		},
	};

	const chips = (
		<div data-testid="persona-chips" class="flex flex-wrap justify-center gap-1.5">
			<For each={personas()}>
				{(persona) => (
					<button
						data-testid={`persona-${persona.id}`}
						title={persona.description}
						onClick={() => setPersonaId(persona.id)}
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
					{personaId() === null ? i18n.t("new.pickPersona") : ""}
				</p>
				<Composer topSlot={chips} onNavigateSettings={props.onNavigateSettings} create={create} />
			</div>
		</div>
	);
}
