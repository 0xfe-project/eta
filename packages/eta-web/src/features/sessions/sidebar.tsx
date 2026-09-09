import { Link } from "wouter";
import { useAppI18n } from "../../i18n.ts";
import { etaStore, useEta } from "../../lib/eta-store.ts";
import type { SidebarSession } from "../../lib/protocol.ts";

// Graphite rule: saturation reserved for state (goal ok / ask needs attention / running).
const BADGE_STYLES: Record<string, string> = {
	running: "bg-accent text-accent-foreground",
	goal: "text-success",
	"ask-pending": "bg-warning/20 text-warning",
	loop: "bg-overlay text-muted",
};

export function Sidebar({ selected }: { selected: string | null }) {
	const { t } = useAppI18n();
	const state = useEta();
	const store = etaStore();

	return (
		<div className="flex h-full flex-col" data-testid="sidebar">
			<div className="flex items-center gap-2 border-b border-border p-3">
				<span className="mono text-sm font-bold text-accent">eta</span>
				<div className="ml-auto flex gap-1">
					<Link href="/new" data-testid="nav-new" className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground">
						{t("nav.new")}
					</Link>
					<Link href="/settings" data-testid="nav-settings" className="rounded-md border border-border px-2 py-1 text-xs text-muted">
						{t("nav.settings")}
					</Link>
				</div>
			</div>
			<Link href="/inbox" className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm" data-testid="inbox-entry">
				<span>⚡ {t("inbox.entry")}</span>
				{inboxBadge(state.tasks) > 0 ? (
					<span data-testid="inbox-badge" className="ml-auto rounded-full bg-accent px-1.5 text-[10px] text-accent-foreground">{inboxBadge(state.tasks)}</span>
				) : null}
			</Link>
			<div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="session-list">
				{state.sessions.length === 0 ? <p className="p-2 text-sm text-muted">{t("sidebar.noSessions")}</p> : null}
				{state.sessions.map((session) => (
					<SessionRow key={session.name} session={session} selected={session.name === selected} onSelect={() => store.send({ op: "focus", session: session.name })} onDelete={() => store.send({ op: "session.delete", name: session.name })} />
				))}
			</div>
			{state.connected ? null : <p data-testid="connection-banner" className="border-t border-border bg-warning/10 p-2 text-xs text-warning">{t("connection.disconnected")}</p>}
		</div>
	);
}

function inboxBadge(tasks: { status: string }[]): number {
	return tasks.filter((task) => task.status === "pending" || task.status === "running" || task.status === "needs_input").length;
}

function SessionRow({ session, selected, onSelect, onDelete }: { session: SidebarSession; selected: boolean; onSelect(): void; onDelete(): void }) {
	const { t } = useAppI18n();
	return (
		<div
			role="button"
			data-testid={`session-row-${session.name}`}
			onClick={onSelect}
			className={`group mb-1 cursor-pointer rounded-lg border border-transparent p-2 ${selected ? "border-border-strong bg-overlay" : "hover:bg-overlay"}`}
		>
			<div className="flex items-center gap-1">
				<span className="truncate text-sm">{session.name}</span>
				<button
					data-testid={`session-delete-${session.name}`}
					className="ml-auto hidden text-xs text-muted group-hover:inline"
					onClick={(event) => {
						event.stopPropagation();
						onDelete();
					}}
				>
					{t("sidebar.delete")}
				</button>
			</div>
			<div className="mt-1 flex flex-wrap gap-1">
				{session.personas.map((persona) => (
					<span key={persona} data-testid={`session-persona-${session.name}`} className="mono rounded bg-overlay px-1.5 py-0.5 text-[10px] text-foreground">
						{persona}
					</span>
				))}
				{session.badges.map((badge) => (
					<span key={badge} className={`rounded px-1.5 py-0.5 text-[10px] ${BADGE_STYLES[badge] ?? "bg-overlay text-muted"}`}>
						{t(`sidebar.${badge === "ask-pending" ? "ask" : badge}` as "sidebar.running")}
					</span>
				))}
			</div>
		</div>
	);
}
