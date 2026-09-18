import { useNavigate } from "@solidjs/router";
import { Show, createEffect, onCleanup, onMount, type Accessor, type Setter } from "solid-js";
import { openSettings } from "../lib/settings.ts";
import { useAppI18n } from "../i18n.ts";
import { etaStore, useEta } from "../lib/eta-store.ts";
import { MainHeader, SessionChrome } from "../app/session-chrome.tsx";
import { Timeline } from "../features/sessions/timeline.tsx";
import { Composer } from "../features/sessions/composer.tsx";
import { ContextBar } from "../features/sessions/context-bar.tsx";
import { AskModal } from "../features/sessions/ask-modal.tsx";
import { BtwDialog } from "../features/sessions/btw-dialog.tsx";
import { ForkDialog } from "../features/sessions/fork-dialog.tsx";
import { forkDialogOpen, openForkDialog, setForkDialogOpen } from "../lib/fork.ts";
import { btwDialogOpen, setBtwDialogOpen } from "../lib/btw.ts";
import { TerminalHost } from "../features/sessions/terminal-host.tsx";
import { Welcome } from "../features/sessions/welcome.tsx";
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

/** Leave only after an authoritative list confirms the active session was removed
 * or newly archived. Remember its workspace before the list drops that metadata. */
function useSessionRemovalNavigation() {
	const store = etaStore();
	const navigate = useNavigate();
	const active = () => {
		const state = store.snapshot();
		const name = state.attach ?? state.sessions[0]?.name;
		const session = state.sessions.find((item) => item.name === name);
		return session === undefined ? undefined : {
			name: session.name,
			cwd: session.cwd ?? state.views[session.name]?.cwd,
			remoteId: session.remote?.connectionId ?? parseRemoteSession(session.name)?.connectionId,
			archived: session.archived === true,
		};
	};
	let previous = active();
	onCleanup(store.subscribe((frame) => {
		const leaving = previous;
		previous = active();
		if (leaving === undefined || frame === undefined || !("type" in frame) || frame.type !== "sessions") return;
		const current = frame.sessions.find((session) => session.name === leaving.name);
		if (current !== undefined && (current.archived !== true || leaving.archived)) return;
		const params = new URLSearchParams();
		if (leaving.cwd !== undefined) params.set("cwd", leaving.cwd);
		if (leaving.remoteId !== undefined) params.set("remote", leaving.remoteId);
		const query = params.toString();
		void navigate(query ? `/new?${query}` : "/new", { replace: true });
	}));
}

export function SessionsPage() {
	// An app route is a router navigation, never a `location.assign`: in the shell
	// that asks `views://` for a file that is not in the bundle.
	const goSettings = openSettings;
	useRunNotifications();
	useDeepLink();
	useSessionRemovalNavigation();
	return <SessionChrome main={(chrome) => <SessionsMain {...chrome} onSettings={goSettings} />} />;
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
	const headerCwd = () => view()?.cwd;
	// The sidebar entry carries cwd from the hello frame; the view only gets it
	// stamped on the next refresh, which would start the shell in $HOME.
	const termCwd = () => state.sessions.find((session) => session.name === selected())?.cwd ?? view()?.cwd;

	return (
		<div class="flex min-h-0 flex-1 flex-col">
			<MainHeader
				title={selected() ?? i18n.t("app.title")}
				remote={state.sessions.find((session) => session.name === selected())?.remote}
				{...(headerCwd() === undefined ? {} : { cwd: headerCwd() })}
				trailing={
					<button
						data-testid="header-fork"
						title={i18n.t("cmd.fork")}
						class="header-chip border uppercase tracking-wider"
						onClick={() => openForkDialog()}
					>
						{i18n.t("fork.action")}
					</button>
				}
			/>
			<Show
				when={state.sessions.length === 0}
				fallback={
					<Show when={view()} fallback={<p class="p-6 text-sm text-muted">{i18n.t("sidebar.noSessions")}</p>}>
						{(current) => (
							<>
								<Timeline view={current()} session={selected() ?? ""} running={running()} onFork={(entryId) => openForkDialog(entryId)} />
								<Composer
									session={selected() ?? ""}
									running={running()}
									hasPendingAsk={current().pendingAsk !== undefined}
									topSlot={<SessionContextBar />}
									onNavigateSettings={props.onSettings}
									onToggleTerminal={() => props.setTermOpen((open) => !open)}
									onBtw={() => setBtwDialogOpen(true)}
								onFork={() => openForkDialog()}
									queue={current().queue}
								/>
								<Show when={props.termOpen() && view() !== undefined}>
									<TerminalHost variant="drawer" {...(termCwd() === undefined ? {} : { cwd: termCwd()! })} {...(parseRemoteSession(selected() ?? "") ? { remote: parseRemoteSession(selected() ?? "")!.connectionId } : {})} onClose={() => props.setTermOpen(false)} />
								</Show>
								<AskModal session={selected() ?? ""} view={current()} />
								{/* Rendered here, not in the context panel: `/btw` is a request to answer now, so the dialog does not wait for whichever tab the right rail happens to be on. */}
								<BtwDialog session={selected() ?? ""} view={current()} open={btwDialogOpen()} onOpenChange={setBtwDialogOpen} />
								{/* The chooser sits over the transcript it is cutting, not over the right rail: the message
								    you fork from is the one you were just reading. */}
								<ForkDialog session={selected() ?? ""} view={current()} open={forkDialogOpen()} onOpenChange={setForkDialogOpen} />
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
