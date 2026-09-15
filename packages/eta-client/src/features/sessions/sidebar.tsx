import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { useAppI18n } from "../../i18n.ts";
import { etaStore, useEta } from "../../lib/eta-store.ts";
import { sidebarPrefs, type ProjectSort } from "../../lib/prefs.ts";
import type { SidebarSession } from "@eta/core";
import { apiFetch } from "../../lib/host.ts";
import { openSettings } from "../../lib/settings.ts";

// Graphite rule: saturation reserved for state (goal ok / ask needs attention / running).
const BADGE_STYLES: Record<string, string> = {
	running: "bg-accent text-accent-foreground",
	goal: "text-success",
	"ask-pending": "bg-warning/20 text-warning",
	loop: "bg-overlay text-muted",

	"goal-done": "bg-primary/20 text-primary",
};

const PINNED_GROUP = "\u0000pinned";
const ARCHIVED_GROUP = "\u0000archived";
const UNGROUPED = "\u0000ungrouped";
const GROUP_LIMIT = 6;

interface Group {
	key: string;
	/** Full cwd, or UNGROUPED when the session has no cwd at all. */
	path: string;
	label: string;
	/** Set when another cwd shares this basename, so the two stay tellable apart. */
	parent: string;
	sessions: SidebarSession[];
	running: number;
	unread: number;
}

function basenameOf(path: string): string {
	return path.split("/").filter((part) => part.length > 0).pop() ?? path;
}

function parentOf(path: string): string {
	const parts = path.split("/").filter((part) => part.length > 0);
	return parts.length < 2 ? "" : parts[parts.length - 2]!;
}

export function Sidebar(props: { selected: string | null; termActive: boolean; onTerminal: () => void }) {
	const i18n = useAppI18n();
	const state = useEta();
	const store = etaStore();
	const navigate = useNavigate();
	/** The sidebar routes its own links. The router listens for anchor clicks at the
	 *  document and drops any href whose origin is not the page's own — and in the
	 *  shell the page is `views://eta/index.html`, so a plain <A> is a link that does
	 *  nothing. The href stays: in a browser tab it is still a real link. */
	const routeTo = (event: MouseEvent, path: string) => {
		event.preventDefault();
		if (path === "/settings") openSettings();
		else void navigate(path);
	};
	const [query, setQuery] = createSignal("");
	const [hits, setHits] = createSignal<{ session: string; snippet: string }[] | null>(null);
	const collapsed = () => sidebarPrefs.collapsed;
	const sort = () => sidebarPrefs.sort;
	const [expanded, setExpanded] = createSignal<string[]>([]);

	const search = (value: string) => {
		setQuery(value);
		if (value.trim().length < 2) {
			setHits(null);
			return;
		}
		void apiFetch(`/api/search?q=${encodeURIComponent(value)}`)
			.then((response) => response.json() as Promise<{ hits: { session: string; snippet: string }[] }>)
			.then((body) => setHits(body.hits))
			.catch(() => setHits(null));
	};

	const byUpdated = (a: SidebarSession, b: SidebarSession) => (b.updated ?? 0) - (a.updated ?? 0);
	const isUnread = (session: SidebarSession) => state.unread.includes(session.name);
	const visible = createMemo(() => state.sessions.filter((session) => session.archived !== true));
	const archived = createMemo(() => state.sessions.filter((session) => session.archived === true));
	const pinned = createMemo(() => visible().filter((session) => session.pinned === true).sort(byUpdated));

	const groups = createMemo<Group[]>(() => {
		const keys = [...new Set(visible().filter((session) => session.pinned !== true).map((session) => session.cwd ?? UNGROUPED))];
		const built = keys.map((key) => {
			const members = visible()
				.filter((session) => session.pinned !== true && (session.cwd ?? UNGROUPED) === key)
				.sort(byUpdated);
			return {
				key,
				path: key,
				label: key === UNGROUPED ? i18n.t("sidebar.ungrouped") : basenameOf(key),
				parent: "",
				sessions: members,
				running: members.filter((session) => session.badges.includes("running")).length,
				unread: members.filter(isUnread).length,
			} satisfies Group;
		});
		const duplicated = new Set(built.map((group) => group.label).filter((label, index, all) => all.indexOf(label) !== index));
		for (const group of built) group.parent = duplicated.has(group.label) ? parentOf(group.path) : "";
		return built.sort((a, b) =>
			sort() === "name"
				? a.label.localeCompare(b.label)
				: Math.max(0, ...b.sessions.map((session) => session.updated ?? 0)) - Math.max(0, ...a.sessions.map((session) => session.updated ?? 0)),
		);
	});

	const toggleGroup = (key: string) => sidebarPrefs.toggleCollapsed(key);
	const isOpen = (key: string) => !collapsed().includes(key);
	const testKeyOf = (group: Group) => (group.path === UNGROUPED ? "ungrouped" : basenameOf(group.path));

	const rowProps = (session: SidebarSession) => ({
		session,
		unread: isUnread(session),
		selected: session.name === props.selected,
		onSelect: () => store.send({ op: "focus", session: session.name }),
		onDelete: () => store.send({ op: "session.delete", name: session.name }),
		onPin: () => store.send({ op: "session.pin", session: session.name, pinned: session.pinned !== true }),
		onArchive: () => store.send({ op: "session.archive", session: session.name, archived: session.archived !== true }),
		onRename: (title: string) => store.send({ op: "session.rename", session: session.name, title }),
	});

	return (
		<div class="flex h-full flex-col" data-testid="sidebar">
			{/* The window-drag strip. In the shell this band *is* the titlebar: a press
			    in it moves the window, so nothing clickable belongs here — a button on a
			    drag region is a button that eats the click. */}
			<div class="topbar gap-2 px-3">
				{/* In the shell the window paints the three lights over this slot; in a tab
				    there are none and it collapses to nothing. */}
				<span class="lights-slot" data-testid="lights-slot" />
				<span class="logo-slot" data-testid="logo-slot">
					<img src="/Eta-Logo.svg" alt="eta" class="h-5 w-5" data-testid="logo" />
				</span>
				<span class="brand" data-testid="brand">{i18n.t("app.name")}</span>
			</div>
			{/* New session rides with the search field: both are about the list. */}
			<div class="flex shrink-0 items-center gap-1 px-2 pt-2">
				<input
					data-testid="sidebar-search"
					value={query()}
					onInput={(event) => search(event.currentTarget.value)}
					placeholder={i18n.t("sidebar.search")}
					class="min-w-0 flex-1 border border-border bg-elevated px-2 py-1 text-xs outline-none placeholder:text-muted"
				/>
				<A href="/new" data-testid="nav-new" onClick={(event) => routeTo(event, "/new")} class="shrink-0 whitespace-nowrap bg-accent px-2 py-1 text-xs font-medium text-accent-foreground">
					{i18n.t("nav.new")}
				</A>
			</div>
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
				<Show when={pinned().length > 0}>
					<Section
						testid="group-pinned"
						title={i18n.t("sidebar.pinned")}
						count={pinned().length}
						open={isOpen(PINNED_GROUP)}
						onToggle={() => toggleGroup(PINNED_GROUP)}
					>
						<For each={pinned()}>{(session) => <SessionRow {...rowProps(session)} />}</For>
					</Section>
				</Show>
				<For each={groups()}>
					{(group) => {
						const key = testKeyOf(group);
						const showAll = () => expanded().includes(group.key) || group.sessions.length <= GROUP_LIMIT;
						const shown = () => (showAll() ? group.sessions : group.sessions.slice(0, GROUP_LIMIT));
						return (
							<Section
								testid={`group-project-${key}`}
								title={group.label}
								path={group.path === UNGROUPED ? undefined : group.path}
								parent={group.parent}
								running={group.running}
								unreadCount={group.unread}
								count={group.sessions.length}
								open={isOpen(group.key)}
								onToggle={() => toggleGroup(group.key)}
								newTitle={i18n.t("sidebar.newInProject")}
								onNew={group.path === UNGROUPED ? undefined : () => void navigate(`/new?cwd=${encodeURIComponent(group.path)}`)}
							>
								<For each={shown()}>{(session) => <SessionRow {...rowProps(session)} />}</For>
								<Show when={!showAll()}>
									<button data-testid={`project-more-${key}`} class="w-full px-1 py-1 text-left text-[10px] text-accent" onClick={() => setExpanded((current) => [...current, group.key])}>
										{i18n.t("sidebar.showMore")} ({group.sessions.length - shown().length})
									</button>
								</Show>
							</Section>
						);
					}}
				</For>
				<Show when={archived().length > 0}>
					<Section
						testid="group-archived"
						title={i18n.t("sidebar.archived")}
						count={archived().length}
						open={isOpen(ARCHIVED_GROUP)}
						onToggle={() => toggleGroup(ARCHIVED_GROUP)}
					>
						<For each={archived()}>{(session) => <SessionRow {...rowProps(session)} />}</For>
					</Section>
				</Show>
			</div>
			<Show when={!state.connected}>
				<p data-testid="connection-banner" class="border-t border-border bg-warning/10 p-2 text-xs text-warning">{i18n.t("connection.disconnected")}</p>
			</Show>
			{/* Pinned, under the scroll and out of the drag strip: the two ways out of
			    the list. Every app keeps them here, so nobody has to look for them. */}
			<div class="flex shrink-0 items-center gap-1 border-t border-border px-2 py-2" data-testid="sidebar-foot">
				<A href="/settings" data-testid="nav-settings" onClick={(event) => routeTo(event, "/settings")} class="shrink-0 whitespace-nowrap border border-border px-2 py-1 text-xs text-muted hover:bg-foreground hover:text-background">
					{i18n.t("nav.settings")}
				</A>
				<button
					data-testid="term-toggle"
					onClick={() => props.onTerminal()}
					title={i18n.t("term.title")}
					class={`ml-auto shrink-0 whitespace-nowrap border border-border-strong px-2 py-1 text-xs uppercase tracking-[0.12em] text-muted hover:bg-foreground hover:text-background ${props.termActive ? "bg-foreground text-background" : ""}`}
				>
					{i18n.t("term.open")}
				</button>
			</div>
		</div>
	);
}

function Section(props: {
	testid: string;
	title: string;
	path?: string;
	parent?: string;
	count: number;
	running?: number;
	unreadCount?: number;
	open: boolean;
	onToggle(): void;
	newTitle?: string;
	onNew?(): void;
	children?: JSX.Element;
}) {
	return (
		<div class="mb-1" data-testid={props.testid}>
			<div class="flex items-center gap-1 px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
				<button
					data-testid={`${props.testid}-toggle`}
					title={props.path ?? props.title}
					onClick={props.onToggle}
					class="flex min-w-0 items-center gap-1 hover:text-foreground"
				>
					<span class="shrink-0">{props.open ? "▾" : "▸"}</span>
					<span data-testid={props.testid.replace("group-", "project-name-")} class="truncate">{props.title}</span>
					<Show when={(props.parent ?? "").length > 0}>
						<span class="mono shrink-0 text-[9px] normal-case text-faint">/{props.parent}</span>
					</Show>
				</button>
				<Show when={(props.running ?? 0) > 0}>
					<span data-testid={`${props.testid}-running`} class="bg-accent px-1 text-[9px] text-accent-foreground">{props.running}</span>
				</Show>
				<Show when={(props.unreadCount ?? 0) > 0}>
					<span data-testid={`${props.testid}-unread`} class="bg-overlay px-1 text-[9px] text-accent">{props.unreadCount}</span>
				</Show>
				<span class="bg-overlay px-1 text-[9px]">{props.count}</span>
				<Show when={props.onNew !== undefined}>
					<button
						data-testid={props.testid.replace("group-project-", "project-new-")}
						title={props.newTitle}
						class="ml-auto border border-border-strong px-1 text-[9px] hover:bg-foreground hover:text-background"
						onClick={props.onNew}
					>
						+
					</button>
				</Show>
			</div>
			<Show when={props.open}>{props.children}</Show>
		</div>
	);
}

/** Title replaced in place: focused and selected, so renaming means typing, not clicking twice. */
function RenameField(props: { testid: string; initial: string; onCommit(next: string): void; onCancel(): void }) {
	const [value, setValue] = createSignal(props.initial);
	let field: HTMLInputElement | undefined;
	onMount(() => {
		field?.focus();
		field?.select();
	});
	return (
		<input
			data-testid={props.testid}
			ref={field}
			value={value()}
			onInput={(event) => setValue(event.currentTarget.value)}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Enter") props.onCommit(value());
				if (event.key === "Escape") props.onCancel();
			}}
			onBlur={() => props.onCommit(value())}
			onClick={(event) => event.stopPropagation()}
			class="mono min-w-0 flex-1 border border-accent bg-elevated px-1 text-sm outline-none"
		/>
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
	const [draft, setDraft] = createSignal<string | null>(null);
	let anchor: HTMLDivElement | undefined;

	// The menu lives inside a scrolling list and is gone as soon as anything else
	// takes focus, so it closes on outside press and on Escape rather than only
	// from its own trigger.
	createEffect(() => {
		if (!menuOpen()) return;
		const onPointer = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (target !== null && anchor !== undefined && anchor.contains(target)) return;
			setMenuOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenuOpen(false);
		};
		document.addEventListener("mousedown", onPointer);
		document.addEventListener("keydown", onKey);
		onCleanup(() => {
			document.removeEventListener("mousedown", onPointer);
			document.removeEventListener("keydown", onKey);
		});
	});

	const title = () => props.session.title ?? props.session.name;
	// Blur fires once more as the field unmounts; the cleared draft makes that a no-op.
	const applyRename = (next: string) => {
		if (draft() === null) return;
		setDraft(null);
		const trimmed = next.trim();
		if (trimmed.length > 0 && trimmed !== title()) props.onRename(trimmed);
	};

	return (
		<div
			role="button"
			data-testid={`session-row-${props.session.name}`}
			onClick={() => props.onSelect()}
			class={`group mb-1 cursor-pointer border border-transparent p-2 ${props.selected ? "border-border-strong bg-overlay" : "hover:bg-overlay"}`}
		>
			<div class="flex items-center gap-1">
				<Show
					when={draft() === null}
					fallback={
						<RenameField
							testid={`session-rename-input-${props.session.name}`}
							initial={draft() ?? ""}
							onCommit={applyRename}
							onCancel={() => setDraft(null)}
						/>
					}
				>
					<span class="truncate text-sm">{title()}</span>
				</Show>
				<Show when={props.session.pinned === true}>
					<span data-testid={`pinned-${props.session.name}`} class="text-[10px] text-muted">◆</span>
				</Show>
				<Show when={props.unread}>
					<span data-testid={`unread-${props.session.name}`} class="h-2 w-2 shrink-0 bg-accent" />
				</Show>
				<span data-testid={`session-age-${props.session.name}`} class="ml-auto shrink-0 mono text-[10px] text-muted">{humanizeAge(props.session.updated)}</span>
				<div ref={anchor} class="relative shrink-0">
					<button
						data-testid={`session-menu-${props.session.name}`}
						aria-label="menu"
						aria-expanded={menuOpen()}
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
									setDraft(title());
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
			<Show when={props.session.cwd !== undefined}>
				<p class="mono truncate text-[10px] text-faint" title={props.session.cwd}>{props.session.cwd}</p>
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
