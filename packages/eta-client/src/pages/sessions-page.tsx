import { Show, createEffect, onMount, type Accessor, type Setter } from "solid-js";
import { openSettings } from "../lib/settings.ts";
import { useAppI18n } from "../i18n.ts";
import { etaStore, useEta } from "../lib/eta-store.ts";
import { MainHeader, SessionChrome } from "../app/session-chrome.tsx";
import { Timeline } from "../features/sessions/timeline.tsx";
import { Composer } from "../features/sessions/composer.tsx";
import { ContextBar } from "../features/sessions/context-bar.tsx";
import { AskModal } from "../features/sessions/ask-modal.tsx";
import { BtwDialog } from "../features/sessions/btw-dialog.tsx";
import { btwDialogOpen, setBtwDialogOpen } from "../lib/btw.ts";
import { TerminalHost } from "../features/sessions/terminal-host.tsx";
import { Welcome } from "../features/sessions/welcome.tsx";

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
	// An app route is a router navigation, never a `location.assign`: in the shell
	// that asks `views://` for a file that is not in the bundle.
	const goSettings = openSettings;
	useRunNotifications();
	useDeepLink();
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
			<MainHeader title={selected() ?? i18n.t("app.title")} {...(headerCwd() === undefined ? {} : { cwd: headerCwd() })} />
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
									<TerminalHost variant="drawer" {...(termCwd() === undefined ? {} : { cwd: termCwd()! })} onClose={() => props.setTermOpen(false)} />
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
