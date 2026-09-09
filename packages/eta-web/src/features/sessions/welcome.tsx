import { useEffect, useState } from "react";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Composer } from "./composer.tsx";

interface PersonaSummary {
	id: string;
	name: string;
	description: string;
	custom: boolean;
}

export function Welcome({ onCreated, onNavigateSettings }: { onCreated: (name: string) => void; onNavigateSettings: () => void }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [personas, setPersonas] = useState<PersonaSummary[]>([]);
	const [personaId, setPersonaId] = useState<string | null>(null);
	const [cwd, setCwd] = useState("");

	const load = () => {
		void fetch("/api/personas")
			.then((response) => response.json() as Promise<PersonaSummary[]>)
			.then(setPersonas)
			.catch(() => undefined);
	};
	useEffect(() => {
		load();
		window.addEventListener("eta:personas", load);
		return () => window.removeEventListener("eta:personas", load);
	}, []);

	const chips = (
		<div data-testid="persona-chips" className="flex flex-wrap justify-center gap-1.5">
			{personas.map((persona) => (
				<button
					key={persona.id}
					data-testid={`persona-${persona.id}`}
					title={persona.description}
					onClick={() => setPersonaId(persona.id)}
					className={`border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${personaId === persona.id ? "border-2 border-primary bg-primary text-primary-foreground" : "border-border text-muted hover:border-border-strong"}`}
				>
					{persona.name}
					{persona.custom ? <span data-testid={`persona-custom-${persona.id}`} className="ml-1 border border-current px-1 text-[8px]">{t("persona.custom")}</span> : null}
				</button>
			))}
		</div>
	);

	return (
		<div data-testid="welcome" className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4">
			<div data-testid="welcome-wordmark" className="mono pointer-events-none absolute inset-0 flex items-center justify-center text-[18vh] font-black tracking-[0.08em] select-none" style={{ color: "color-mix(in oklab, var(--foreground) 6%, transparent)" }}>
				eta
			</div>
			<div className="relative z-10 w-full max-w-[860px]">
				<p data-testid="persona-hint" className="mb-2 text-center font-mono text-[11px] text-muted">
					{personaId === null ? t("new.pickPersona") : ""}
				</p>
				<Composer
					topSlot={chips}
					onNavigateSettings={onNavigateSettings}
					create={{
						personaReady: personaId !== null,
						cwd,
						onCwd: setCwd,
						onSend: (text, modelId) => {
							if (personaId === null) return;
							const name = `s-${Date.now().toString(36)}`;
							store.send({ op: "session.create", name, personaId, ...(cwd.trim().length > 0 ? { cwd: cwd.trim() } : {}), prompt: text, ...(modelId === undefined ? {} : { modelId }) });
							onCreated(name);
						},
					}}
				/>
			</div>
		</div>
	);
}
