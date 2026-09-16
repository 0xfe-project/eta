import { For, Show, createEffect, createSignal, onCleanup, onMount, type Accessor, type Setter } from "solid-js";
import { openSettings } from "../lib/settings.ts";
import { useAppI18n } from "../i18n.ts";
import { AppShell } from "../app/app-shell.tsx";
import { useEta } from "../lib/eta-store.ts";
import { Sidebar } from "../features/sessions/sidebar.tsx";
import { Timeline } from "../features/sessions/timeline.tsx";
import { Composer } from "../features/sessions/composer.tsx";
import { ContextBar } from "../features/sessions/context-bar.tsx";
import { AskModal } from "../features/sessions/ask-modal.tsx";
import { BtwDialog } from "../features/sessions/btw-dialog.tsx";
import { btwDialogOpen, setBtwDialogOpen } from "../lib/btw.ts";
import { ContextPanel } from "../features/sessions/context-panel.tsx";
import { LogRail } from "../features/sessions/log-rail.tsx";
import { WorkspacePanel } from "../features/sessions/workspace-panel.tsx";
import { CommandPalette } from "../features/sessions/command-palette.tsx";
import { Welcome } from "../features/sessions/welcome.tsx";
import { TerminalHost } from "../features/sessions/terminal-host.tsx";
import { etaStore } from "../lib/eta-store.ts";
import { parseRemoteSession } from "../lib/remotes.ts";

function useRunNotifications() {
	const state = useEta();
	const seen: { current: Record<string, boolean> } = { current: {} };
	createEffect(() => {
		const runningBySession = state.runningBySession;
		const attach = state.attach;
		for (const [name, running] of Object.entries(runningBySession)) {
			const was = seen.current[name] === true;
			seen.current[name] = running;
			if (was && !running && name !== attach && typeof Notification !== "undefined" && Notification.permission === "granted") {
				const notification = new Notification(`eta · ${name}`, { body: "run finished", tag: `eta-${name}` });
				notification.onclick = () => {
					etaStore().send({ op: "focus", session: name });
					window.focus();
				};
			}
		}
	});
}

function useDeepLink() {
	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		const session = params.get("session");
		if (session !== null) {
			etaStore().send({ op: "focus", session });
			params.delete("session");
			const query = params.toString();
			window.history.replaceState(null, "", `${window.location.pathname}${query.length > 0 ? `?${query}` : ""}`);
		}
	});
}

export function SessionsPage() {
	const [termOpen, setTermOpen] = createSignal(false);
	// An app route is a router navigation, never a `location.assign`: in the shell
	// that asks `views://` for a file that is not in the bundle.
	const goSettings = openSettings;
	useRunNotifications();
	useDeepLink();
	return (
		<AppShell
			palette={<CommandPalette />}
			sidebar={<SessionsSidebar termOpen={termOpen} onTerminal={() => setTermOpen((open) => !open)} />}
			main={<SessionsMain termOpen={termOpen} setTermOpen={setTermOpen} onSettings={goSettings} />}
			panel={<SessionsPanel />}
		/>
	);
}

function SessionsSidebar(props: { termOpen: Accessor<boolean>; onTerminal: () => void }) {
	const state = useEta();
	const selected = () => state.attach ?? state.sessions[0]?.name ?? null;
	return <Sidebar selected={selected()} termActive={props.termOpen()} onTerminal={props.onTerminal} />;
}

function SessionsMain(props: { termOpen: Accessor<boolean>; setTermOpen: Setter<boolean>; onSettings: () => void }) {
	const i18n = useAppI18n();
	const state = useEta();
	const selected = () => state.attach ?? state.sessions[0]?.name ?? null;
	const view = () => {
		const name = selected();
		return name === null ? undefined : state.views[name];
	};
	const running = () => selected() === null ? false : (state.sessions.find((session) => session.name === selected())?.badges.includes("running") ?? false);
	// The sidebar entry carries cwd from the hello frame; the view only gets it
	// stamped on the next refresh, which would start the shell in $HOME.
	const termCwd = () => state.sessions.find((session) => session.name === selected())?.cwd ?? view()?.cwd;

	return (
		<div class="flex min-h-0 flex-1 flex-col">
			<header class="topbar gap-2 px-4">
				<span data-testid="active-session" class="truncate text-sm font-medium">{selected() ?? i18n.t("app.title")}</span>
				<span class="ml-auto flex items-center gap-1.5">
					{/* Only the folder. Tokens and cache rate live in the Context panel's usage section,
					    where they are broken down rather than shrunk into two rounded chips, and the
					    branch is already on the Workspace tab — a header reads as one fact, not a strip
					    of gauges. */}
					{/* Which machine this session belongs to, and whether we can still reach it:
					    the same absolute path exists on both sides, so the header has to say. */}
					<Show when={state.sessions.find((session) => session.name === selected())?.remote}>
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
					<Show when={view()?.cwd}>
						{(cwd) => <span data-testid="header-cwd" class="header-chip max-w-[220px] truncate" title={cwd()}>{cwd()}</span>}
					</Show>
					<span data-testid="conn-dot" class={`conn-dot ${state.connected ? "on" : "off"}`} title={state.connected ? "" : i18n.t("connection.disconnected")} />
				</span>
			</header>
			<OpErrorStrip />
			<Show
				when={state.sessions.length === 0}
				fallback={
					<Show when={view()} fallback={<p class="p-6 text-sm text-muted">{i18n.t("sidebar.noSessions")}</p>}>
						{(current) => (
							<>
								<Timeline view={current()} session={selected() ?? ""} running={running()} />
								<Composer
									session={selected() ?? ""}
									running={running()}
									hasPendingAsk={current().pendingAsk !== undefined}
									topSlot={<SessionContextBar />}
									onNavigateSettings={props.onSettings}
									onToggleTerminal={() => props.setTermOpen((open) => !open)}
									onBtw={() => setBtwDialogOpen(true)}
									queue={current().queue}
								/>
								<Show when={props.termOpen() && view() !== undefined}>
									<TerminalHost variant="drawer" {...(termCwd() === undefined ? {} : { cwd: termCwd()! })} {...(parseRemoteSession(selected() ?? "") ? { remote: parseRemoteSession(selected() ?? "")!.connectionId } : {})} onClose={() => props.setTermOpen(false)} />
								</Show>
								<AskModal session={selected() ?? ""} view={current()} />
								{/* Rendered here, not in the context panel: `/btw` is a request to answer now, so the dialog does not wait for whichever tab the right rail happens to be on. */}
								<BtwDialog session={selected() ?? ""} view={current()} open={btwDialogOpen()} onOpenChange={setBtwDialogOpen} />
							</>
						)}
					</Show>
				}
			>
				<Welcome onCreated={() => undefined} onNavigateSettings={props.onSettings} />
			</Show>
		</div>
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

function SessionContextBar() {
	const state = useEta();
	const selected = () => state.attach ?? state.sessions[0]?.name ?? null;
	const view = () => {
		const name = selected();
		return name === null ? undefined : state.views[name];
	};
	return (
		<Show when={view()}>
			{(current) => <ContextBar session={selected() ?? ""} view={current()} />}
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
