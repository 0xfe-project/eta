/**
 * EntryGraph — the pure in-memory entry DAG (REFACTOR.md §K4).
 *
 * Single-parent lineage per entry; a merge entry carries a second parent and
 * its chain joins the branch path at the common ancestor (port of
 * merge-splice.ts). Storage-agnostic: a StorageService replays entries into
 * this graph to rebuild state, and persists appends from it.
 */
import type { Entry, NewEntry } from "../types/entries.ts";

let counter = 0;
function nextId(): string {
	counter += 1;
	return `entry-${counter.toString(36)}-${Date.now().toString(36)}`;
}

/** The slice of an entry the graph algorithm needs; every Entry qualifies. */
export interface GraphNode {
	id: string;
	parentId: string | null;
	type: string;
	mergedParentId?: string | undefined;
}

/**
 * Splice merged chains into a newest-first branch path, in place. Each merge
 * entry's second-parent chain is inserted right after it, stopping at the
 * first entry already on the path (the common ancestor). Port of
 * eta-agent's merge-splice.ts, storage coupling stripped.
 */
export function spliceMergedChain<T extends GraphNode>(
	pathNewestFirst: T[],
	loadById: (id: string) => T | undefined,
): void {
	const onPath = new Set(pathNewestFirst.map((entry) => entry.id));
	for (let i = 0; i < pathNewestFirst.length; i += 1) {
		const candidate = pathNewestFirst[i]!;
		if (candidate.type !== "merge" || candidate.mergedParentId === undefined) continue;
		const merged: T[] = [];
		const seen = new Set<string>(onPath);
		let node = loadById(candidate.mergedParentId);
		while (node !== undefined && !seen.has(node.id)) {
			seen.add(node.id);
			merged.push(node);
			if (node.parentId === null) break;
			node = loadById(node.parentId);
		}
		for (const [offset, extra] of merged.entries()) {
			pathNewestFirst.splice(i + 1 + offset, 0, extra);
			onPath.add(extra.id);
		}
		i += merged.length;
	}
}

export class EntryGraph {
	private readonly entries = new Map<string, Entry>();
	private tipEntryId: string | null = null;
	private seq = 0;

	/** Append an entry on the current tip (or on `parentId` when given). */
	append<T extends Entry>(entry: NewEntry<T>): T {
		const full = {
			...entry,
			id: (entry as { id?: string }).id ?? nextId(),
			parentId: (entry as { parentId?: string | null }).parentId ?? this.tipEntryId,
			seq: ++this.seq,
			timestamp: Date.now(),
		} as unknown as T;
		const parentId = full.parentId;
		if (parentId !== null && !this.entries.has(parentId)) {
			throw new Error(`append: unknown parent ${parentId}`);
		}
		this.entries.set(full.id, full);
		this.tipEntryId = full.id;
		return full;
	}

	byId(id: string): Entry | undefined {
		return this.entries.get(id);
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	tip(): Entry | undefined {
		return this.tipEntryId === null ? undefined : this.entries.get(this.tipEntryId);
	}

	tipId(): string | null {
		return this.tipEntryId;
	}

	setTip(id: string | null): void {
		if (id !== null && !this.entries.has(id)) throw new Error(`setTip: unknown entry ${id}`);
		this.tipEntryId = id;
	}

	/** Single-parent chain from an entry (or the tip) up to the root. */
	chain(entryId: string | null = this.tipEntryId): Entry[] {
		const out: Entry[] = [];
		let id = entryId;
		const seen = new Set<string>();
		while (id !== null) {
			const entry = this.entries.get(id);
			if (entry === undefined || seen.has(id)) break;
			seen.add(id);
			out.push(entry);
			id = entry.parentId;
		}
		return out;
	}

	/** Branch path newest-first with merged chains spliced in. */
	path(): Entry[] {
		const path = this.chain();
		spliceMergedChain(path, (id) => this.entries.get(id));
		return path;
	}

	/** Branch path oldest-first with merged chains spliced in. */
	pathOldestFirst(): Entry[] {
		return this.path().reverse();
	}

	/** Whether `ancestorId` is on the single-parent chain above `entryId`. */
	isAncestorOf(ancestorId: string, entryId: string | null = this.tipEntryId): boolean {
		return this.chain(entryId).some((e) => e.id === ancestorId);
	}

	size(): number {
		return this.entries.size;
	}
}
