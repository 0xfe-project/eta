import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiff, gitStatus } from "../src/git.ts";
import { startServer, type EtaServer } from "../src/server.ts";
import type { ServerMessage } from "../src/protocol.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync(
		"git",
		["-c", "user.email=eta@test", "-c", "user.name=eta", "-c", "commit.gpgsign=false", ...args],
		{ cwd, stdio: "ignore" },
	);
}

/** One checkout with all three groups populated: index edit, worktree edit, untracked. */
function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "eta-git-"));
	git(dir, "init", "-q");
	writeFileSync(join(dir, "keep.txt"), "a\nb\nc\n");
	writeFileSync(join(dir, "staged.txt"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "init");
	writeFileSync(join(dir, "keep.txt"), "a\nB\nc\nd\n");
	writeFileSync(join(dir, "staged.txt"), "one\ntwo\n");
	git(dir, "add", "staged.txt");
	writeFileSync(join(dir, "loose.txt"), "x\ny\n");
	return dir;
}

describe("git status", () => {
	it("splits index, worktree and untracked changes with line counts", async () => {
		const status = await gitStatus(fixture());
		expect(status.notGit).toBe(false);
		expect(status.branch).toBeTypeOf("string");
		expect(status.groups.staged).toEqual([
			{ path: "staged.txt", status: "M", added: 1, deleted: 0 },
		]);
		expect(status.groups.changes).toEqual([
			{ path: "keep.txt", status: "M", added: 2, deleted: 1 },
		]);
		expect(status.groups.untracked).toEqual([
			{ path: "loose.txt", status: "??", added: 2 },
		]);
	});

	it("reports a plain directory as not a repository", async () => {
		const status = await gitStatus(mkdtempSync(join(tmpdir(), "eta-nogit-")));
		expect(status.notGit).toBe(true);
		expect(status.branch).toBeNull();
		expect(status.groups.untracked).toEqual([]);
	});

	it("follows a rename into the staged group with its origin path", async () => {
		const dir = fixture();
		git(dir, "mv", "keep.txt", "renamed.txt");
		const status = await gitStatus(dir);
		const renamed = status.groups.staged.find((entry) => entry.path === "renamed.txt");
		expect(renamed?.status).toBe("R");
		expect(renamed?.origPath).toBe("keep.txt");
	});
});

describe("git diff", () => {
	it("returns the worktree hunk, the index hunk, and a synthesised untracked hunk", async () => {
		const dir = fixture();
		const worktree = await gitDiff(dir, "keep.txt", "worktree");
		expect(worktree?.text).toContain("@@");
		expect(worktree?.text).toContain("+B");
		expect(worktree?.truncated).toBe(false);
		const index = await gitDiff(dir, "staged.txt", "index");
		expect(index?.text).toContain("+two");
		const untracked = await gitDiff(dir, "loose.txt", "untracked");
		expect(untracked?.text.startsWith("--- /dev/null")).toBe(true);
		expect(untracked?.text).toContain("+x");
	});

	it("refuses escaping paths and missing files", async () => {
		const dir = fixture();
		expect(await gitDiff(dir, "../outside.txt", "worktree")).toBeUndefined();
		expect(await gitDiff(dir, "/etc/hosts", "worktree")).toBeUndefined();
		expect(await gitDiff(dir, "does-not-exist.txt", "untracked")).toBeUndefined();
	});
});

async function withRepoServer(repo: string, run: (port: number) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "eta-git-server-"));
	const server: EtaServer = await startServer({
		port: 0,
		cwd,
		webDist: join(cwd, "no-dist"),
		configPath: join(cwd, "no-config.json"),
		dataDir: join(cwd, "sessions"),
	});
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
	const created = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("session not created")), 5000);
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			if ("type" in message && message.type === "created") {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	socket.addEventListener("open", () => {
		socket.send(JSON.stringify({ op: "session.create", name: "g1", personaId: "Thinker", cwd: repo }));
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("ws connect failed")));
	});
	try {
		await created;
		await run(server.port);
	} finally {
		socket.close();
		server.close();
	}
}

describe("git http surface", () => {
	it("serves status and diff for a session cwd", async () => {
		await withRepoServer(fixture(), async (port) => {
			const status = (await (await fetch(`http://127.0.0.1:${port}/api/git/status?session=g1`)).json()) as {
				notGit: boolean;
				groups: { changes: { path: string; added: number }[] };
			};
			expect(status.notGit).toBe(false);
			expect(status.groups.changes.map((entry) => `${entry.path}+${entry.added}`)).toEqual(["keep.txt+2"]);
			const diff = (await (
				await fetch(`http://127.0.0.1:${port}/api/git/diff?session=g1&path=keep.txt`)
			).json()) as { text: string };
			expect(diff.text).toContain("+B");
			const unknown = await fetch(`http://127.0.0.1:${port}/api/git/status?session=nope`);
			expect(((await unknown.json()) as { notGit: boolean }).notGit).toBe(true);
		});
	});
});
