/**
 * What the queue chips do beyond dropping an entry.
 *
 * Both verbs start the same way — take the entry out of the lane queue — and both
 * then wait for the answer before touching anything the user can see. A run drains
 * its queue at tool boundaries, so "the chip disappeared" is evidence of nothing:
 * the `queueAck` frame saying we won is. Acting without it is how one message gets
 * sent twice, once from the button and once by the run that got there first.
 *
 * `steerQueued` reuses the ⌘↵ path (`prompt` with `mode:"steer"`) rather than growing
 * the wire a third time for the same verb. `pullBackQueued` hands the text to the
 * composer through the sink at the bottom of this file, because the composer owns
 * its input and this module is not allowed to reach into a component.
 */
import type { QueueAckOutcome } from "@eta/core";
import { etaStore } from "./eta-store.ts";

/** `no-ack`: the answer never came (a server without the frame, a dropped message).
 * Treated as "did not win" — every action here is one the user can simply repeat,
 * whereas a duplicated send is not something they can un-see. */
export type CancelAnswer = QueueAckOutcome | "no-ack";

export interface QueuedItem {
	entryId: string;
	kind: string;
	text: string;
	images?: { mime: string; dataBase64: string }[];
}

/** Long enough for a loopback round trip, short enough that a dead server reads as a
 * dead server rather than as a UI that is still thinking. */
const ACK_TIMEOUT_MS = 1_000;

/** One waiter per entry: the ack names the entry, not whoever asked. */
const waiters = new Map<string, (answer: CancelAnswer) => void>();

if (typeof window !== "undefined") {
	window.addEventListener("eta:queue-ack", (event) => {
		const detail = (event as CustomEvent<{ entryId: string; outcome: QueueAckOutcome }>).detail;
		const settle = waiters.get(detail.entryId);
		if (settle === undefined) return;
		waiters.delete(detail.entryId);
		settle(detail.outcome);
	});
}

/** Ask the lane to drop one queued entry, and say whether it still had it. */
export function cancelQueued(session: string, entryId: string): Promise<CancelAnswer> {
	const store = etaStore();
	return new Promise((resolve) => {
		const settle = (answer: CancelAnswer) => {
			clearTimeout(timer);
			waiters.delete(entryId);
			resolve(answer);
		};
		const timer = setTimeout(() => settle("no-ack"), ACK_TIMEOUT_MS);
		waiters.set(entryId, settle);
		store.send({ op: "queueRemove", session, entryId });
	});
}

/** Send it into the turn that is already running. */
export async function steerQueued(session: string, item: QueuedItem): Promise<void> {
	if (await cancelQueued(session, item.entryId) !== "cancelled") return;
	etaStore().send({ op: "prompt", session, text: item.text, mode: "steer" });
}

/** Put it back in the composer, for editing rather than for sending. */
export async function pullBackQueued(session: string, item: QueuedItem): Promise<void> {
	if (await cancelQueued(session, item.entryId) !== "cancelled") return;
	returnToDraft({ text: item.text, ...(item.images === undefined ? {} : { images: item.images }) });
}

/**
 * The draft handoff.
 *
 * A composer registers itself while it is mounted and the chip calls
 * `returnToDraft`, so the text lands in the box on screen. The obvious shape — a
 * shared signal the composer picks up — is wrong here: more than one composer can be
 * mounted at once (the empty sessions page shows a welcome one), and a "read and
 * clear" signal gives the text to whichever of them reacts first, which is a race
 * the user can see and cannot explain. Registering also does the right thing when
 * nothing is mounted: nothing happens, instead of parking text for whoever is next.
 *
 * The composer puts the pulled text *above* the draft already there, blank line
 * between: pulling back must never swallow half a sentence, and pulling two in a row
 * has to land in an order you can predict (newest on top).
 */
type DraftSink = (draft: { text: string; images?: { mime: string; dataBase64: string }[] }) => void;

/** Registration order, oldest first. A stack rather than "remember the previous one
 * and restore it on unmount": unmount order is not the reverse of mount order (a
 * page can drop the welcome composer while the real one is already mounted), and the
 * restore-the-previous version handed the text back to a component that had already
 * gone away — which is what the queue chip then appeared to ignore.
 */
const sinks: DraftSink[] = [];

/** Receive pulled-back entries until the returned function runs. The most recently
 * mounted composer wins, because that is the one the user is looking at. */
export function registerDraftSink(receive: DraftSink): () => void {
	sinks.push(receive);
	return () => {
		const at = sinks.indexOf(receive);
		if (at !== -1) sinks.splice(at, 1);
	};
}

/** False when nothing is listening. The entry is cancelled either way, so a caller
 * that cares can say so; the text is not kept anywhere for later. */
export function returnToDraft(draft: { text: string; images?: { mime: string; dataBase64: string }[] }): boolean {
	const target = sinks.at(-1);
	if (target === undefined) return false;
	target(draft);
	return true;
}
