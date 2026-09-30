/**
 * The target registry (S10).
 *
 * The subject is that a target owns actions and state, and that nothing distinguishes a
 * built-in from a plugin: the same `handle`/`state` calls, the same disposers, the same
 * namespace rules. What the tests pin is what a client depends on — an unknown call fails
 * loudly with the name that was asked for, a duplicate is refused, unloading takes exactly
 * one target's things with it, and `hello`'s descriptor list is the truth about what exists.
 */

import type { CallFrame } from "@eta/client-wire-proto";
import { describe, expect, it } from "vitest";
import { createTargetRegistry, UnknownOpError } from "../src/registry";

const context = { reply: () => undefined };
const registry = () => createTargetRegistry();

describe("actions", () => {
	it("routes a call to the handler that claimed the name", async () => {
		const targets = registry();
		const seen: unknown[] = [];
		targets.handle("sessions", "prompt", (call) => {
			seen.push(call.args);
			return { result: { queued: true } };
		});
		const outcome = await targets.dispatch(
			{ op: "call", target: "sessions", action: "prompt", args: { text: "hi" } },
			context,
		);
		expect(seen).toEqual([{ text: "hi" }]);
		expect(outcome.result).toEqual({ queued: true });
	});

	it("refuses a duplicate, and a name that is not a name", () => {
		const targets = registry();
		targets.handle("sessions", "pin", () => undefined);
		expect(() => targets.handle("sessions", "pin", () => undefined)).toThrow(/already registered: sessions.pin/);
		expect(() => targets.handle("sessions", "not an action", () => undefined)).toThrow(/invalid action/);
		expect(() => targets.handle("bad name", "x", () => undefined)).toThrow(/invalid target/);
	});

	it("calls an unclaimed name an error naming it", async () => {
		const targets = registry();
		await expect(targets.dispatch({ op: "call", target: "sessions", action: "promt" }, context)).rejects.toThrow(
			UnknownOpError,
		);
		await expect(targets.dispatch({ op: "call", target: "sessions", action: "promt" }, context)).rejects.toThrow(
			/unknown op: sessions.promt/,
		);
	});

	it("forgets an action when its disposer runs, leaving its neighbours", async () => {
		const targets = registry();
		const off = targets.handle("git", "status", () => undefined);
		targets.handle("git", "diff", () => undefined);
		off();
		expect(targets.descriptors().map((op) => op.name)).toEqual(["git.diff"]);
		await expect(targets.dispatch({ op: "call", target: "git", action: "status" }, context)).rejects.toThrow(
			UnknownOpError,
		);
	});

	it("publishes what a client needs to know about each action", () => {
		const targets = registry();
		targets.handle("sessions", "prompt", () => undefined, { description: "queue or steer an input" });
		targets.handle("git", "status", () => undefined, { schema: { type: "object" } });
		expect(targets.descriptors()).toEqual([
			{ name: "git.status", target: "git", action: "status", schema: { type: "object" } },
			{ name: "sessions.prompt", target: "sessions", action: "prompt", description: "queue or steer an input" },
		]);
	});

	it("splits a dotted target name on the first dot", async () => {
		const targets = registry();
		const calls: CallFrame[] = [];
		targets.handle("sessions.eta-1", "resync", (call) => {
			calls.push(call);
			return {};
		});
		await targets.dispatch({ op: "call", target: "sessions.eta-1", action: "resync" }, context);
		expect(calls[0]?.target).toBe("sessions.eta-1");
		expect(targets.targets().map((summary) => summary.name)).toContain("sessions.eta-1");
	});
});

describe("state", () => {
	it("is part of what a target offers, and can be marked eager", () => {
		const targets = registry();
		targets.handle("sessions", "create", () => undefined);
		targets.state("sessions", { project: () => ({ sections: { list: [] }, revisions: { list: "0" } }), eager: true });
		targets.state("git", { project: () => ({ sections: {}, revisions: {} }) });

		expect(targets.hasState("sessions")).toBe(true);
		expect(targets.hasState("git")).toBe(true);
		expect(targets.hasState("nope")).toBe(false);
		// Only the eager one is pushed with `hello`: a fresh client needs the session list,
		// not every panel anybody could open.
		expect(targets.eagerTargets()).toEqual(["sessions"]);
		expect(targets.targets()).toEqual([
			{ name: "git", hasState: true, eager: false, actions: [] },
			{ name: "sessions", hasState: true, eager: true, actions: ["create"] },
		]);
	});

	it("refuses a second projector for one target", () => {
		const targets = registry();
		const first = { project: () => ({ sections: {}, revisions: {} }) };
		targets.state("sessions", first);
		expect(() => targets.state("sessions", { project: () => ({ sections: {}, revisions: {} }) })).toThrow(
			/already registered: sessions/,
		);
	});

	it("hands back a target's current state, and removes it on unload", () => {
		const targets = registry();
		const off = targets.state("git", {
			project: () => ({ sections: { branch: "main" }, revisions: { branch: "main" } }),
		});
		expect(targets.snapshot("git")?.sections.branch).toBe("main");
		off();
		expect(targets.snapshot("git")).toBeUndefined();
		expect(targets.hasState("git")).toBe(false);
	});

	it("reports a projector that throws instead of failing the pipe", () => {
		const targets = registry();
		targets.state("broken", {
			project: () => {
				throw new Error("plugin exploded");
			},
		});
		const snapshot = targets.snapshot("broken");
		expect(snapshot?.sections.error).toEqual({ message: "plugin exploded" });
		expect(snapshot?.revisions.error).toContain("plugin exploded");
	});
});
