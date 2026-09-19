import { createSignal } from "solid-js";
import { etaStore } from "./eta-store.ts";
import { parseRemoteSession, remoteSessionName } from "./remotes.ts";

/**
 * The fork dialog is raised from two places — `/fork` in the composer, and the button on a
 * message — and is rendered by neither, so the open flag is a module signal rather than page
 * state. Same arrangement as the btw dialog.
 */
export const [forkDialogOpen, setForkDialogOpen] = createSignal(false);
/** The message whose button opened the dialog: pre-selected, so Enter alone is the whole click. */
export const [forkPicked, setForkPicked] = createSignal<string | undefined>(undefined);

/** Open the chooser, optionally with one message already highlighted. */
export function openForkDialog(at?: string): void {
	setForkPicked(at);
	setForkDialogOpen(true);
}

/**
 * Branch a session at one of its own messages, then move to what that makes.
 *
 * The name is chosen here, in the same shape the welcome screen uses, and the move waits for
 * the server's `created` frame instead of assuming the fork happened: a refused fork — an entry
 * id whose session has since been closed, a journal that would not take the copy — should leave
 * the person reading the same transcript they were reading, with the reason on the error strip.
 */
export function forkFromMessage(source: string, entryId: string): void {
	console.log("[fork] forkFromMessage called", { source, entryId });
	const store = etaStore();
	const name = `eta-${Date.now().toString(36)}`;
	// A session on another machine forks on that machine, where its journal lives; the answer
	// comes back carrying the same `remote:` prefix the request was addressed with.
	const remote = parseRemoteSession(source);
	const expected = remote === undefined ? name : remoteSessionName(remote.connectionId, name);
	const stop = store.subscribe((frame) => {
		if (frame === undefined || !("type" in frame)) return;
		if (frame.type === "created" && frame.name === expected) {
			stop();
			store.send({ op: "focus", session: frame.name });
		} else if (frame.type === "error") {
			stop();
		}
	});
	const msg = { op: "session.fork" as const, from: source, entryId, name };
	console.log("[fork] sending", msg, "connected:", store.snapshot().connected);
	store.send(msg);
}
