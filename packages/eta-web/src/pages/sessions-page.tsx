import { useEffect, useRef, useState } from "react";
import { useAppI18n } from "../i18n.ts";
import { AppShell } from "../app/app-shell.tsx";
import { useEta } from "../lib/eta-store.ts";
import { Sidebar } from "../features/sessions/sidebar.tsx";
import { Timeline } from "../features/sessions/timeline.tsx";
import { Composer } from "../features/sessions/composer.tsx";
import { AskModal } from "../features/sessions/ask-modal.tsx";
import { ContextPanel } from "../features/sessions/context-panel.tsx";
import { DevRail } from "../features/sessions/dev-rail.tsx";
import { CommandPalette } from "../features/sessions/command-palette.tsx";
import { Welcome } from "../features/sessions/welcome.tsx";
import { etaStore } from "../lib/eta-store.ts";

function useRunNotifications(state: ReturnType<typeof useEta>) {
	const seen = useRef<Record<string, boolean>>({});
	useEffect(() => {
		for (const [name, running] of Object.entries(state.runningBySession)) {
			const was = seen.current[name] === true;
			seen.current[name] = running;
			if (was && !running && name !== state.attach && typeof Notification !== "undefined" && Notification.permission === "granted") {
				const notification = new Notification(`eta · ${name}`, { body: "run finished", tag: `eta-${name}` });
				notification.onclick = () => {
					etaStore().send({ op: "focus", session: name });
					window.focus();
				};
			}
		}
	}, [state.runningBySession, state.attach]);
}

function useDeepLink() {
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const session = params.get("session");
		if (session !== null) {
			etaStore().send({ op: "focus", session });
			params.delete("session");
			const query = params.toString();
			window.history.replaceState(null, "", `${window.location.pathname}${query.length > 0 ? `?${query}` : ""}`);
		}
	}, []);
}

export function SessionsPage() {
	const { t } = useAppI18n();
	const state = useEta();
	useRunNotifications(state);
	useDeepLink();
	const [tab, setTab] = useState<"context" | "dev">("context");
	const selected = state.attach ?? state.sessions[0]?.name ?? null;
	const view = selected === null ? undefined : state.views[selected];
	const running = selected === null ? false : (state.sessions.find((session) => session.name === selected)?.badges.includes("running") ?? false);

	return (
		<AppShell
			palette={<CommandPalette />}
			sidebar={<Sidebar selected={selected} />}
			main={
				<div className="flex min-h-0 flex-1 flex-col">
					<header className="flex items-center gap-2 border-b border-border px-4 py-2">
						<span data-testid="active-session" className="truncate text-sm font-medium">{selected ?? t("app.title")}</span>
						<span className="ml-auto text-[10px] text-muted">{state.connected ? "" : t("connection.disconnected")}</span>
					</header>
					{state.sessions.length === 0 ? (
						<Welcome onCreated={() => undefined} />
					) : view === undefined ? (
						<p className="p-6 text-sm text-muted">{t("sidebar.noSessions")}</p>
					) : (
						<>
							<Timeline view={view} session={selected ?? ""} running={running} />
							<Composer session={selected ?? ""} running={running} hasPendingAsk={view.pendingAsk !== undefined} onNavigateSettings={() => window.location.assign("/settings")} userTexts={view.messages.filter((entry) => entry.message.role === "user").map((entry) => JSON.stringify(entry.message))} />
							<AskModal session={selected ?? ""} view={view} />
						</>
					)}
				</div>
			}
			panel={
				view === undefined ? null : (
					<div className="flex h-full flex-col">
						<div className="flex gap-1 border-b border-border p-2">
							<button
								data-testid="tab-context"
								onClick={() => setTab("context")}
								className={`px-3 py-1 text-xs ${tab === "context" ? "bg-overlay font-medium" : "text-muted"}`}
							>
								{t("nav.context")}
							</button>
							<button
								data-testid="tab-dev"
								onClick={() => setTab("dev")}
								className={`px-3 py-1 text-xs ${tab === "dev" ? "bg-overlay font-medium" : "text-muted"}`}
							>
								{t("nav.dev")}
							</button>
						</div>
						<div className="min-h-0 flex-1">{tab === "context" ? <ContextPanel session={selected ?? ""} view={view} /> : <DevRail frames={selected === null ? [] : state.dev[selected] ?? []} />}</div>
					</div>
				)
			}
		/>
	);
}
