import { describe, expect, it } from "vitest";
import { initialEtaState, reduceEtaState } from "../src/lib/eta-store.ts";
import type { DevFrame, ServerMessage } from "@eta/core";

const view = { marker: 1 } as never;

function viewFrame(session: string, marker: number): ServerMessage {
	return { channel: "view", session, version: 1, view: { marker } as never };
}

function devFrame(session: string, ts: number): DevFrame {
	return { ts, session, category: "state", action: "set", data: {} };
}

describe("eta store reducer", () => {
	it("folds view frames per session", () => {
		let state = reduceEtaState(initialEtaState, viewFrame("a", 1));
		state = reduceEtaState(state, viewFrame("b", 2));
		expect(Object.keys(state.views).sort()).toEqual(["a", "b"]);
	});

	it("folds a patch onto the view it follows, transcript included", () => {
		let state = reduceEtaState(initialEtaState, {
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
		expect(state.unread).toEqual([]);
	});

	it("drops a patch with no whole frame behind it", () => {
		let state = reduceEtaState(initialEtaState, {
			type: "hello",
			sessions: [{ name: "b", badges: [], personas: [] }],
			attach: "fg",
		});
		state = reduceEtaState(state, {
			channel: "view",
			session: "b",
			version: 1,
			patch: { usage: { output: 9 } } as never,
		});
		expect(state.views["b"]).toBeUndefined();
	});

	it("caps the dev ring per session at 512 keeping the newest", () => {
		let state = initialEtaState;
		for (let i = 0; i < 600; i += 1) state = reduceEtaState(state, { channel: "dev", frame: devFrame("a", i) });
		const frames = state.dev["a"]!;
		expect(frames).toHaveLength(512);
		expect(frames[511]?.ts).toBe(599);
	});

	it("hello resyncs sessions and clears stale views", () => {
		let state = reduceEtaState(initialEtaState, viewFrame("gone", 1));
		state = reduceEtaState(state, {
			type: "hello",
			sessions: [{ name: "fresh", badges: [], personas: ["Thinker"] }],
			attach: "fresh",
		});
		expect(state.views).toEqual({});
		expect(state.attach).toBe("fresh");
		expect(state.sessions.map((s) => s.name)).toEqual(["fresh"]);
	});

	it("keeps a local attach across re-hellos but adopts the first one", () => {
		let state = reduceEtaState(initialEtaState, {
			type: "hello",
			sessions: [{ name: "mine", badges: [], personas: [] }],
			attach: "mine",
		});
		expect(state.attach).toBe("mine");
		state = reduceEtaState(state, {
			type: "hello",
			sessions: [{ name: "mine", badges: [], personas: [] }],
			attach: "other",
		});
		expect(state.attach).toBe("mine");
	});

	it("marks background sessions unread when their messages grow", () => {
		let state = reduceEtaState(initialEtaState, {
			type: "hello",
			sessions: [{ name: "bg", badges: [], personas: [] }],
			attach: "fg",
		});
		state = reduceEtaState(state, { channel: "view", session: "bg", version: 1, view: { messages: [] } as never });
		expect(state.unread).toEqual([]);
		state = reduceEtaState(state, { channel: "view", session: "bg", version: 2, view: { messages: [1] } as never });
		expect(state.unread).toEqual(["bg"]);
		state = reduceEtaState(state, {
			channel: "view",
			session: "bg",
			version: 3,
			view: { messages: [1, 2] } as never,
		});
		expect(state.unread).toEqual(["bg"]);
	});

	it("surfaces server errors", () => {
		const state = reduceEtaState(initialEtaState, { type: "error", message: "unknown persona: x" });
		expect(state.error).toBe("unknown persona: x");
	});
});
