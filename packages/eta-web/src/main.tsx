import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Route, Router, Switch } from "wouter";
import "./styles/picot/design-system.css";
import "./styles/picot/message-renderer.css";
import "./styles/picot/markdown.css";
import "./styles/picot/tool-card.css";
import "./styles/picot/composer.css";
import "./styles/picot/messages.css";
import "./styles/picot/sidebar.css";
import "./styles/picot/at-file-mention.css";
import "./styles/picot/composer-slash-menu.css";
import "./styles/picot/queued-messages.css";
import "./styles/picot/dialog.css";
import "./styles/picot/command-palette.css";
import "./styles/picot/turn-file-chips.css";
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

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ThemeProvider>
			<Router>
				<Switch>
					<Route path="/" component={SessionsPage} />
					<Route path="/new" component={NewSessionPage} />
					<Route path="/settings" component={SettingsPage} />
					<Route component={NotFound} />
				</Switch>
			</Router>
		</ThemeProvider>
	</StrictMode>,
);
