import { Show, onMount } from "solid-js";
import { render } from "solid-js/web";
import { HashRouter, Route, Router, useNavigate } from "@solidjs/router";
import "./styles/graphite.css";
import "./styles.css";
import "./i18n.ts";
import { host } from "./lib/host.ts";
import { installAppBehavior } from "./lib/app-behavior.ts";
import { installKeyProbe } from "./lib/key-probe.ts";

// Right-click, drag, drop and zoom are browser behaviour until someone says
// otherwise, so this runs before the first render rather than from a component:
// the rules have to hold over content that has not mounted yet.
installAppBehavior();
// Dev only, and only with ?keys: what the page was actually handed by the shell.
installKeyProbe();

// The shell and a browser tab want different chrome; CSS reads these.
document.documentElement.dataset.host = host().kind;
if (host().platform !== undefined) document.documentElement.dataset.platform = host().platform;
import { ThemeProvider } from "./app/theme.tsx";
import { SessionsPage } from "./pages/sessions-page.tsx";
import { NewSessionPage } from "./pages/new-session-page.tsx";
import { SettingsHost } from "./features/settings/settings-dialog.tsx";
import { openSettings } from "./lib/settings.ts";

function SettingsRoute() {
	const navigate = useNavigate();
	onMount(() => { openSettings(); void navigate("/", { replace: true }); });
	return null;
}

function NotFound() {
	return null;
}

/**
 * The routes, in two containers. A browser tab gets the history router. The shell
 * loads this page from `views://eta/index.html`, where the pathname is a file path
 * that matches no route, so it gets hash routing instead: the url stays the file
 * that is actually loaded, and a reload comes back to the same view.
 *
 * A function rather than a constant: `<Route>` builds a memo the moment it is called, so
 * a tree built while the module loads has no owner to dispose it — and Solid says so
 * once per route on startup. Built on the way into `render`, it is owned like the rest.
 */
const routes = () => (
	<>
		<Route path="/" component={SessionsPage} />
		<Route path="/new" component={NewSessionPage} />
		<Route path="/settings" component={SettingsRoute} />
		<Route path="*404" component={NotFound} />
	</>
);

/** Shown instead of the app when the shell has no backend to talk to at all. */
function ServiceUnavailable(props: { message: string }) {
	return (
		<main class="flex h-full flex-col items-center justify-center gap-3 p-8" data-testid="service-unavailable">
			<h1 class="text-sm font-medium">eta</h1>
			<p class="max-w-[52ch] text-center font-mono text-[11px] leading-5 text-muted">{props.message}</p>
		</main>
	);
}

render(
	() => (
		<ThemeProvider>
			<Show when={host().error} fallback={host().kind === "desktop" ? <HashRouter>{routes()}</HashRouter> : <Router>{routes()}</Router>}>
				{(message) => <ServiceUnavailable message={message()} />}
			</Show>
			<SettingsHost />
		</ThemeProvider>
	),
	document.getElementById("root")!,
);
