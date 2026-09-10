import { useEffect, useRef, useState } from "react";
import { useAppI18n } from "../i18n.ts";
import { AppShell } from "../app/app-shell.tsx";
import { useEta } from "../lib/eta-store.ts";
import { Sidebar } from "../features/sessions/sidebar.tsx";
import { Timeline } from "../features/sessions/timeline.tsx";
import { Composer } from "../features/sessions/composer.tsx";
import { ContextBar } from "../features/sessions/context-bar.tsx";
import { AskModal } from "../features/sessions/ask-modal.tsx";
import { ContextPanel } from "../features/sessions/context-panel.tsx";
import { DevRail } from "../features/sessions/dev-rail.tsx";
import { CommandPalette } from "../features/sessions/command-palette.tsx";
import { Welcome } from "../features/sessions/welcome.tsx";
import { TerminalDrawer } from "../features/sessions/terminal-drawer.tsx";
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
	const [termOpen, setTermOpen] = useState(false);
	const selected = state.attach ?? state.sessions[0]?.name ?? null;
	const view = selected === null ? undefined : state.views[selected];
	const running = selected === null ? false : (state.sessions.find((session) => session.name === selected)?.badges.includes("running") ?? false);

	return (
		<AppShell
			palette={<CommandPalette />}
			sidebar={<Sidebar selected={selected} termActive={termOpen} onTerminal={() => setTermOpen((open) => !open)} />}
			main={
				<div className="flex min-h-0 flex-1 flex-col">
					<header className="topbar gap-2 px-4">
						<span data-testid="active-session" className="truncate text-sm font-medium">{selected ?? t("app.title")}</span>
						<span className="ml-auto flex items-center gap-1.5">
							{view !== undefined ? (
								<>
									<span data-testid="header-tokens" className="header-chip">tok {(view.usage.input + view.usage.output).toLocaleString()}</span>
									<span data-testid="header-cache" className="header-chip">cache {Math.round(view.cacheRate * 100)}%</span>
									{view.gitBranch !== undefined ? <span data-testid="header-branch" className="header-chip" title="git branch"> {view.gitBranch}</span> : null}
									{view.cwd !== undefined ? <span data-testid="header-cwd" className="header-chip max-w-[220px] truncate" title={view.cwd}>{view.cwd}</span> : null}
								</>
							) : null}
							<span data-testid="conn-dot" className={`conn-dot ${state.connected ? "on" : "off"}`} title={state.connected ? "" : t("connection.disconnected")} />
						</span>
					</header>
					{state.sessions.length === 0 ? (
						<Welcome onCreated={() => undefined} onNavigateSettings={() => window.location.assign("/settings")} />
					) : view === undefined ? (
						<p className="p-6 text-sm text-muted">{t("sidebar.noSessions")}</p>
					) : (
						<>
							<Timeline view={view} session={selected ?? ""} running={running} />
							<Composer session={selected ?? ""} running={running} hasPendingAsk={view.pendingAsk !== undefined} topSlot={<ContextBar session={selected ?? ""} view={view} />} onNavigateSettings={() => window.location.assign("/settings")} onToggleTerminal={() => setTermOpen((open) => !open)} queue={view.queue} />
							{termOpen ? <TerminalDrawer {...(view.cwd !== undefined ? { cwd: view.cwd } : {})} onClose={() => setTermOpen(false)} /> : null}
							<AskModal session={selected ?? ""} view={view} />
						</>
					)}
				</div>
			}
			panel={
				view === undefined ? null : (
					<div className="flex h-full flex-col">
						<div className="topbar gap-1 px-2">
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
