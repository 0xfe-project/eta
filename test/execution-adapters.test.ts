import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeModels } from "@eta/core/testing";
import { NodeEnvironment } from "@eta/execution-node";
import { LocalTransport, SshEnvironment } from "@eta/ssh";
import { expect, it } from "vitest";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";

for (const kind of ["node", "ssh"] as const) {
	it(`host injects ${kind} into session file and shell tools`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "eta-adapter-"));
		const env =
			kind === "node"
				? new NodeEnvironment({ cwd })
				: new SshEnvironment({ transport: new LocalTransport({ home: cwd, tempDir: cwd }) });
		const sessions = new SessionManager({
			store: new MemorySessionStore(),
			modelsFor: () => fakeModels([]) as never,
			envFor: () => ({ env }),
		});
		try {
			const { session } = await sessions.create({ cwd });
			const call = (name: string, args: Record<string, unknown>) =>
				session.kernel.tools.execute(name, args, { turn: 1, toolCallId: name } as never);
			const write = await call("write", { path: join(cwd, "adapter.txt"), content: kind });
			expect(JSON.stringify(write)).not.toContain('"isError":true');
			const read = await call("read", { path: join(cwd, "adapter.txt") });
			expect(JSON.stringify(read)).toContain(kind);
			const bash = await call("bash", { command: "cat adapter.txt; printf 'stderr-marker' >&2" });
			expect(JSON.stringify(bash)).toContain(kind);
			expect(JSON.stringify(bash)).toContain("stderr-marker");
		} finally {
			await sessions.closeAll();
			if (env instanceof NodeEnvironment) await env.cleanup();
			await rm(cwd, { recursive: true, force: true });
		}
	});
}
