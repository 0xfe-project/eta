import { For, Show, createEffect, createSignal, onCleanup, type Accessor, type JSX, type Setter } from "solid-js";
import { useAppI18n } from "../i18n.ts";
import { useEta } from "../lib/eta-store.ts";
import type { SidebarSession } from "@eta/core";
import { parseRemoteSession } from "../lib/remotes.ts";
import { AppShell } from "./app-shell.tsx";
import { Sidebar } from "../features/sessions/sidebar.tsx";
import { CommandPalette } from "../features/sessions/command-palette.tsx";
import { ContextPanel } from "../features/sessions/context-panel.tsx";
import { WorkspacePanel } from "../features/sessions/workspace-panel.tsx";
import { LogRail } from "../features/sessions/log-rail.tsx";
import { TerminalHost } from "../features/sessions/terminal-host.tsx";

/**
 * The chrome every session route wears: sidebar, right rail, palette, and the header strip
 * over the main column. It lives here because `/new` used to render none of it — ⌘N read as
 * leaving the app and coming back, and the drawers you had opened were gone with the route.
 * The new-session route keeps the layout but leaves session-specific contents blank.
 */
export interface Chrome {
	termOpen: Accessor<boolean>;
	setTermOpen: Setter<boolean>;
}

export function SessionChrome(props: {
	main: (chrome: Chrome) => JSX.Element;
	/** A creation draft has no active session to show in the rail or sidebar. */
	newSession?: boolean;
	/** Called after the sidebar picks a session. The route that replaces the transcript passes
	 * it so a click on the list is also a way out; `/` leaves it alone — there is nowhere to go. */
	onSelected?: (session: string) => void;
}) {
	const [termOpen, setTermOpen] = createSignal(false);
	return (
		<AppShell
			palette={<CommandPalette />}
			sidebar={<SessionsSidebar newSession={props.newSession} termOpen={termOpen} onTerminal={() => setTermOpen((open) => !open)} {...(props.onSelected === undefined ? {} : { onSelected: props.onSelected })} />}
			main={props.main({ termOpen, setTermOpen })}
			panel={<Show when={!props.newSession}><SessionsPanel /></Show>}
		/>
	);
}

function SessionsSidebar(props: { newSession?: boolean; termOpen: Accessor<boolean>; onTerminal: () => void; onSelected?: (session: string) => void }) {
	const state = useEta();
	const selected = () => props.newSession ? null : state.attach ?? state.sessions[0]?.name ?? null;
	return <Sidebar selected={selected()} termActive={props.termOpen()} onTerminal={props.onTerminal} {...(props.onSelected === undefined ? {} : { onSelected: props.onSelected })} />;
}

/**
 * The one line that says where you are. One fact — the session, or what you are about to
 * make — plus the folder it belongs to and whether the socket is up. Token and cache rate
 * live in the Context panel's usage section, the branch on the Workspace tab; a header is
 * not a strip of gauges.
 */
export function MainHeader(props: { title: string; cwd?: string; remote?: SidebarSession["remote"]; trailing?: JSX.Element }) {
	const i18n = useAppI18n();
	const state = useEta();
	return (
		<>
			<header class="topbar gap-2 px-4">
				<span data-testid="active-session" class="truncate text-sm font-medium">{props.title}</span>
				<span class="ml-auto flex items-center gap-1.5">
					<Show when={props.remote}>
						{(remote) => (
							<span
								data-testid="header-remote"
								data-status={remote().status}
								class={`header-chip border uppercase tracking-wider ${remote().status === "connected" ? "border-border-strong" : "border-warning text-warning"}`}
								title={`${remote().label} · ${remote().host} · ${i18n.t(`remote.status.${remote().status}` as "remote.status.disconnected")}`}
							>
								{remote().label}
							</span>
						)}
					</Show>
					<Show when={props.cwd}>
						{(cwd) => <span data-testid="header-cwd" class="header-chip max-w-[220px] truncate" title={cwd()}>{cwd()}</span>}
					</Show>
					{props.trailing}
					<span data-testid="conn-dot" class={`conn-dot ${state.connected ? "on" : "off"}`} title={state.connected ? "" : i18n.t("connection.disconnected")} />
				</span>
			</header>
			<OpErrorStrip />
		</>
	);
}

/**
 * The one place a refused op becomes visible. The store keeps the last message the
 * server sent with `type: "error"` and clears it on the next hello, so the strip has to
 * carry its own way out: a refused click should not shout over the session for the rest
 * of the day. Without it, a rejected op looks exactly like one that worked.
 */
function OpErrorStrip() {
	const i18n = useAppI18n();
	const state = useEta();
	const [dismissed, setDismissed] = createSignal<string | null>(null);
	createEffect(() => {
		if (state.error !== null) setDismissed(null);
	});
	const shown = () => (state.error === null || state.error === dismissed() ? null : state.error);
	return (
		<Show when={shown()}>
			{(message) => (
				<div data-testid="op-error" class="flex items-center gap-2 border-b-2 border-danger px-4 py-1">
					<span class="mono min-w-0 flex-1 truncate text-[11px] text-danger">{message()}</span>
					<button data-testid="op-error-dismiss" class="mono shrink-0 text-[10px] text-faint hover:text-foreground" onClick={() => setDismissed(state.error)}>
						{i18n.t("error.dismiss")}
					</button>
				</div>
			)}
		</Show>
	);
}

function SessionsPanel() {
	const i18n = useAppI18n();
	const state = useEta();
	const [tab, setTab] = createSignal<"context" | "workspace" | "terminal" | "log">("context");
	// The loop chip above the composer points here: the panel is where loops are managed,
	// so the click lands on the tab that holds them.
	const showLoops = () => setTab("context");
	window.addEventListener("eta:show-loops", showLoops);
	onCleanup(() => window.removeEventListener("eta:show-loops", showLoops));
	// The terminal mounts on first use and is then only hidden: unmounting it
	// would kill the pty, and `vim` with it.
	const [terminalMounted, setTerminalMounted] = createSignal(false);
	const selected = () => state.attach ?? state.sessions[0]?.name ?? null;
	const view = () => {
		const name = selected();
		return name === null ? undefined : state.views[name];
	};
	const termCwd = () => state.sessions.find((session) => session.name === selected())?.cwd ?? view()?.cwd;
	const tabs = [
		{ key: "context", label: "nav.context" },
		{ key: "workspace", label: "nav.workspace" },
		{ key: "terminal", label: "nav.terminal" },
		{ key: "log", label: "nav.log" },
	] as const;

	return (
		<Show when={view()}>
			{(current) => (
				<div class="flex h-full flex-col">
					<div class="tabstrip gap-1 px-2">
						<For each={tabs}>
							{(item) => (
								<button
									data-testid={`tab-${item.key}`}
									onClick={() => {
										if (item.key === "terminal") setTerminalMounted(true);
										setTab(item.key);
									}}
									class={`px-3 py-1 text-xs ${tab() === item.key ? "bg-overlay font-medium" : "text-muted"}`}
								>
									{i18n.t(item.label)}
								</button>
								)}
						</For>
					</div>
					<div class="relative min-h-0 flex-1">
						<Show when={tab() === "context"}>
							<ContextPanel session={selected() ?? ""} view={current()} />
						</Show>
						<Show when={tab() === "workspace"}>
							<WorkspacePanel session={selected() ?? ""} />
						</Show>
						<Show when={tab() === "log"}>
							<LogRail frames={selected() === null ? [] : state.dev[selected()!] ?? []} />
						</Show>
						<Show when={terminalMounted()}>
							<div
								data-testid="panel-terminal"
								data-active={tab() === "terminal" ? "1" : "0"}
								class={`absolute inset-0 ${tab() === "terminal" ? "" : "invisible"}`}
							>
								<TerminalHost variant="panel" {...(termCwd() === undefined ? {} : { cwd: termCwd()! })} {...(parseRemoteSession(selected() ?? "") ? { remote: parseRemoteSession(selected() ?? "")!.connectionId } : {})} onClose={() => setTerminalMounted(false)} />
							</div>
						</Show>
					</div>
				</div>
			)}
		</Show>
	);
}
