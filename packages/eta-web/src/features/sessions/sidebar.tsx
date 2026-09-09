import { useState } from "react";
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

	"goal-done": "bg-primary/20 text-primary",
};

export function Sidebar({ selected, termActive, onTerminal }: { selected: string | null; termActive: boolean; onTerminal: () => void }) {
	const { t } = useAppI18n();
	const state = useEta();
	const store = etaStore();
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<{ session: string; snippet: string }[] | null>(null);

	const search = (value: string) => {
		setQuery(value);
		if (value.trim().length < 2) {
			setHits(null);
			return;
		}
		void fetch(`/api/search?q=${encodeURIComponent(value)}`)
			.then((response) => response.json() as Promise<{ hits: { session: string; snippet: string }[] }>)
			.then((body) => setHits(body.hits))
			.catch(() => setHits(null));
	};

	const visible = state.sessions.filter((session) => session.archived !== true);
	const pinned = visible.filter((session) => session.pinned === true);
	const recent = visible.filter((session) => session.pinned !== true);
	const archived = state.sessions.filter((session) => session.archived === true);

	const row = (session: SidebarSession) => (
		<SessionRow
			key={session.name}
			session={session}
			unread={state.unread.includes(session.name)}
			selected={session.name === selected}
			onSelect={() => store.send({ op: "focus", session: session.name })}
			onDelete={() => store.send({ op: "session.delete", name: session.name })}
			onPin={() => store.send({ op: "session.pin", session: session.name, pinned: session.pinned !== true })}
			onArchive={() => store.send({ op: "session.archive", session: session.name, archived: session.archived !== true })}
		/>
	);

	return (
		<div className="flex h-full flex-col" data-testid="sidebar">
			<div className="flex items-center gap-2 border-b border-border p-3">
				<span className="mono text-sm font-bold text-accent">eta</span>
				<div className="ml-auto flex gap-1">
					<button
						data-testid="term-toggle"
						onClick={onTerminal}
						title={t("term.title")}
						className={`border border-border-strong px-2 py-1 text-xs uppercase tracking-[0.12em] text-muted hover:bg-foreground hover:text-background ${termActive ? "bg-foreground text-background" : ""}`}
					>
						{t("term.open")}
					</button>
					<Link href="/new" data-testid="nav-new" className="bg-accent px-2 py-1 text-xs font-medium text-accent-foreground">
						{t("nav.new")}
					</Link>
					<Link href="/settings" data-testid="nav-settings" className="border border-border px-2 py-1 text-xs text-muted">
						{t("nav.settings")}
					</Link>
				</div>
			</div>
			<input
				data-testid="sidebar-search"
				value={query}
				onChange={(event) => search(event.target.value)}
				placeholder={t("sidebar.search")}
				className="m-2 border border-border bg-elevated px-2 py-1 text-xs outline-none placeholder:text-muted"
			/>
			{hits !== null ? (
				<div data-testid="search-hits" className="max-h-[30%] overflow-y-auto border-b border-border">
					{hits.length === 0 ? <p className="p-2 text-xs text-muted">{t("sidebar.noHits")}</p> : null}
					{hits.map((hit) => (
						<button key={hit.session} data-testid={`search-hit-${hit.session}`} onClick={() => store.send({ op: "focus", session: hit.session })} className="block w-full border-b border-border px-2 py-1 text-left text-xs hover:bg-overlay">
							<span className="mono text-accent">{hit.session}</span>
							<span className="ml-1 text-muted">{hit.snippet}</span>
						</button>
					))}
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="session-list">
				{state.sessions.length === 0 ? <p className="p-2 text-sm text-muted">{t("sidebar.noSessions")}</p> : null}
				{pinned.length > 0 ? <p data-testid="group-pinned" className="px-1 pb-1 pt-2 text-[10px] font-semibold text-muted">{t("sidebar.pinned")}</p> : null}
				{pinned.map(row)}
				{recent.length > 0 ? <p data-testid="group-recent" className="px-1 pb-1 pt-2 text-[10px] font-semibold text-muted">{t("sidebar.recent")}</p> : null}
				{recent.map(row)}
				{archived.length > 0 ? (
					<details data-testid="group-archived">
						<summary className="cursor-pointer px-1 pb-1 pt-2 text-[10px] font-semibold text-muted">{t("sidebar.archived")} ({archived.length})</summary>
						{archived.map(row)}
					</details>
				) : null}
			</div>
			{state.connected ? null : <p data-testid="connection-banner" className="border-t border-border bg-warning/10 p-2 text-xs text-warning">{t("connection.disconnected")}</p>}
		</div>
	);
}

function SessionRow({ session, unread, selected, onSelect, onDelete, onPin, onArchive }: { session: SidebarSession; unread: boolean; selected: boolean; onSelect(): void; onDelete(): void; onPin(): void; onArchive(): void }) {
	const { t } = useAppI18n();
	return (
		<div
			role="button"
			data-testid={`session-row-${session.name}`}
			onClick={onSelect}
			className={`group mb-1 cursor-pointer border border-transparent p-2 ${selected ? "border-border-strong bg-overlay" : "hover:bg-overlay"}`}
		>
			<div className="flex items-center gap-1">
				<span className="truncate text-sm">{session.title ?? session.name}</span>
				{session.pinned === true ? <span data-testid={`pinned-${session.name}`} className="text-[10px] text-muted">◆</span> : null}
				{unread ? <span data-testid={`unread-${session.name}`} className="h-2 w-2 shrink-0 bg-accent" /> : null}
				<button
					data-testid={`session-pin-${session.name}`}
					className="ml-auto hidden text-xs text-muted group-hover:inline"
					onClick={(event) => {
						event.stopPropagation();
						onPin();
					}}
				>
					{t(session.pinned === true ? "sidebar.unpin" : "sidebar.pin")}
				</button>
				<button
					data-testid={`session-archive-${session.name}`}
					className="hidden text-xs text-muted group-hover:inline"
					onClick={(event) => {
						event.stopPropagation();
						onArchive();
					}}
				>
					{t(session.archived === true ? "sidebar.unarchive" : "sidebar.archive")}
				</button>
				<button
					data-testid={`session-delete-${session.name}`}
					className="hidden text-xs text-muted group-hover:inline"
					onClick={(event) => {
						event.stopPropagation();
						onDelete();
					}}
				>
					{t("sidebar.delete")}
				</button>
			</div>
			{session.title !== undefined ? <p className="mono truncate text-[10px] text-muted">{session.name}</p> : null}
			<div className="mt-1 flex flex-wrap gap-1">
				{session.personas.map((persona) => (
					<span key={persona} data-testid={`session-persona-${session.name}`} className="mono bg-overlay px-1.5 py-0.5 text-[10px] text-foreground">
						{persona}
					</span>
				))}
				{session.badges.map((badge) => (
					<span key={badge} className={`px-1.5 py-0.5 text-[10px] ${BADGE_STYLES[badge] ?? "bg-overlay text-muted"}`}>
						{t(`sidebar.${badge === "ask-pending" ? "ask" : badge}` as "sidebar.running")}
					</span>
				))}
			</div>
		</div>
	);
}
