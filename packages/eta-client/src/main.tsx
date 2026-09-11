import { render } from "solid-js/web";
import { HashRouter, Route, Router } from "@solidjs/router";
import "./styles/graphite.css";
import "./styles.css";
import "./i18n.ts";
import { host } from "./lib/host.ts";
import { installAppBehavior } from "./lib/app-behavior.ts";

// Right-click, drag, drop and zoom are browser behaviour until someone says
// otherwise, so this runs before the first render rather than from a component:
// the rules have to hold over content that has not mounted yet.
installAppBehavior();

// The shell and a browser tab want different chrome; CSS reads this.
document.documentElement.dataset.host = host().kind;
import { ThemeProvider } from "./app/theme.tsx";
import { SessionsPage } from "./pages/sessions-page.tsx";
import { NewSessionPage } from "./pages/new-session-page.tsx";
import { SettingsPage } from "./pages/settings-page.tsx";

function NotFound() {
	return null;
}

/**
 * The routes, in two containers. A browser tab gets the history router. The shell
 * loads this page from `views://eta/index.html`, where the pathname is a file path
 * that matches no route, so it gets hash routing instead: the url stays the file
 * that is actually loaded, and a reload comes back to the same view.
 */
const routes = (
	<>
		<Route path="/" component={SessionsPage} />
		<Route path="/new" component={NewSessionPage} />
		<Route path="/settings" component={SettingsPage} />
		<Route path="*404" component={NotFound} />
	</>
);

render(
	() => (
		<ThemeProvider>
			{host().kind === "desktop" ? <HashRouter>{routes}</HashRouter> : <Router>{routes}</Router>}
		</ThemeProvider>
	),
	document.getElementById("root")!,
);
