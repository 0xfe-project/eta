/**
 * The state sender (S9/S17 groundwork).
 *
 * The subject is one rule with money attached: a subscriber gets the smallest frame that
 * gets it current — everything the first time, only what moved afterwards, and nothing at
 * all when nothing moved. Everything else here is bookkeeping the server would otherwise
 * get wrong once per plugin.
 */

import type { ServerFrame, StateSnapshot } from "@eta/client-wire-proto";
import { describe, expect, it } from "vitest";
import { createStateSender } from "../src/state-sender";

function harness() {
	const frames = new Map<number, ServerFrame[]>();
	const state: Record<string, StateSnapshot> = {
		sessions: { sections: { list: ["s1"] }, revisions: { list: "0" } },
	};
	const sender = createStateSender({
		snapshot: (target) => state[target],
		warn: () => undefined,
	});
	const record = (socketId: number, incoming: ServerFrame[]): void => {
		frames.set(socketId, [...(frames.get(socketId) ?? []), ...incoming]);
	};
	return {
		sender,
		state,
		framesOf: (socketId: number) => frames.get(socketId) ?? [],
		subscribe: (socketId: number, target: string) => record(socketId, sender.subscribe(socketId, target)),
		push: (target: string) => {
			for (const addressed of sender.push(target)) record(addressed.socketId, [addressed.frame]);
		},
		set: (target: string, snapshot: StateSnapshot) => {
			state[target] = snapshot;
		},
	};
}

describe("subscribing", () => {
	it("gives a new subscriber everything, once", () => {
		const { subscribe, framesOf } = harness();
		subscribe(1, "sessions");
		expect(framesOf(1)).toEqual([
			{
				type: "state",
				target: "sessions",
				version: 1,
				snapshot: { sections: { list: ["s1"] }, revisions: { list: "0" } },
			},
		]);
		// Subscribing again is idempotent: the client is current, so nothing is owed.
		subscribe(1, "sessions");
		expect(framesOf(1)).toHaveLength(1);
	});

	it("warns and owes nothing for a target that shows no state", () => {
		const warnings: string[] = [];
		const sender = createStateSender({ snapshot: () => undefined, warn: (message) => warnings.push(message) });
		expect(sender.subscribe(1, "nope")).toEqual([]);
		expect(warnings.join(" ")).toContain("no state: nope");
	});

	it("knows who is watching, and reports what it owes whom", () => {
		const { sender, subscribe } = harness();
		subscribe(1, "sessions");
		expect(sender.subscriptions(1)).toEqual(["sessions"]);
		expect(sender.watcherCount("sessions")).toBe(1);
		sender.unsubscribe(1, "sessions");
		expect(sender.subscriptions(1)).toEqual([]);
		expect(sender.watcherCount("sessions")).toBe(0);
	});
});

describe("pushing", () => {
	it("sends a patch with only the sections that moved", () => {
		const { subscribe, push, framesOf, set } = harness();
		subscribe(1, "sessions");
		set("sessions", { sections: { list: ["s1", "s2"], metrics: 3 }, revisions: { list: "1", metrics: "3" } });
		push("sessions");
		const [, patch] = framesOf(1);
		expect(patch).toMatchObject({
			type: "state",
			target: "sessions",
			patch: { sections: { list: ["s1", "s2"], metrics: 3 } },
		});
	});

	it("sends nothing when no revision moved", () => {
		const { subscribe, push, framesOf } = harness();
		subscribe(1, "sessions");
		push("sessions");
		push("sessions");
		expect(framesOf(1)).toHaveLength(1);
	});

	it("reports a section that went away", () => {
		const { subscribe, push, framesOf, set } = harness();
		subscribe(1, "sessions");
		set("sessions", { sections: { list: ["s1"] }, revisions: {} });
		push("sessions");
		const [, patch] = framesOf(1);
		expect(patch).toMatchObject({ type: "state", patch: { revisions: {} } });
	});

	it("gives each socket its own baseline", () => {
		const { subscribe, push, framesOf, set } = harness();
		subscribe(1, "sessions");
		set("sessions", { sections: { list: ["s1", "s2"] }, revisions: { list: "1" } });
		// Socket 2 subscribes after the change, so it gets the current state whole…
		subscribe(2, "sessions");
		push("sessions");
		const [, forOne] = framesOf(1);
		expect(forOne).toMatchObject({ patch: { sections: { list: ["s1", "s2"] } } });
		// …while socket 1, which already has it, is told nothing new.
		expect(framesOf(2)).toHaveLength(1);
		expect(framesOf(2)[0]).toMatchObject({ snapshot: { sections: { list: ["s1", "s2"] } } });
	});
});

describe("unsubscribing", () => {
	it("stops sending, and a dropped socket is forgotten entirely", () => {
		const { sender, subscribe, push, framesOf, set } = harness();
		subscribe(1, "sessions");
		subscribe(2, "sessions");
		sender.unsubscribe(1, "sessions");
		sender.drop(2);

		set("sessions", { sections: { list: ["s1", "s2"] }, revisions: { list: "1" } });
		push("sessions");
		expect(framesOf(1)).toHaveLength(1);
		expect(framesOf(2)).toHaveLength(1);
		expect(sender.watcherCount("sessions")).toBe(0);
		expect(sender.subscriptions(1)).toEqual([]);
	});

	it("warns when a push names a target nobody has", () => {
		const warnings: string[] = [];
		const sender = createStateSender({ snapshot: () => undefined, warn: (m) => warnings.push(m) });
		sender.push("gone");
		expect(warnings.join(" ")).toContain("nobody has: gone");
	});
});
