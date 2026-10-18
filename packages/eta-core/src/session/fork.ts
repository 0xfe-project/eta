/**
 * Fork — branch off an entry (REFACTOR.md §K4, port of eta-agent's
 * fork-policy.ts selectBranchFork, storage coupling stripped).
 *
 * A fork copies the history PREFIX: from the selected entry (position "at",
 * the default — user picks a message and forks from it) or its parent
 * (position "before") back to the root. Lane config and meta are inherited by
 * the destination and loops/tasks are dropped — but those live in the values
 * store on the server side; this module owns only the entry-chain selection.
 * There is deliberately no parentSessionId: a fork is a new session (§7).
 */
import type { Entry } from "../types/entries";
import type { EntryGraph } from "./graph";

export interface ForkOptions {
	/** Entry on the tip's ancestry to fork from. Defaults to the current tip. */
	entryId?: string;
	/** Include the selected entry (default) or stop at its parent. */
	position?: "before" | "at";
}

export interface ForkSelection {
	/** Selected entry ids, root included. */
	entryIds: ReadonlySet<string>;
	/** Where the destination's tip points: the entry itself, or its parent. */
	destinationTip: string | null;
}

/** Select the prefix of the current tip's ancestry that a fork copies. */
export function selectBranchFork(graph: EntryGraph, options: ForkOptions = {}): ForkSelection {
	const requested = options.entryId ?? graph.tipId();
	if (requested === null) throw new Error("fork: the source branch is empty");
	const position = options.position ?? "at";

	const entryIds = new Set<string>();
	let destinationTip: string | null = null;
	let found = false;
	// Walk from the tip, not from the requested entry: an entry that is not on
	// the current branch must be rejected rather than silently forked.
	let entryId: string | null = graph.tipId();
	while (entryId !== null) {
		const parentId = graph.byId(entryId)?.parentId;
		if (parentId === undefined) throw new Error(`fork: corrupt chain, missing entry ${entryId}`);
		if (entryId === requested) {
			found = true;
			destinationTip = position === "before" ? parentId : entryId;
			if (position !== "before") entryIds.add(entryId);
		} else if (found) {
			entryIds.add(entryId);
		}
		entryId = parentId;
	}
	if (!found) {
		throw new Error(`fork: entry ${requested} is not on the current branch`);
	}
	return { entryIds, destinationTip };
}

export interface ForkedChain {
	/** The copied entries, newest-first. */
	entries: Entry[];
	tipId: string | null;
}

/** Materialize a fork selection into a standalone entry chain. */
export function forkChain(graph: EntryGraph, options: ForkOptions = {}): ForkedChain {
	const { entryIds, destinationTip } = selectBranchFork(graph, options);
	const entries = graph.chain().filter((entry) => entryIds.has(entry.id));
	return { entries, tipId: destinationTip };
}
