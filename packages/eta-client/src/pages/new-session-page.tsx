import { useNavigate, useSearchParams } from "@solidjs/router";
import { useAppI18n } from "../i18n.ts";
import { useEta } from "../lib/eta-store.ts";
import { openSettings } from "../lib/settings.ts";
import { MainHeader, SessionChrome } from "../app/session-chrome.tsx";
import { Welcome } from "../features/sessions/welcome.tsx";

/**
 * `/new` is the welcome screen with a way back, wearing the same chrome as the session it
 * steps in front of: the sidebar, the right rail, the header strip all stay put, because
 * ⌘N should change one thing — what is in the middle. The route exists because a transcript
 * cannot be a blank slate and a conversation at once.
 *
 * The folder worth starting in is handed to `Welcome`: the group header's 「+」 (`?cwd=`) or
 * the folder of the session being left, in that order of how explicitly it was asked for.
 */
export function NewSessionPage() {
	const i18n = useAppI18n();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const state = useEta();
	/** Read at prop time, not once in this body: the group header's 「+」 can retarget the folder
	 * while this page is already open, and `Welcome` listens for exactly that. */
	const handedCwd = () =>
		[
			typeof params.cwd === "string" ? params.cwd : "",
			state.sessions.find((session) => session.cwd !== undefined)?.cwd ?? "",
		]
			.find((value) => value.trim().length > 0)
			?.trim() ?? "";
	const back = () => {
		void navigate("/");
	};

	return (
		<SessionChrome
			onSelected={back}
			main={() => (
				<div class="flex min-h-0 flex-1 flex-col">
					<MainHeader
						title={i18n.t("new.title")}
						trailing={
							<button
								data-testid="new-close"
								title={i18n.t("new.close")}
								onClick={back}
								class="border border-border px-2.5 py-0.5 text-sm leading-none text-muted hover:bg-foreground hover:text-background"
							>
								×
							</button>
						}
					/>
					<Welcome initialCwd={handedCwd()} onCreated={back} onNavigateSettings={openSettings} />
				</div>
			)}
		/>
	);
}
