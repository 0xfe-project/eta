import { useState } from "react";
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

export function SessionsPage() {
	const { t } = useAppI18n();
	const state = useEta();
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
					{view === undefined ? (
						<p className="p-6 text-sm text-muted">{t("sidebar.noSessions")}</p>
					) : (
						<>
							<Timeline view={view} />
							<Composer session={selected ?? ""} running={running} hasPendingAsk={view.pendingAsk !== undefined} />
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
								className={`rounded-md px-3 py-1 text-xs ${tab === "context" ? "bg-overlay font-medium" : "text-muted"}`}
							>
								{t("nav.context")}
							</button>
							<button
								data-testid="tab-dev"
								onClick={() => setTab("dev")}
								className={`rounded-md px-3 py-1 text-xs ${tab === "dev" ? "bg-overlay font-medium" : "text-muted"}`}
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
