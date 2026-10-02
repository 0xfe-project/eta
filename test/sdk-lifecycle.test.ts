import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginDisposer, PluginLifecycle, SessionPluginContext, SessionsListener } from "@eta/plugin-sdk";
import { WireService } from "@eta/server";
import { Context } from "cordis";
import { expect, it } from "vitest";
import { gitPlugin } from "../src/index";

it("SDK cleanup drains an in-flight read without publishing into the next instance", async () => {
	const root = await mkdtemp(join(tmpdir(), "eta-sdk-git-"));
	const ctx = new Context();
	// A real host lifecycle must satisfy the public contract without a cast.
	const lifecycle: PluginLifecycle = ctx;
	const wire = new WireService(ctx);
	const listeners = new Set<SessionsListener>();
	let cleanup: PluginDisposer = () => undefined;
	let pushes = 0;
	const host: SessionPluginContext = {
		wire: {
			handle: wire.handle,
			stateOf: wire.stateOf,
			event: wire.event,
			push: () => {
				pushes++;
			},
			pushNow: () => {
				pushes++;
			},
		},
		sessions: {
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		effect(execute) {
			cleanup = execute();
		},
	};
	try {
		expect(lifecycle.effect).toBeTypeOf("function");
		gitPlugin.apply(host);
		for (const listener of listeners) listener.opened({ id: "old", cwd: root, running: false });
		const drained = cleanup();
		expect(listeners.size).toBe(0);
		expect(wire.descriptors()).toEqual([]);
		gitPlugin.apply(host);
		await drained;
		expect(pushes).toBe(0);
		expect(listeners.size).toBe(1);
		expect(wire.descriptors()).toHaveLength(3);
		expect(wire.snapshot("git")?.sections.sessions).toEqual([]);
	} finally {
		await cleanup();
		await ctx.fiber.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
