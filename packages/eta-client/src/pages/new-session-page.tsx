import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useAppI18n } from "../i18n.ts";
import { etaStore } from "../lib/eta-store.ts";
import { apiFetch } from "../lib/host.ts";

interface PersonaSummary {
	id: string;
	name: string;
	description: string;
	custom: boolean;
}

export function NewSessionPage() {
	const i18n = useAppI18n();
	const store = etaStore();
	const navigate = useNavigate();
	const [personas, setPersonas] = createSignal<PersonaSummary[]>([]);
	const [personaId, setPersonaId] = createSignal<string | null>(null);
	const [cwd, setCwd] = createSignal("");
	const [prompt, setPrompt] = createSignal("");
	const [creating, setCreating] = createSignal(false);
	// The host's configured defaults, so a fresh browser doesn't start blank.
	const [defaults, setDefaults] = createSignal<{ personaId?: string; modelId?: string }>({});

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
			.then((body: { personaId?: string; modelId?: string }) => {
				if (!live) return;
				setDefaults(body ?? {});
				preselect(personas());
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

	const create = () => {
		const id = personaId();
		if (id === null) return;
		setCreating(true);
		store.send({
			op: "session.create",
			name: `eta-${Date.now().toString(36)}`,
			personaId: id,
			...(cwd().trim().length > 0 ? { cwd: cwd().trim() } : {}),
			...(prompt().trim().length > 0 ? { prompt: prompt().trim() } : {}),
			...(defaults().modelId === undefined ? {} : { modelId: defaults().modelId }),
		});
		void navigate("/");
	};

	return (
		<main class="mx-auto flex h-full w-full max-w-[720px] flex-col gap-4 overflow-y-auto p-6" data-testid="new-page">
			<h1 class="text-lg font-semibold">{i18n.t("new.title")}</h1>
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
			<input data-testid="cwd-input" value={cwd()} placeholder={i18n.t("new.cwd")} onInput={(event) => setCwd(event.currentTarget.value)} class="border-2 border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-strong" />
			<textarea data-testid="prompt-input" rows={3} value={prompt()} placeholder={i18n.t("new.firstPrompt")} onInput={(event) => setPrompt(event.currentTarget.value)} class="border-2 border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-strong" />
			<div class="flex items-center gap-3">
				<button
					data-testid="create-session"
					disabled={personaId() === null || creating()}
					onClick={create}
					class="border-2 border-primary bg-primary px-4 py-2 font-mono text-sm font-bold tracking-[0.12em] text-primary-foreground uppercase disabled:opacity-40"
					style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
				>
					{creating() ? i18n.t("new.creating") : i18n.t("new.create")}
				</button>
				<Show when={personaId() === null}>
					<span data-testid="persona-required" class="text-xs text-warning">{i18n.t("new.personaRequired")}</span>
				</Show>
			</div>
		</main>
	);
}
