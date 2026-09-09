import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAppI18n } from "../i18n.ts";
import { etaStore } from "../lib/eta-store.ts";

interface PersonaSummary {
	id: string;
	name: string;
	description: string;
}

export function NewSessionPage() {
	const { t } = useAppI18n();
	const store = etaStore();
	const [, navigate] = useLocation();
	const [personas, setPersonas] = useState<PersonaSummary[]>([]);
	const [personaId, setPersonaId] = useState<string | null>(null);
	const [cwd, setCwd] = useState("");
	const [prompt, setPrompt] = useState("");
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		let live = true;
		const load = () => {
			void fetch("/api/personas")
				.then((response) => response.json())
				.then((body: PersonaSummary[]) => {
					if (live) setPersonas(body);
				})
				.catch(() => undefined);
		};
		load();
		return () => {
			live = false;
		};
	}, []);

	const create = () => {
		if (personaId === null) return;
		setCreating(true);
		store.send({
			op: "session.create",
			name: `eta-${Date.now().toString(36)}`,
			personaId,
			...(cwd.trim().length > 0 ? { cwd: cwd.trim() } : {}),
			...(prompt.trim().length > 0 ? { prompt: prompt.trim() } : {}),
		});
		navigate("/");
	};

	return (
		<main className="mx-auto flex h-full w-full max-w-[720px] flex-col gap-4 overflow-y-auto p-6" data-testid="new-page">
			<h1 className="text-lg font-semibold">{t("new.title")}</h1>
			<p data-testid="persona-hint" className="text-sm text-muted">{t("new.pickPersona")}</p>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="persona-grid">
				{personas.map((persona) => (
					<button
						key={persona.id}
						data-testid={`persona-card-${persona.id}`}
						data-selected={personaId === persona.id ? "1" : "0"}
						onClick={() => setPersonaId(persona.id)}
						className={`border-2 p-3 text-left ${personaId === persona.id ? "border-primary bg-primary text-primary-foreground shadow-[4px_4px_0_0_var(--shadow)]" : "border-border hover:border-border-strong"}`}
					>
						<div className="text-sm font-medium">{persona.name}</div>
						<div className={`mt-1 line-clamp-2 text-xs ${personaId === persona.id ? "text-primary-foreground/70" : "text-muted"}`}>{persona.description}</div>
					</button>
				))}
			</div>
			<input data-testid="cwd-input" value={cwd} placeholder={t("new.cwd")} onChange={(event) => setCwd(event.target.value)} className="border-2 border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-strong" />
			<textarea data-testid="prompt-input" rows={3} value={prompt} placeholder={t("new.firstPrompt")} onChange={(event) => setPrompt(event.target.value)} className="border-2 border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-strong" />
			<div className="flex items-center gap-3">
				<button
					data-testid="create-session"
					disabled={personaId === null || creating}
					onClick={create}
					className="border-2 border-primary bg-primary px-4 py-2 font-mono text-sm font-bold tracking-[0.12em] text-primary-foreground uppercase disabled:opacity-40"
					style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
				>
					{creating ? t("new.creating") : t("new.create")}
				</button>
				{personaId === null ? <span data-testid="persona-required" className="text-xs text-warning">{t("new.personaRequired")}</span> : null}
			</div>
		</main>
	);
}
