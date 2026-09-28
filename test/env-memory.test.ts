/**
 * The env contract, run against the in-memory environment.
 *
 * The same suite `NodeEnvironment` runs (its own file, once it exists), so a
 * tool written against `ExecutionEnv` cannot depend on which backend it got.
 */
import { describe, expect, it } from "vitest";
import { MemoryEnvironment } from "../src/env/memory";
import { getOrThrow } from "../src/env/types";
import { envContract } from "../src/testing";

envContract("memory", () => {
	// No `capabilities.shell`: this backend answers a scripted vocabulary, not
	// real commands, so the contract's real-shell assertions do not apply. Its
	// own tests below cover what it does answer.
	const env = new MemoryEnvironment({ shell: versionedEcho });
	return { env, dispose: async () => env.cleanup() };
});

/** A scripted shell: enough of one to answer the contract's questions. */
async function versionedEcho(call: {
	command: string;
	cwd: string;
	signal?: AbortSignal | undefined;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const [program, ...rest] = call.command.split(" ");
	if (program === "echo") return { exitCode: 0, stdout: `${rest.join(" ")}\n`, stderr: "" };
	if (program === "printf") return { exitCode: 0, stdout: rest.join(" "), stderr: "" };
	return { exitCode: 127, stdout: "", stderr: `command not found: ${call.command}\n` };
}

describe("MemoryEnvironment specifics", () => {
	it("seeds files, directories and symlinks, relative to cwd", async () => {
		const env = new MemoryEnvironment({
			cwd: "/work",
			files: { "seed/a.txt": "a", "/etc/hosts": "hosts" },
			dirs: ["seed/empty"],
			symlinks: { "seed/link": "seed/a.txt" },
		});
		expect(getOrThrow(await env.readTextFile("seed/a.txt"))).toBe("a");
		expect(getOrThrow(await env.readTextFile("/etc/hosts"))).toBe("hosts");
		expect(getOrThrow(await env.exists("seed/empty"))).toBe(true);
		// Following the seeded symlink lands on the file it points at.
		expect(getOrThrow(await env.canonicalPath("seed/link"))).toBe("/work/seed/a.txt");
	});

	it("treats a torn final line as unterminated", async () => {
		const env = new MemoryEnvironment({ files: { "torn.txt": "one\ntwo" } });
		const reader = getOrThrow(await env.openTextLineReader("torn.txt"));
		expect(getOrThrow(await reader.readLine())?.terminated).toBe(true);
		const last = getOrThrow(await reader.readLine());
		expect(last?.text).toBe("two");
		expect(last?.terminated).toBe(false);
		await reader.close();
	});

	it("has no shell until one is given, and reports that as such", async () => {
		const bare = new MemoryEnvironment();
		const result = await bare.exec("echo hi");
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.error.code).toBe("shell_unavailable");

		const scripted = new MemoryEnvironment({ shell: versionedEcho });
		const ran = getOrThrow(await scripted.exec("echo hi"));
		expect(ran.stdout).toBe("hi\n");
	});
});
