import { describe, expect, it } from "vitest";
import { initialEtaState, reduceEtaState } from "../src/lib/eta-store.ts";
import type { DevFrame, ServerMessage, SidebarSession } from "@eta/core";

const session = (name: string): SidebarSession => ({ name, badges: [], personas: [] });

function viewFrame(name: string, messages: number): ServerMessage {
	return {
		channel: "view",
		session: name,
		version: 1,
		view: { messages: new Array(messages).fill({}), marker: messages } as never,
	};
}

function devFrame(session: string, ts: number): DevFrame {
	return { ts, session, category: "state", action: "set", data: {} };
}

describe("eta store reducer", () => {
	it("folds the front session's whole frame into views", () => {
		let state = reduceEtaState(initialEtaState, { type: "hello", sessions: [session("a")], attach: "a" });
		state = reduceEtaState(state, viewFrame("a", 2));
		expect(Object.keys(state.views)).toEqual(["a"]);
		expect(state.views["a"]!.messages).toHaveLength(2);
	});

	it("turns a background whole frame into a stub, not a view", () => {
		let state = reduceEtaState(initialEtaState, {
			type: "hello",
			sessions: [session("a"), session("b")],
			attach: "a",
		});
		state = reduceEtaState(state, viewFrame("b", 3));
		expect(state.views["b"]).toBeUndefined();
		expect(state.stubs["b"]).toEqual({ version: 1, messageCount: 3 });
	});

	it("folds a patch onto the front view it follows", () => {
		let state = reduceEtaState(initialEtaState, { type: "hello", sessions: [session("a")], attach: "a" });
		state = reduceEtaState(state, {
			channel: "view",
			session: "a",
			version: 1,
			view: { messages: [1], usage: { output: 1 }, streaming: { content: "hi" } } as never,
		});
		state = reduceEtaState(state, {
			channel: "view",
			session: "a",
			version: 2,
			patch: { usage: { output: 2 } } as never,
		});
		const merged = state.views["a"] as unknown as {
			messages: unknown[];
			usage: { output: number };
			streaming: { content: string };
		};
		expect(merged.messages).toHaveLength(1);
		expect(merged.usage.output).toBe(2);
		expect(merged.streaming.content).toBe("hi");
	});

	it("drops a background patch with no stub behind it", () => {
		let state = reduceEtaState(initialEtaState, { type: "hello", sessions: [session("b")], attach: "fg" });
		state = reduceEtaState(state, {
			channel: "view",
			session: "b",
			version: 1,
			patch: { usage: { output: 9 } } as never,
		});
		expect(state.stubs["b"]).toBeUndefined();
	});

	it("advances a background stub's version on a patch without growing its count", () => {
		let state = reduceEtaState(initialEtaState, {
			type: "hello",
			sessions: [session("a"), session("b")],
			attach: "a",
		});
		state = reduceEtaState(state, viewFrame("b", 3));
		state = reduceEtaState(state, {
			channel: "view",
			session: "b",
			version: 7,
			patch: { usage: { output: 9 } } as never,
		});
		expect(state.stubs["b"]).toEqual({ version: 7, messageCount: 3 });
	});

	it("caps the dev ring per session at 512 keeping the newest", () => {
		let state = initialEtaState;
		for (let i = 0; i < 600; i += 1) state = reduceEtaState(state, { channel: "dev", frame: devFrame("a", i) });
		const frames = state.dev["a"]!;
		expect(frames).toHaveLength(512);
		expect(frames[511]?.ts).toBe(599);
	});

	it("hello resyncs sessions and clears stale views and stubs", () => {
		let state = reduceEtaState(initialEtaState, { type: "hello", sessions: [session("gone")], attach: "gone" });
		state = reduceEtaState(state, viewFrame("gone", 1));
		expect(state.views["gone"]).toBeDefined();
		state = reduceEtaState(state, { type: "hello", sessions: [session("gone")], attach: "gone" });
		expect(state.views).toEqual({});
		expect(state.stubs).toEqual({});
	});

	it("keeps a local attach across re-hellos but adopts the first one", () => {
		let state = reduceEtaState(initialEtaState, { type: "hello", sessions: [session("mine")], attach: "mine" });
		expect(state.attach).toBe("mine");
		state = reduceEtaState(state, { type: "hello", sessions: [session("mine")], attach: "other" });
		expect(state.attach).toBe("mine");
	});

	it("marks background sessions unread when their transcript grows", () => {
		let state = reduceEtaState(initialEtaState, { type: "hello", sessions: [session("bg")], attach: "fg" });
		state = reduceEtaState(state, viewFrame("bg", 0));
		expect(state.unread).toEqual([]);
		state = reduceEtaState(state, viewFrame("bg", 1));
		expect(state.unread).toEqual(["bg"]);
		state = reduceEtaState(state, viewFrame("bg", 2));
		expect(state.unread).toEqual(["bg"]);
	});

	it("surfaces server errors", () => {
		const state = reduceEtaState(initialEtaState, { type: "error", message: "unknown persona: x" });
		expect(state.error).toBe("unknown persona: x");
	});
});
