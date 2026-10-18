/**
 * Reading a checkout: what the git CLI says about a working directory.
 *
 * Ported from eta-agent's `git.ts`, unchanged in behaviour and narrower in scope: this file only
 * *reads*. Every call spawns `git` inside the given directory with a deadline and a byte cap, and
 * nothing here mutates the checkout — no `git add`, no `git checkout`. The panel is a view.
 *
 * Three details are worth naming because they are the difference between a view and a hang:
 *
 * - **Every call is capped and timed.** A repository with a million untracked files, or a git that
 *   waits on a lock, must produce a truncated answer rather than a panel that never draws.
 * - **`--no-optional-locks` and `core.quotepath=false`.** The first is what keeps a read-only view
 *   from writing `.git/index` behind the user's back (git refreshes the index opportunistically),
 *   the second is what makes a non-ASCII path come back as itself instead of as `\303\251`.
 * - **Paths cross as relative to the working directory**, and a path that could escape it (`..`,
 *   absolute, NUL) is refused rather than normalised: this is a view of one checkout, and the
 *   caller is a wire client.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface GitFile {
	path: string;
	origPath?: string;
	/** One porcelain letter: A/M/D/R/C/T, or `??` for untracked. */
	status: string;
	added?: number;
	deleted?: number;
	/** The counts came from a head-line scan of an oversized untracked file. */
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

const OUTPUT_CAP = 400_000;
const STATUS_CAP = 4_000_000;
const SNIFF_CAP = 200_000;
const DEADLINE_MS = 8_000;

interface GitRun {
	ok: boolean;
	out: string;
	truncated: boolean;
}

/** Read a stream up to a byte cap, saying whether it was cut. */
async function readCapped(
	stream: ReadableStream<Uint8Array>,
	cap: number,
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
	const kept: Uint8Array[] = [];
	let keptBytes = 0;
	let truncated = false;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		const value = chunk.value;
		if (value === undefined) continue;
		if (truncated) continue;
		if (keptBytes + value.byteLength > cap) {
			truncated = true;
			continue;
		}
		kept.push(value);
		keptBytes += value.byteLength;
	}
	const merged = new Uint8Array(keptBytes);
	let offset = 0;
	for (const chunk of kept) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(merged), truncated };
}

async function runGit(cwd: string, args: readonly string[], cap = OUTPUT_CAP): Promise<GitRun> {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.quotepath=false", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			// Resolved against the live PATH: a machine without git fails here (and is reported as
			// "not a checkout"), rather than falling back to a launch-time snapshot of the env.
			env: process.env,
		});
	} catch {
		return { ok: false, out: "", truncated: false };
	}
	const reading = readCapped(child.stdout as ReadableStream<Uint8Array>, cap);
	const timer = setTimeout(() => {
		try {
			child.kill();
		} catch {
			/* already exited */
		}
	}, DEADLINE_MS);
	let code = 1;
	try {
		code = await child.exited;
	} finally {
		clearTimeout(timer);
	}
	const read = await reading;
	return { ok: code === 0, out: read.text, truncated: read.truncated };
}

/** `<added>\t<deleted>\t<path>` records; a rename spreads over three NUL chunks. */
function parseNumstat(text: string): Map<string, { added: number; deleted: number }> {
	const counts = new Map<string, { added: number; deleted: number }>();
	const tokens = text.split("\0");
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		index += 1;
		if (token.length === 0) continue;
		const fields = token.split("\t");
		if (fields.length < 2) continue;
		const added = Number(fields[0]);
		const deleted = Number(fields[1]);
		const entry = { added: Number.isFinite(added) ? added : 0, deleted: Number.isFinite(deleted) ? deleted : 0 };
		if (fields.length >= 3) {
			counts.set(fields.slice(2).join("\t"), entry);
			continue;
		}
		const renamedTo = tokens[index + 1] ?? tokens[index];
		if (renamedTo !== undefined) {
			counts.set(renamedTo, entry);
			index += 2;
		}
	}
	return counts;
}

const EMPTY_GROUPS = (): GitStatus["groups"] => ({ staged: [], changes: [], untracked: [], conflicted: [] });

/** What the answer is when the directory is not a checkout (or git is not installed). */
export function notGitStatus(): GitStatus {
	return { notGit: true, branch: null, groups: EMPTY_GROUPS() };
}

function lineScan(text: string): { added: number; partial: boolean } {
	if (text.length === 0) return { added: 0, partial: false };
	const clipped = text.length > SNIFF_CAP ? text.slice(0, SNIFF_CAP) : text;
	if (clipped.includes("\u0000")) return { added: 0, partial: true };
	const lines = clipped.split("\n").length - (clipped.endsWith("\n") ? 1 : 0);
	return { added: lines, partial: text.length > SNIFF_CAP };
}

async function untrackedCounts(cwd: string, path: string): Promise<{ added: number; partial: boolean } | undefined> {
	try {
		return lineScan(await readFile(join(cwd, path), "utf8"));
	} catch {
		return undefined;
	}
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
	const status = await runGit(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], STATUS_CAP);
	if (!status.ok) return notGitStatus();
	const branch = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const name = branch.out.trim();
	const groups = EMPTY_GROUPS();
	const stagedCounts = parseNumstat((await runGit(cwd, ["diff", "--cached", "--numstat", "-z"])).out);
	const worktreeCounts = parseNumstat((await runGit(cwd, ["diff", "--numstat", "-z"])).out);
	const records = status.out.split("\0");
	const untrackedScans = new Map<string, { added: number; partial: boolean }>();

	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? "";
		if (record.length === 0 || record.startsWith("# ") || record.startsWith("!")) continue;
		const kind = record[0];
		const fields = record.slice(2).split(" ");
		if (kind === "?") {
			const path = record.slice(2);
			untrackedScans.set(path, (await untrackedCounts(cwd, path)) ?? { added: 0, partial: false });
			continue;
		}
		if (kind !== "1" && kind !== "2" && kind !== "u") continue;
		const fixed = kind === "1" ? 7 : kind === "2" ? 8 : 10;
		const path = fields.slice(fixed).join(" ");
		if (path.length === 0) continue;
		if (kind === "u") {
			groups.conflicted.push({ path, status: (fields[0] ?? "UU").slice(0, 2) });
			continue;
		}
		const pair = (fields[0] ?? "..").padEnd(2, ".");
		if (kind === "2") {
			const origPath = records[index + 1];
			if (origPath !== undefined && origPath.length > 0) {
				index += 1;
				groups.staged.push({ path, origPath, status: "R", ...stagedCounts.get(path) });
				continue;
			}
		}
		const [indexed, inWorktree] = [pair[0] ?? ".", pair[1] ?? "."];
		if (indexed !== "." && indexed !== "?") groups.staged.push({ path, status: indexed, ...stagedCounts.get(path) });
		if (inWorktree !== "." && inWorktree !== "?") {
			groups.changes.push({ path, status: inWorktree, ...worktreeCounts.get(path) });
		}
	}

	for (const [path, scan] of untrackedScans) {
		groups.untracked.push({ path, status: "??", added: scan.added, ...(scan.partial ? { partial: true } : {}) });
	}
	const byPath = (left: GitFile, right: GitFile): number =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
	for (const list of Object.values(groups)) list.sort(byPath);
	return {
		notGit: false,
		branch: name.length === 0 || name === "HEAD" ? null : name.slice(0, 60),
		groups,
	};
}

/** Whether a path may be read: relative, no `..`, no NUL, not empty. */
export function isSafeRelativePath(path: string): boolean {
	return path.length > 0 && !path.startsWith("/") && !path.includes("\0") && !path.split("/").includes("..");
}

/** Unified diff of one path; an untracked file is synthesised so the renderer stays uniform. */
export async function gitDiff(cwd: string, path: string, kind: GitDiffKind): Promise<GitDiff | undefined> {
	if (!isSafeRelativePath(path)) return undefined;
	if (kind === "untracked") {
		let body: string;
		try {
			body = await readFile(join(cwd, path), "utf8");
		} catch {
			return undefined;
		}
		// Binary first: a NUL byte makes `lineScan` call the file partial (it cannot count lines it
		// cannot read), so checking size first reports every binary file as "too large" — which is
		// both wrong and unhelpful, since the size was never the problem.
		if (body.includes("\u0000")) return { path, kind, text: "[binary file]", truncated: false };
		const scan = lineScan(body);
		if (scan.partial) return { path, kind, text: "[file too large to preview]", truncated: true };
		const lines = body.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		const text = [
			`--- /dev/null`,
			`+++ b/${path}`,
			`@@ -0,0 +1,${lines.length} @@`,
			...lines.map((line) => `+${line}`),
		].join("\n");
		return { path, kind, text, truncated: false };
	}
	const run = await runGit(cwd, ["diff", ...(kind === "index" ? ["--cached"] : []), "--", path]);
	if (!run.ok) return undefined;
	return { path, kind, text: run.out, truncated: run.truncated };
}
