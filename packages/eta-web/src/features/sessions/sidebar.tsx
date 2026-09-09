import { useState } from "react";
import { Link, useLocation } from "wouter";
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

	const [, navigate] = useLocation();
	const [expanded, setExpanded] = useState<string[]>([]);

	const visible = state.sessions.filter((session) => session.archived !== true);
	const archived = state.sessions.filter((session) => session.archived === true);
	const byUpdated = (a: SidebarSession, b: SidebarSession) => (b.updated ?? 0) - (a.updated ?? 0);
	const projectKeys = [...new Set(visible.map((session) => session.cwd ?? session.name))].sort();
	const projectOf = (key: string) => visible.filter((session) => (session.cwd ?? session.name) === key).sort(byUpdated);
	const basenameOf = (key: string) => key.split("/").filter((part) => part.length > 0).pop() ?? key;

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
			onRename={(title) => store.send({ op: "session.rename", session: session.name, title })}
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
				{projectKeys.map((key) => {
					const group = projectOf(key);
					const showAll = expanded.includes(key) || group.length <= 6;
					const shown = showAll ? group : group.slice(0, 5);
					return (
						<details key={key} open data-testid={`group-project-${basenameOf(key)}`} className="mb-1">
							<summary className="flex cursor-pointer items-center gap-1 px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
								<span data-testid={`project-name-${basenameOf(key)}`} className="truncate">{basenameOf(key)}</span>
								<span className="bg-overlay px-1 text-[9px]">{group.length}</span>
								<button
									data-testid={`project-new-${basenameOf(key)}`}
									title={t("sidebar.newInProject")}
									className="ml-auto border border-border-strong px-1 text-[9px] hover:bg-foreground hover:text-background"
									onClick={(event) => {
										event.preventDefault();
										navigate(`/new?cwd=${encodeURIComponent(key)}`);
									}}
								>
									+
								</button>
							</summary>
							{group.filter((session) => session.pinned === true && shown.includes(session)).map(row)}
							{shown.filter((session) => session.pinned !== true).map(row)}
							{showAll ? null : (
								<button data-testid={`project-more-${basenameOf(key)}`} className="w-full px-1 py-1 text-left text-[10px] text-accent" onClick={() => setExpanded((current) => [...current, key])}>
									{t("sidebar.showMore")} ({group.length - shown.length})
								</button>
							)}
						</details>
					);
				})}
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

function humanizeAge(updated: number | undefined): string {
	if (updated === undefined) return "";
	const minutes = Math.max(0, Math.floor((Date.now() - updated) / 60_000));
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function SessionRow({ session, unread, selected, onSelect, onDelete, onPin, onArchive, onRename }: { session: SidebarSession; unread: boolean; selected: boolean; onSelect(): void; onDelete(): void; onPin(): void; onArchive(): void; onRename(title: string): void }) {
	const { t } = useAppI18n();
	const [menuOpen, setMenuOpen] = useState(false);
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
				<span data-testid={`session-age-${session.name}`} className="ml-auto shrink-0 mono text-[10px] text-muted">{humanizeAge(session.updated)}</span>
				<div className="relative shrink-0">
					<button
						data-testid={`session-menu-${session.name}`}
						aria-label="menu"
						className="border border-transparent px-1 text-xs text-muted hover:border-border-strong hover:text-foreground"
						onClick={(event) => {
							event.stopPropagation();
							setMenuOpen((current) => !current);
						}}
					>
						⋯
					</button>
					{menuOpen ? (
						<div data-testid={`session-menu-open-${session.name}`} className="absolute right-0 top-6 z-20 min-w-[120px] border-2 border-border-strong bg-elevated shadow-[4px_4px_0_0_var(--shadow)]">
							<button
								data-testid={`session-rename-${session.name}`}
								className="block w-full border-b border-border px-2 py-1 text-left text-xs hover:bg-overlay"
								onClick={(event) => {
									event.stopPropagation();
									setMenuOpen(false);
									const next = window.prompt(t("sidebar.renameTo"), session.title ?? session.name);
									if (next !== null && next.trim().length > 0) onRename(next.trim());
								}}
							>
								{t("sidebar.rename")}
							</button>
							<button
								data-testid={`session-pin-${session.name}`}
								className="block w-full border-b border-border px-2 py-1 text-left text-xs hover:bg-overlay"
								onClick={(event) => {
									event.stopPropagation();
									setMenuOpen(false);
									onPin();
								}}
							>
								{t(session.pinned === true ? "sidebar.unpin" : "sidebar.pin")}
							</button>
							<button
								data-testid={`session-archive-${session.name}`}
								className="block w-full border-b border-border px-2 py-1 text-left text-xs hover:bg-overlay"
								onClick={(event) => {
									event.stopPropagation();
									setMenuOpen(false);
									onArchive();
								}}
							>
								{t(session.archived === true ? "sidebar.unarchive" : "sidebar.archive")}
							</button>
							<button
								data-testid={`session-delete-${session.name}`}
								className="block w-full px-2 py-1 text-left text-xs text-danger hover:bg-overlay"
								onClick={(event) => {
									event.stopPropagation();
									setMenuOpen(false);
									onDelete();
								}}
							>
								{t("sidebar.delete")}
							</button>
						</div>
					) : null}
				</div>
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
