import { useEffect, useState } from "react";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";

interface PersonaSummary {
	id: string;
	name: string;
	description: string;
}

export function Welcome({ onCreated }: { onCreated: (name: string) => void }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [text, setText] = useState("");
	const [personas, setPersonas] = useState<PersonaSummary[]>([]);
	const [personaId, setPersonaId] = useState<string | null>(null);

	useEffect(() => {
		void fetch("/api/personas")
			.then((response) => response.json() as Promise<PersonaSummary[]>)
			.then(setPersonas)
			.catch(() => undefined);
	}, []);

	const start = () => {
		const value = text.trim();
		if (personaId === null || value.length === 0) return;
		const name = `s-${Date.now().toString(36)}`;
		store.send({ op: "session.create", name, personaId });
		store.send({ op: "prompt", session: name, text: value });
		onCreated(name);
	};

	return (
		<div data-testid="welcome" className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4">
			<div data-testid="welcome-wordmark" className="mono pointer-events-none absolute inset-0 flex items-center justify-center text-[18vh] font-black tracking-[0.08em] select-none" style={{ color: "color-mix(in srgb, var(--foreground) 6%, transparent)" }}>
				eta
			</div>
			<div className="relative z-10 w-full max-w-[720px]">
				<div className="composer-card" data-testid="welcome-card">
					<textarea
						id="welcome-input"
						data-testid="welcome-input"
						rows={2}
						value={text}
						placeholder={t("welcome.placeholder")}
						autoComplete="off"
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								start();
							}
						}}
					/>
					<div className="composer-toolbar">
						<div data-testid="welcome-personas" className="flex flex-wrap items-center gap-1">
							{personas.map((persona) => (
								<button
									key={persona.id}
									data-testid={`welcome-persona-${persona.id}`}
									title={persona.description}
									onClick={() => setPersonaId(persona.id)}
									className={`border px-2 py-1 text-xs ${personaId === persona.id ? "border-border-strong bg-overlay font-medium" : "border-border text-muted hover:bg-overlay"}`}
								>
									{persona.name}
								</button>
							))}
						</div>
						<button type="button" data-testid="welcome-start" disabled={personaId === null || text.trim().length === 0} onClick={start} className="ui-button ui-button--primary disabled:opacity-40">
							↑
						</button>
					</div>
				</div>
				<p data-testid="welcome-hint" className="mt-3 text-center text-xs text-muted">
					{personaId === null ? t("welcome.pickPersona") : t("welcome.pressEnter")}
				</p>
			</div>
		</div>
	);
}
