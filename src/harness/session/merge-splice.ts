/**
 * Branch scans return a single-parent path; a merge entry carries a second
 * parent whose chain joins the history at the merge. Storage backends run
 * this over their newest-first path before ordering, filtering, and paging so
 * every backend reads a merged branch identically. The merged chain stops at
 * the first entry already on the path (the common ancestor).
 */

export interface MergeSplittable {
	id: string;
	parentId: string | null;
	type: string;
	mergedParentId?: string | undefined;
}

export function spliceMergedChain<T extends MergeSplittable>(
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
