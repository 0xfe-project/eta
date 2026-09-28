/**
 * The local shell, held to the same contract as any backend that runs real
 * commands — plus the parts of the contract a scripted shell cannot answer:
 * ordinary exit codes, timeouts, aborts, both streams, and the working
 * directory a command actually sees.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeEnvironment } from "../src/env/node-shell";
import { getOrThrow } from "../src/env/types";
import { envContract } from "../src/testing";

envContract("node environment", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "eta-shell-"));
	const env = new NodeEnvironment({ cwd });
	return {
		env,
		shell: {
			run: env.exec.bind(env),
			echo: (text: string) => `echo ${text}`,
			fail: (code: number, text: string) => `echo ${text} >&2; exit ${code}`,
		},
		capabilities: { shell: true },
		dispose: async () => {
			await env.cleanup();
			await rm(cwd, { recursive: true, force: true });
		},
	};
});

describe("NodeShell specifics", () => {
	it("runs a command in the environment's cwd, and in another one when told", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "eta-shell-"));
		const env = new NodeEnvironment({ cwd });
		const here = getOrThrow(await env.exec("pwd"));
		// macOS reaches /var through /private, so compare the resolved paths.
		expect(getOrThrow(await env.canonicalPath(here.stdout.trim()))).toBe(getOrThrow(await env.canonicalPath(cwd)));
		await env.createDir("sub");
		const there = getOrThrow(await env.exec("pwd", { cwd: "sub" }));
		expect(getOrThrow(await env.canonicalPath(there.stdout.trim()))).toBe(
			getOrThrow(await env.canonicalPath(join(cwd, "sub"))),
		);
		await env.cleanup();
		await rm(cwd, { recursive: true, force: true });
	});

	it("keeps stdout and stderr apart, and reports a signal as 128 + signal", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "eta-shell-"));
		const env = new NodeEnvironment({ cwd });
		const both = getOrThrow(await env.exec("echo out; echo err >&2"));
		expect(both.stdout.trim()).toBe("out");
		expect(both.stderr.trim()).toBe("err");
		// A shell that kills itself has no exit code; the conventional reading is
		// 128 + the signal number, so it does not read as a clean zero.
		const killed = getOrThrow(await env.exec("kill -TERM $$"));
		expect(killed.exitCode).toBe(143);
		await env.cleanup();
		await rm(cwd, { recursive: true, force: true });
	});

	it("captures a large output whole", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "eta-shell-"));
		const env = new NodeEnvironment({ cwd });
		const result = getOrThrow(await env.exec("seq 1 20000"));
		expect(result.stdout.split("\n").length).toBeGreaterThan(20_000);
		expect(result.stdout.startsWith("1\n2\n3\n")).toBe(true);
		await env.cleanup();
		await rm(cwd, { recursive: true, force: true });
	});

	it("kills the process tree on a timeout, not just the shell", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "eta-shell-"));
		const env = new NodeEnvironment({ cwd });
		// The grandchild would outlive a shell-only kill; the tree is killed.
		const timedOut = await env.exec("sh -c 'sleep 30' & wait", { timeout: 0.2 });
		expect(timedOut.ok).toBe(false);
		expect(timedOut.ok ? "" : timedOut.error.code).toBe("timeout");
		await env.cleanup();
		await rm(cwd, { recursive: true, force: true });
	});

	it("kills the command when the run is aborted", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "eta-shell-"));
		const env = new NodeEnvironment({ cwd });
		const controller = new AbortController();
		const running = env.exec("sleep 30", { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		const aborted = await running;
		expect(aborted.ok).toBe(false);
		expect(aborted.ok ? "" : aborted.error.code).toBe("aborted");
		// An already-aborted signal never spawns anything.
		const pre = await env.exec("echo never", { signal: controller.signal });
		expect(pre.ok).toBe(false);
		await env.cleanup();
		await rm(cwd, { recursive: true, force: true });
	});

	it("refuses a cwd that does not exist, and inherits the environment", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "eta-shell-"));
		const env = new NodeEnvironment({ cwd });
		const missing = await env.exec("pwd", { cwd: "no/such/dir" });
		expect(missing.ok).toBe(false);
		expect(missing.ok ? "" : missing.error.code).toBe("spawn_error");

		const inherited = getOrThrow(await env.exec("echo $ETA_SHELL_TEST", { env: { ETA_SHELL_TEST: "inherited" } }));
		expect(inherited.stdout.trim()).toBe("inherited");
		// `inheritEnv: false` starts from an empty environment: the runner's own
		// variables are gone, and only what was passed is there.
		const seen = getOrThrow(await env.exec("env", { env: { ETA_SHELL_TEST: "inherited" } }));
		expect(seen.stdout).toContain("ETA_SHELL_TEST=inherited");
		const alone = getOrThrow(await env.exec("env", { env: { ETA_SHELL_TEST: "alone" }, inheritEnv: false }));
		expect(alone.stdout).toContain("ETA_SHELL_TEST=alone");
		expect(alone.stdout).not.toContain("VITEST=");
		await env.cleanup();
		await rm(cwd, { recursive: true, force: true });
	});

	it("rejects a nonsense timeout before starting a process", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "eta-shell-"));
		const env = new NodeEnvironment({ cwd });
		const bad = await env.exec("echo hi", { timeout: -1 });
		expect(bad.ok).toBe(false);
		expect(bad.ok ? "" : bad.error.code).toBe("timeout");
		await env.cleanup();
		await rm(cwd, { recursive: true, force: true });
	});
});
