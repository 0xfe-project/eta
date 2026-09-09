import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Route, Router, Switch } from "wouter";
import "./styles.css";
import "./i18n.ts";
import { ThemeProvider } from "./app/theme.tsx";
import { SessionsPage } from "./pages/sessions-page.tsx";
import { NewSessionPage } from "./pages/new-session-page.tsx";
import { SettingsPage } from "./pages/settings-page.tsx";
import { InboxPage } from "./pages/inbox-page.tsx";

function NotFound() {
	return null;
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ThemeProvider>
			<Router>
				<Switch>
					<Route path="/" component={SessionsPage} />
					<Route path="/new" component={NewSessionPage} />
					<Route path="/settings" component={SettingsPage} />
					<Route path="/inbox" component={InboxPage} />
					<Route component={NotFound} />
				</Switch>
			</Router>
		</ThemeProvider>
	</StrictMode>,
);
