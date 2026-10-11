import { describe, expect, it } from "vitest";
import { encodeFrame, stateDiff, type StateSnapshot } from "@eta/client-wire-proto";
import {
	stateSection,
	type HelloFrame,
	type SessionCall,
	type SessionHistoryResult,
	type SessionViewSections,
	type ProvidersView,
} from "../src/index";

const sections = {
	core: { session: "s1", cwd: "/work", running: false },
	transcript: {
		messages: [
			{
				entryId: "e1",
				seq: 1,
				at: 10,
				message: {
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{ type: "image", data: "AA==", mimeType: "image/png" },
					],
					timestamp: 10,
				},
			},
		],
	},
	systems: {
		rows: [
			{ entryId: "g", seq: 2, kind: "goal", args: {} },
			{
				entryId: "f",
				seq: 3,
				at: 11,
				kind: "run_failed",
				args: { runId: "run", error: "model_unavailable: acme/fast" },
			},
		],
	},
	goal: { objective: "ship", status: "active", roundCount: 1, idleWithoutTools: 0 },
	tasks: [{ id: "task", content: "test", status: "pending", dependsOn: ["first"] }],
	sideThread: [
		{
			id: "btw",
			kind: "contextual",
			exchanges: [{ question: "why", answer: "because", at: 12, steps: [{ tool: "read", ok: true, at: 11 }] }],
			saveState: "queued",
			pending: { question: "next", at: 13 },
		},
	],
	subagents: [{ id: "child", status: "running", turns: 2 }],
	ask: { pending: { questionId: "q", question: "which", options: ["a", "b"], multi: true }, deadline: 100 },
	queue: {
		items: [{ entryId: "queued", kind: "steer", text: "look", images: [{ mime: "image/png", dataBase64: "AA==" }] }],
	},
} satisfies Partial<SessionViewSections>;
const snapshot: StateSnapshot = {
	sections,
	revisions: Object.fromEntries(Object.keys(sections).map((name) => [name, "1"])),
};

describe("existing business JSON on the generic pipe", () => {
	it("keeps hello metadata, provider configuration and session sections intact", () => {
		const config: ProvidersView = {
			revision: "hash",
			providers: [
				{
					id: "local",
					kind: "openai-compatible",
					baseUrl: "http://localhost",
					hasApiKey: true,
					headers: { "User-Agent": null },
					models: [{ id: "model", input: ["text", "image"] }],
				},
			],
		};
		const hello: HelloFrame = {
			type: "hello",
			ops: [],
			mounted: [
				{ name: "git", source: "bundled", descriptor: { name: "git", title: "Git", slot: "panel", state: "git" } },
			],
			state: { "sessions.s1": snapshot, providers: { sections: { config }, revisions: { config: "hash" } } },
			diagnostics: { stableChars: 1, adaptiveChars: 2, sections: [{ name: "system", stable: true, text: "hello" }] },
		};
		expect(JSON.parse(encodeFrame(hello))).toEqual(hello);
		expect(stateSection(snapshot, "transcript")?.messages[0]?.message.role).toBe("user");
		expect(stateSection(snapshot, "core")?.session).toBe("s1");
		expect(stateSection(snapshot, "systems")?.rows.find((row) => row.kind === "run_failed")?.args.error).toBe(
			"model_unavailable: acme/fast",
		);
		// A history page from a server that predates system rows still reads.
		const older: SessionHistoryResult = { session: "s1", rows: sections.transcript.messages };
		expect(older.systems ?? []).toEqual([]);
		expect(stateSection(snapshot, "prompt")).toBeUndefined();
	});
	it("uses unchanged diff and removal semantics for business and plugin sections", () => {
		expect(stateDiff(undefined, snapshot)).toBe("full");
		expect(stateDiff(snapshot.revisions, snapshot)).toBeUndefined();
		const next = { sections: { ...sections, subagents: [] }, revisions: { ...snapshot.revisions, subagents: "2" } };
		const patch = stateDiff({ ...snapshot.revisions, git: "old" }, next);
		expect(patch).toEqual({ sections: { subagents: [] }, revisions: next.revisions });
		expect(
			JSON.parse(
				encodeFrame({
					type: "state",
					target: "sessions.s1",
					version: 2,
					patch: patch as Exclude<typeof patch, "full" | undefined>,
				}),
			),
		).toEqual({ type: "state", target: "sessions.s1", version: 2, patch });
	});
	it("preserves operation names and request payloads", () => {
		const call: SessionCall = {
			op: "call",
			target: "sessions",
			action: "prompt",
			requestId: "7",
			args: { session: "s1", text: "look", mode: "steer", images: [{ mime: "image/png", dataBase64: "AA==" }] },
		};
		expect(JSON.stringify(call)).toBe(
			'{"op":"call","target":"sessions","action":"prompt","requestId":"7","args":{"session":"s1","text":"look","mode":"steer","images":[{"mime":"image/png","dataBase64":"AA=="}]}}',
		);
	});
});

it("preserves assistant/tool/summary payloads as JSON data", () => {
	const messages: import("../src/index").AgentMessage[] = [
		{
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "model",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "plan", redacted: false },
				{ type: "toolCall", id: "c", name: "read", arguments: { path: "/work", options: [true, null, 2] } },
			],
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				reasoning: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "deferred",
			deferred: { provider: "openai", modelId: "model", api: "openai-responses", id: "job", data: { poll: true } },
			diagnostics: [
				{ type: "retry", timestamp: 1, error: { message: "retry", code: 429 }, details: { attempt: 1 } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "c",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2,
			details: { bytes: 2 },
			addedToolNames: ["read_more"],
		},
		{ role: "compactionSummary", summary: "before", tokensBefore: 30, timestamp: 3 },
		{ role: "branchSummary", summary: "branch", fromId: null, timestamp: 4 },
	];
	const frame = { type: "reply" as const, requestId: "history", ok: true as const, result: { messages } };
	expect(JSON.parse(encodeFrame(frame))).toEqual(frame);
});
