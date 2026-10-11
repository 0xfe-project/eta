import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimServiceFile, readServiceFile } from "../src/service-file";

async function runFile(): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "eta-run-")), "run", "machine.json");
}

const ready = { protocol: 1, host: "127.0.0.1", port: 8787, dataDir: "/d", version: "t" };

describe("the run file", () => {
	it("claims before listening, publishes once listening, 0600", async () => {
		const path = await runFile();
		const claim = await claimServiceFile(path, { pid: 100, now: () => 5 });
		if (claim.kind !== "claimed") throw new Error("expected a claim");
		expect(await readServiceFile(path)).toEqual({ state: "starting", pid: 100, startedAt: 5 });
		await claim.publish(ready);
		expect(await readServiceFile(path)).toEqual({ state: "ready", pid: 100, startedAt: 5, ...ready });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("stands down when a live backend owns the file", async () => {
		const path = await runFile();
		const first = await claimServiceFile(path, { pid: 100, alive: () => true });
		if (first.kind !== "claimed") throw new Error("expected a claim");
		await first.publish(ready);
		const second = await claimServiceFile(path, { pid: 200, alive: () => true });
		expect(second.kind).toBe("taken");
		if (second.kind === "taken") expect(second.owner).toMatchObject({ state: "ready", pid: 100, port: 8787 });
	});

	it("takes over a file whose process is gone", async () => {
		const path = await runFile();
		const first = await claimServiceFile(path, { pid: 100 });
		if (first.kind !== "claimed") throw new Error("expected a claim");
		const second = await claimServiceFile(path, { pid: 200, alive: (pid) => pid !== 100 });
		expect(second.kind).toBe("claimed");
		expect((await readServiceFile(path))?.pid).toBe(200);
	});

	it("takes over a file that is not a descriptor", async () => {
		const path = await runFile();
		await (await claimServiceFile(path, { pid: 1 })).kind;
		await writeFile(path, "not json");
		expect((await claimServiceFile(path, { pid: 2 })).kind).toBe("claimed");
	});

	it("releases only a file that still names it", async () => {
		const path = await runFile();
		const first = await claimServiceFile(path, { pid: 100 });
		if (first.kind !== "claimed") throw new Error("expected a claim");
		// A successor took the file over (this one was presumed dead): leaving must not delete it.
		const successor = await claimServiceFile(path, { pid: 200, alive: () => false });
		if (successor.kind !== "claimed") throw new Error("expected a claim");
		await first.release();
		expect((await readServiceFile(path))?.pid).toBe(200);
		await successor.release();
		await expect(readFile(path)).rejects.toThrow();
	});
});
