/**
 * G0 fake feed: a frozen SessionView plus dev frames across categories, used
 * by the window smoke run and the test renderer until the real channels wire
 * in at G1.
 */

import type { SessionView } from "@eta/core";
import type { DevFrame } from "./channels.ts";

export interface SidebarSession {
	name: string;
	badges: string[];
}

export interface FakeFeed {
	sessions: SidebarSession[];
	view: SessionView;
	dev: DevFrame[];
}

export const emptyView = (): SessionView => ({
	stateKeys: ["build.cmd"],
	messages: [],
	systems: [],
	thinking: [],
	compactionEpoch: 0,
	memory: undefined,
	subagents: [],
	goal: undefined,
	tasks: [],
	loops: [],
	sideThread: [],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	cacheRate: 0,
	branch: { tipId: null },
	pendingAsk: undefined,
	prompt: undefined,
	tokensPerSec: 0,
});

const message = (entryId: string, role: "user" | "assistant", text: string): SessionView["messages"][number] => ({
	entryId,
	seq: Number(entryId.replace(/\D/g, "")),
	message: { role, content: text, timestamp: 0 } as SessionView["messages"][number]["message"],
});

export function fakeFeed(): FakeFeed {
	const view = emptyView();
	view.messages = [
		message("m1", "user", "hello eta"),
		{
			entryId: "m2",
			seq: 2,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "rendering the first frame" },
					{ type: "toolCall", id: "c1", name: "TaskCreate", arguments: { content: "write the thing" } },
				],
				timestamp: 0,
			} as SessionView["messages"][number]["message"],
		},
		{
			entryId: "m3",
			seq: 3,
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "TaskCreate",
				content: [{ type: "text", text: "Created t1." }],
				timestamp: 0,
			} as SessionView["messages"][number]["message"],
		},
	];
	view.thinking = ["pick a tool first"];
	view.sideThread = [{ id: "b1", kind: "tangent", exchanges: [{ question: "side note", answer: "noted", at: 0 }], saveState: "not-saved" }];
	view.systems = [{ entryId: "s1", seq: 1, kind: "goal", text: "goal set: paint the window" }];
	view.tasks = [{ id: "t1", content: "write the thing", status: "pending" }];
	view.loops = [{ id: "tick", note: "check ci", every: "1s", runCount: 2, paused: false }];
	view.memory = { chars: 800 };
	view.subagents = [{ id: "a1", status: "running", turns: 3 }];
	view.goal = { objective: "paint the window", status: "active", roundCount: 0, idleWithoutTools: 0 };
	view.pendingAsk = { questionId: "q1", question: "which theme?", options: ["dark", "light"] };
	view.prompt = { stableChars: 1200, adaptiveChars: 340 };
	view.tokensPerSec = 42;
	const dev: DevFrame[] = [
		{ ts: 1, session: "eta-main", category: "turn", action: "turn_start", data: {} },
		{ ts: 2, session: "eta-main", category: "tool", action: "end", data: { toolName: "TaskCreate" } },
		{ ts: 3, session: "eta-main", category: "goal", action: "set", data: { objective: "paint the window" } },
		{ ts: 4, session: "eta-main", category: "loop", action: "fired", data: {} },
		{ ts: 5, session: "eta-main", category: "usage", action: "row", data: {} },
		{ ts: 6, session: "eta-main", category: "compaction", action: "end", data: {} },
	];
	return {
		sessions: [
			{ name: "eta-main", badges: ["goal", "loop"] },
			{ name: "scratch", badges: [] },
		],
		view,
		dev,
	};
}
