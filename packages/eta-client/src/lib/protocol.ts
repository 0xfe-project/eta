/**
 * Client-side types for the read-only git workspace panel. These mirror
 * eta-server's /api/git endpoints; the wire frames and ops live in @eta/core.
 */

/** Mirrors eta-server/src/git.ts; the workspace panel is a read-only viewer. */
export interface GitFile {
	path: string;
	origPath?: string;
	status: string;
	added?: number;
	deleted?: number;
	partial?: boolean;
}

export interface GitStatus {
	notGit: boolean;
	branch: string | null;
	groups: {
		staged: GitFile[];
		changes: GitFile[];
		untracked: GitFile[];
		conflicted: GitFile[];
	};
}

export type GitDiffKind = "index" | "worktree" | "untracked";

export interface GitDiff {
	path: string;
	kind: GitDiffKind;
	text: string;
	truncated: boolean;
}
