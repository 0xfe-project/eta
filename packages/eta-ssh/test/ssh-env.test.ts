/**
 * The SSH environment against the harness's own ExecutionEnv contract.
 *
 * Run through `LocalTransport`, which speaks the environment's protocol (its `sh`
 * scripts and their exit codes) on this machine. That covers everything the
 * environment itself decides — path resolution, error codes, bounded reads, the
 * shell's three endings — and deliberately *not* the SSH hop: trust, retries and
 * connection reuse are `SshCommandTransport`'s, tested in `transport.test.ts`, and
 * the real target check (when `ETA_SSH_TARGET` is set) covers the join.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envContract } from "@eta/execution/testing";
import { describe, expect, it } from "vitest";
import { SshEnvironment } from "../src/env";
import { LocalTransport } from "../src/local-transport";

const roots: string[] = [];

async function home(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "eta-ssh-home-"));
	roots.push(root);
	return root;
}

envContract("SshEnvironment over LocalTransport", async () => {
	const root = await home();
	const transport = new LocalTransport({ home: root, tempDir: root });
	return {
		env: new SshEnvironment({ transport }),
		shell: {
			run: (command, options) => new SshEnvironment({ transport }).exec(command, options),
			echo: (text: string) => `printf '%s\\n' ${JSON.stringify(text).replace(/"/g, "'")}`,
			fail: (code: number, text: string) =>
				`printf '%s' ${JSON.stringify(text).replace(/"/g, "'")} >&2; exit ${code}`,
		},
		dispose: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
});

describe("what the ssh environment decides on its own", () => {
	it("resolves ~ to the remote home and keeps the protocol's escape hatches closed", async () => {
		const root = await home();
		const env = new SshEnvironment({ transport: new LocalTransport({ home: root, tempDir: root }) });
		await env.writeFile("a.txt", "hello");
		expect((await env.readTextFile("~/a.txt")).ok && (await env.readTextFile("~/a.txt"))).toBeTruthy();
		// A quoted path is not a shell command: a name with a space or a quote in it
		// is a name, not an injection.
		const name = "odd ' name; echo pwned.txt";
		await env.writeFile(name, "safe");
		const read = await env.readTextFile(name);
		expect(read.ok && read.value).toBe("safe");
		const listing = await env.listDir(".");
		expect(listing.ok && listing.value.map((entry) => entry.name).sort()).toEqual(["a.txt", name].sort());
		await rm(root, { recursive: true, force: true });
	});

	it("streams a long command's output while it runs, and cuts it to the limits", async () => {
		const root = await home();
		const env = new SshEnvironment({ transport: new LocalTransport({ home: root, tempDir: root }) });
		const updates: string[] = [];
		const result = await env.exec('for i in 1 2 3 4 5; do echo "line $i"; done', {
			limits: { maxBytes: 2048, maxLines: 3, retain: "tail" },
			onUpdate: (update) => updates.push(update.kind),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.exitCode).toBe(0);
		// The tail is kept, the totals are the whole truth, and the live view saw it.
		expect(result.value.output).toContain("line 5");
		expect(result.value.output).not.toContain("line 1");
		expect(result.value.truncation?.truncated).toBe(true);
		expect(updates.length).toBeGreaterThan(0);
		await rm(root, { recursive: true, force: true });
	});

	it("interleaves the two streams by arrival order, without a shell merging them", async () => {
		const root = await home();
		const env = new SshEnvironment({ transport: new LocalTransport({ home: root, tempDir: root }) });
		// `output` is the merged view, and it exists when limits were given (without
		// them the caller asked for the whole truth stream by stream).
		const limits = { maxBytes: 4096, maxLines: 50, retain: "tail" as const };
		const spaced = await env.exec("echo one; sleep 0.05; echo err >&2; sleep 0.05; echo two", { limits });
		expect(spaced.ok).toBe(true);
		if (!spaced.ok) return;
		// Arrival order, which is the order the machine produced them — the streams
		// were never merged by a shell.
		expect(spaced.value.output).toBe("one\nerr\ntwo\n");
		expect(spaced.value.stdout.trim()).toBe("one\ntwo");
		expect(spaced.value.stderr.trim()).toBe("err");

		// Without a pause the chunks come as the pipe delivers them, so the merged
		// view holds the same lines (order between the two streams is best-effort,
		// exactly as it is for a local command).
		const burst = await env.exec("echo one; echo err >&2; echo two", { limits });
		expect(burst.ok && burst.value.output?.split("\n").filter(Boolean).sort()).toEqual(["err", "one", "two"]);
		await rm(root, { recursive: true, force: true });
	});
});
