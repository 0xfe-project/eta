import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import "./styles/graphite.css";
import "./styles.css";
import "./i18n.ts";
import { ThemeProvider } from "./app/theme.tsx";
import { SessionsPage } from "./pages/sessions-page.tsx";
import { NewSessionPage } from "./pages/new-session-page.tsx";
import { SettingsPage } from "./pages/settings-page.tsx";

function NotFound() {
	return null;
}

render(
	() => (
		<ThemeProvider>
			<Router>
				<Route path="/" component={SessionsPage} />
				<Route path="/new" component={NewSessionPage} />
				<Route path="/settings" component={SettingsPage} />
				<Route path="*404" component={NotFound} />
			</Router>
		</ThemeProvider>
	),
	document.getElementById("root")!,
);
