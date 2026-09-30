/**
 * Forking a session on disk (REFACTOR.md §5b, task S12).
 *
 * `@eta/core` already owns the rule — which entries a fork copies, given an entry on
 * the current branch and `position: "at" | "before"` — and this is the storage half:
 * take that chain and write it into a *new* session's journal.
 *
 * Two things are copied and one is not, and the "not" is the point:
 *
 * - **entries**: copied verbatim, ids and parents included, so the destination's
 *   transcript and branch shape are the source's prefix. Storage assigns fresh
 *   sequence numbers and commit timestamps (a fork is a new journal; entry ids are
 *   what identity means here, and a message's own `timestamp` rides inside it).
 * - **lane config**: the `eta.session.config` value, so the fork starts on the same
 *   model, thinking level and tools the source was left on.
 * - **not tasks, and not the model's KV.** A task list is a *plan for the work in
 *   that session*, and a fork is a new piece of work: inheriting a half-finished
 *   list would make the fork claim progress it never made. Usage rows are not copied
 *   either — the tokens were spent in the source, and a fork that inherited them
 *   would report a bill it never ran up.
 */

import type { Entry, ForkedChain, NewEntry, StorageService, StorageWrite } from "@eta/core";
import { SESSION_TIP, setValue } from "@eta/core";
import { SESSION_CONFIG } from "@eta/harness";

/** The writes that turn an empty session into a copy of a forked chain. */
export async function forkWrites(source: StorageService, chain: ForkedChain): Promise<StorageWrite[]> {
	const config = (await source.getValue(SESSION_CONFIG))?.value;
	return [
		// Oldest first: a batch is applied in order, and the copy should read as the
		// source's history rather than as a reversed one.
		...[...chain.entries].reverse().map((entry): StorageWrite => ({ kind: "entry", entry: copyOf(entry) })),
		...(config === undefined ? [] : [setValue(SESSION_CONFIG, config)]),
		// The tip is stated rather than inferred. Appending would leave it on the newest
		// copied entry, which is wrong for `position: "before"` — and stating it is what
		// makes the two positions the same code path.
		setValue(SESSION_TIP, chain.tipId),
	];
}

/**
 * The same entry, minus the fields storage assigns (a new journal numbers them its own
 * way). `NewEntry` is a distributive conditional over the entry union, so the cast is
 * how that is said out loud; the fields really are gone.
 */
function copyOf(entry: Entry): NewEntry {
	const { seq: _seq, timestamp: _timestamp, ...rest } = entry;
	return rest as NewEntry;
}
