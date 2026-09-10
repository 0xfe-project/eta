import { For, Show, createMemo, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
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

export function Sidebar(props: { selected: string | null; termActive: boolean; onTerminal: () => void }) {
	const i18n = useAppI18n();
	const state = useEta();
	const store = etaStore();
	const [query, setQuery] = createSignal("");
	const [hits, setHits] = createSignal<{ session: string; snippet: string }[] | null>(null);
	const navigate = useNavigate();
	const [expanded, setExpanded] = createSignal<string[]>([]);

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

	const visible = createMemo(() => state.sessions.filter((session) => session.archived !== true));
	const archived = createMemo(() => state.sessions.filter((session) => session.archived === true));
	const byUpdated = (a: SidebarSession, b: SidebarSession) => (b.updated ?? 0) - (a.updated ?? 0);
	const projectKeys = createMemo(() => [...new Set(visible().map((session) => session.cwd ?? session.name))].sort());
	const projectOf = (key: string) => visible().filter((session) => (session.cwd ?? session.name) === key).sort(byUpdated);
	const basenameOf = (key: string) => key.split("/").filter((part) => part.length > 0).pop() ?? key;

	return (
		<div class="flex h-full flex-col" data-testid="sidebar">
			<div class="topbar gap-2 px-3">
				<img src="/Eta-Logo.svg" alt="eta" class="h-5 w-5 shrink-0" data-testid="logo" />
				<div class="ml-auto flex gap-1">
					<button
						data-testid="term-toggle"
						onClick={() => props.onTerminal()}
						title={i18n.t("term.title")}
						class={`border border-border-strong px-2 py-1 text-xs uppercase tracking-[0.12em] text-muted hover:bg-foreground hover:text-background ${props.termActive ? "bg-foreground text-background" : ""}`}
					>
						{i18n.t("term.open")}
					</button>
					<A href="/new" data-testid="nav-new" class="bg-accent px-2 py-1 text-xs font-medium text-accent-foreground">
						{i18n.t("nav.new")}
					</A>
					<A href="/settings" data-testid="nav-settings" class="border border-border px-2 py-1 text-xs text-muted">
						{i18n.t("nav.settings")}
					</A>
				</div>
			</div>
			<input
				data-testid="sidebar-search"
				value={query()}
				onInput={(event) => search(event.currentTarget.value)}
				placeholder={i18n.t("sidebar.search")}
				class="m-2 border border-border bg-elevated px-2 py-1 text-xs outline-none placeholder:text-muted"
			/>
			<Show when={hits()}>
				{(current) => (
					<div data-testid="search-hits" class="max-h-[30%] overflow-y-auto border-b border-border">
						<Show when={current().length === 0}>
							<p class="p-2 text-xs text-muted">{i18n.t("sidebar.noHits")}</p>
						</Show>
						<For each={current()}>
							{(hit) => (
								<button data-testid={`search-hit-${hit.session}`} onClick={() => store.send({ op: "focus", session: hit.session })} class="block w-full border-b border-border px-2 py-1 text-left text-xs hover:bg-overlay">
									<span class="mono text-accent">{hit.session}</span>
									<span class="ml-1 text-muted">{hit.snippet}</span>
								</button>
							)}
						</For>
					</div>
				)}
			</Show>
			<div class="min-h-0 flex-1 overflow-y-auto p-2" data-testid="session-list">
				<Show when={state.sessions.length === 0}>
					<p class="p-2 text-sm text-muted">{i18n.t("sidebar.noSessions")}</p>
				</Show>
				<For each={projectKeys()}>
					{(key) => {
						const group = () => projectOf(key);
						const showAll = () => expanded().includes(key) || group().length <= 6;
						const shown = () => (showAll() ? group() : group().slice(0, 5));
						return (
							<details open data-testid={`group-project-${basenameOf(key)}`} class="mb-1">
								<summary class="flex cursor-pointer items-center gap-1 px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
									<span data-testid={`project-name-${basenameOf(key)}`} class="truncate">{basenameOf(key)}</span>
									<span class="bg-overlay px-1 text-[9px]">{group().length}</span>
									<button
										data-testid={`project-new-${basenameOf(key)}`}
										title={i18n.t("sidebar.newInProject")}
										class="ml-auto border border-border-strong px-1 text-[9px] hover:bg-foreground hover:text-background"
										onClick={(event) => {
											event.preventDefault();
											void navigate(`/new?cwd=${encodeURIComponent(key)}`);
										}}
									>
										+
									</button>
								</summary>
								<For each={group().filter((session) => session.pinned === true && shown().includes(session))}>
									{(session) => (
										<SessionRow
											session={session}
											unread={state.unread.includes(session.name)}
											selected={session.name === props.selected}
											onSelect={() => store.send({ op: "focus", session: session.name })}
											onDelete={() => store.send({ op: "session.delete", name: session.name })}
											onPin={() => store.send({ op: "session.pin", session: session.name, pinned: session.pinned !== true })}
											onArchive={() => store.send({ op: "session.archive", session: session.name, archived: session.archived !== true })}
											onRename={(title) => store.send({ op: "session.rename", session: session.name, title })}
										/>
									)}
								</For>
								<For each={shown().filter((session) => session.pinned !== true)}>
									{(session) => (
										<SessionRow
											session={session}
											unread={state.unread.includes(session.name)}
											selected={session.name === props.selected}
											onSelect={() => store.send({ op: "focus", session: session.name })}
											onDelete={() => store.send({ op: "session.delete", name: session.name })}
											onPin={() => store.send({ op: "session.pin", session: session.name, pinned: session.pinned !== true })}
											onArchive={() => store.send({ op: "session.archive", session: session.name, archived: session.archived !== true })}
											onRename={(title) => store.send({ op: "session.rename", session: session.name, title })}
										/>
									)}
								</For>
								<Show when={!showAll()}>
									<button data-testid={`project-more-${basenameOf(key)}`} class="w-full px-1 py-1 text-left text-[10px] text-accent" onClick={() => setExpanded((current) => [...current, key])}>
										{i18n.t("sidebar.showMore")} ({group().length - shown().length})
									</button>
								</Show>
							</details>
						);
					}}
				</For>
				<Show when={archived().length > 0}>
					<details data-testid="group-archived">
						<summary class="cursor-pointer px-1 pb-1 pt-2 text-[10px] font-semibold text-muted">{i18n.t("sidebar.archived")} ({archived().length})</summary>
						<For each={archived()}>
							{(session) => (
								<SessionRow
									session={session}
									unread={state.unread.includes(session.name)}
									selected={session.name === props.selected}
									onSelect={() => store.send({ op: "focus", session: session.name })}
									onDelete={() => store.send({ op: "session.delete", name: session.name })}
									onPin={() => store.send({ op: "session.pin", session: session.name, pinned: session.pinned !== true })}
									onArchive={() => store.send({ op: "session.archive", session: session.name, archived: session.archived !== true })}
									onRename={(title) => store.send({ op: "session.rename", session: session.name, title })}
								/>
							)}
						</For>
					</details>
				</Show>
			</div>
			<Show when={!state.connected}>
				<p data-testid="connection-banner" class="border-t border-border bg-warning/10 p-2 text-xs text-warning">{i18n.t("connection.disconnected")}</p>
			</Show>
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

function SessionRow(props: { session: SidebarSession; unread: boolean; selected: boolean; onSelect(): void; onDelete(): void; onPin(): void; onArchive(): void; onRename(title: string): void }) {
	const i18n = useAppI18n();
	const [menuOpen, setMenuOpen] = createSignal(false);
	return (
		<div
			role="button"
			data-testid={`session-row-${props.session.name}`}
			onClick={() => props.onSelect()}
			class={`group mb-1 cursor-pointer border border-transparent p-2 ${props.selected ? "border-border-strong bg-overlay" : "hover:bg-overlay"}`}
		>
			<div class="flex items-center gap-1">
				<span class="truncate text-sm">{props.session.title ?? props.session.name}</span>
				<Show when={props.session.pinned === true}>
					<span data-testid={`pinned-${props.session.name}`} class="text-[10px] text-muted">◆</span>
				</Show>
				<Show when={props.unread}>
					<span data-testid={`unread-${props.session.name}`} class="h-2 w-2 shrink-0 bg-accent" />
				</Show>
				<span data-testid={`session-age-${props.session.name}`} class="ml-auto shrink-0 mono text-[10px] text-muted">{humanizeAge(props.session.updated)}</span>
				<div class="relative shrink-0">
					<button
						data-testid={`session-menu-${props.session.name}`}
						aria-label="menu"
						class="border border-transparent px-1 text-xs text-muted hover:border-border-strong hover:text-foreground"
						onClick={(event) => {
							event.stopPropagation();
							setMenuOpen((current) => !current);
						}}
					>
						⋯
					</button>
					<Show when={menuOpen()}>
						<div data-testid={`session-menu-open-${props.session.name}`} class="absolute right-0 top-6 z-20 min-w-[120px] border-2 border-border-strong bg-elevated shadow-[4px_4px_0_0_var(--shadow)]">
							<button
								data-testid={`session-rename-${props.session.name}`}
								class="block w-full border-b border-border px-2 py-1 text-left text-xs hover:bg-overlay"
								onClick={(event) => {
									event.stopPropagation();
									setMenuOpen(false);
									const next = window.prompt(i18n.t("sidebar.renameTo"), props.session.title ?? props.session.name);
									if (next !== null && next.trim().length > 0) props.onRename(next.trim());
								}}
							>
								{i18n.t("sidebar.rename")}
							</button>
							<button
								data-testid={`session-pin-${props.session.name}`}
								class="block w-full border-b border-border px-2 py-1 text-left text-xs hover:bg-overlay"
								onClick={(event) => {
									event.stopPropagation();
									setMenuOpen(false);
									props.onPin();
								}}
							>
								{i18n.t(props.session.pinned === true ? "sidebar.unpin" : "sidebar.pin")}
							</button>
							<button
								data-testid={`session-archive-${props.session.name}`}
								class="block w-full border-b border-border px-2 py-1 text-left text-xs hover:bg-overlay"
								onClick={(event) => {
									event.stopPropagation();
									setMenuOpen(false);
									props.onArchive();
								}}
							>
								{i18n.t(props.session.archived === true ? "sidebar.unarchive" : "sidebar.archive")}
							</button>
							<button
								data-testid={`session-delete-${props.session.name}`}
								class="block w-full px-2 py-1 text-left text-xs text-danger hover:bg-overlay"
								onClick={(event) => {
									event.stopPropagation();
									setMenuOpen(false);
									props.onDelete();
								}}
							>
								{i18n.t("sidebar.delete")}
							</button>
						</div>
					</Show>
				</div>
			</div>
			<Show when={props.session.title !== undefined}>
				<p class="mono truncate text-[10px] text-muted">{props.session.name}</p>
			</Show>
			<div class="mt-1 flex flex-wrap gap-1">
				<For each={props.session.personas}>
					{(persona) => (
						<span data-testid={`session-persona-${props.session.name}`} class="mono bg-overlay px-1.5 py-0.5 text-[10px] text-foreground">
							{persona}
						</span>
					)}
				</For>
				<For each={props.session.badges}>
					{(badge) => (
						<span class={`px-1.5 py-0.5 text-[10px] ${BADGE_STYLES[badge] ?? "bg-overlay text-muted"}`}>
							{i18n.t(`sidebar.${badge === "ask-pending" ? "ask" : badge}` as "sidebar.running")}
						</span>
					)}
				</For>
			</div>
		</div>
	);
}
