/**
 * The toolset a session installs (H11d).
 *
 * A session used to open with *no* tools: every tool existed, every tool was tested,
 * and installing them was left to a host that had not been written. What is pinned
 * here is the battery a session gets, that its names are what the model is told it
 * may call, that a missing environment means missing file tools (rather than broken
 * ones), and that a deployment's own choice of a narrower toolset is not overwritten.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, SessionLog } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AskRegistry } from "../src/ask";
import { MemoryEnvironment } from "../src/env/memory";
import { NodeEnvironment } from "../src/env/node-shell";
import { openSession } from "../src/open";
import { defineTool } from "../src/tools/tool";

const userMsg = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

const toolCallTurn = (name: string, args: Record<string, unknown> = {}) =>
	assistantMessage({
		stopReason: "toolUse",
		content: [{ type: "toolCall" as const, id: `c-${name}`, name, arguments: args }],
	});
const stopTurn = (text = "done") => assistantMessage({ content: [{ type: "text", text }] });

const registered = (session: { kernel: { tools: { list(): { name: string }[] } } }): string[] =>
	session.kernel.tools.list().map((tool) => tool.name);

const env = new MemoryEnvironment({ cwd: "/work/eta" });

describe("what a session installs", () => {
	it("installs the standard battery, and says so in activeToolNames", async () => {
		const session = await openSession({
			storage: new MemoryStorage(),
			models: fakeModels([]) as never,
			env: env as never,
		});
		expect(registered(session).sort()).toEqual(
			[
				"TaskCreate",
				"TaskGet",
				"TaskList",
				"TaskUpdate",
				"bash",
				"check_state",
				"edit",
				"list_state",
				"read",
				"update_state",
				"write",
			].sort(),
		);
		expect(session.tools).toEqual(registered(session));
		// What the model may call is exactly what was installed.
		expect(session.config.activeToolNames).toEqual(session.tools);
		await session.kernel.dispose();
		session.stop();
	});

	it("leaves the file tools out when there is no environment", async () => {
		const session = await openSession({ storage: new MemoryStorage(), models: fakeModels([]) as never });
		const names = registered(session);
		expect(names).toContain("TaskUpdate");
		expect(names).toContain("update_state");
		// No environment, no way to read a file or run a command: absent, not broken.
		expect(names).not.toContain("read");
		expect(names).not.toContain("write");
		expect(names).not.toContain("edit");
		expect(names).not.toContain("bash");
		expect(names).not.toContain("ask_user");
		expect(names).not.toContain("Agent");
		await session.kernel.dispose();
		session.stop();
	});

	it("installs the ask tool when the session has an ask channel", async () => {
		const registry = new AskRegistry();
		const session = await openSession({
			storage: new MemoryStorage(),
			models: fakeModels([]) as never,
			ask: registry,
		});
		expect(registered(session)).toContain("ask_user");
		await session.kernel.dispose();
		session.stop();
	});

	it("installs the subagent tools when a pool is supplied", async () => {
		const spawned: string[] = [];
		const session = await openSession({
			storage: new MemoryStorage(),
			models: fakeModels([]) as never,
			subagents: {
				spawnAndWait: (spec: { prompt: string }) => {
					spawned.push(spec.prompt);
					return { id: "sub-1" };
				},
				get: () => undefined,
				wait: async () => ({ id: "sub-1", status: "done" }),
				list: () => [],
			} as never,
		});
		expect(registered(session)).toContain("Agent");
		expect(registered(session)).toContain("get_subagent_result");
		expect(registered(session)).toContain("steer_subagent");
		await session.kernel.dispose();
		session.stop();
	});

	it("appends a caller's own tools after the standard ones", async () => {
		const custom = defineTool({
			name: "custom_echo",
			description: "echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: (args: { text: string }) => ({ content: [{ type: "text" as const, text: args.text }] }),
		});
		const session = await openSession({
			storage: new MemoryStorage(),
			models: fakeModels([]) as never,
			tools: [custom as never],
		});
		expect(registered(session)).toContain("custom_echo");
		expect(session.config.activeToolNames).toContain("custom_echo");
		await session.kernel.dispose();
		session.stop();
	});
});

describe("the tools against a real environment", () => {
	it("reads, writes and runs a command through the session's own environment", async () => {
		// A real environment: the memory one answers commands from a script, which is
		// its own subject, not this test's.
		const cwd = await mkdtemp(join(tmpdir(), "eta-open-tools-"));
		const models = fakeModels([
			toolCallTurn("write", { path: "notes/a.txt", content: "hello from the session" }),
			toolCallTurn("bash", { command: "cat notes/a.txt" }),
			toolCallTurn("read", { path: "notes/a.txt" }),
			stopTurn(),
		]);
		const session = await openSession({
			storage: new MemoryStorage(),
			models: models as never,
			env: new NodeEnvironment({ cwd }) as never,
		});
		session.kernel.inject(userMsg("write it, then read it back"));
		const result = await session.runner.run();
		expect(result.status).toBe("completed");
		// Every call was admitted and answered — a missing tool would have come back as
		// an unknown-tool error result instead.
		const results = models.calls
			.flatMap((call) => call.context.messages)
			.filter((message) => message.role === "toolResult");
		expect(results.every((message) => (message as { isError?: boolean }).isError !== true)).toBe(true);
		expect(JSON.stringify(results)).toContain("hello from the session");
		await session.kernel.dispose();
		session.stop();
		await rm(cwd, { recursive: true, force: true });
	});

	it("records a question before it waits, so a replay still finds it", async () => {
		const storage = new MemoryStorage();
		const registry = new AskRegistry();
		const models = fakeModels([
			toolCallTurn("ask_user", { question: "which port?", options: [{ title: "8080" }] }),
			stopTurn(),
		]);
		const session = await openSession({
			storage,
			models: models as never,
			ask: registry,
			askTimeoutMs: 50,
		});
		session.kernel.inject(userMsg("go"));
		await session.runner.run();
		await session.journaling.flush();

		// The question is an entry (the tool timed out as `none`, which is an answer the
		// model can read rather than a hang)…
		const entries = await storage.scanEntries({});
		expect(entries.some((entry) => entry.type === "ask")).toBe(true);
		expect(JSON.stringify(entries)).toContain("which port?");
		// …and a registry rebuilt over that journal knows what is still waiting.
		const replaying = new AskRegistry();
		replaying.replay((await SessionLog.load(storage)).graph.pathOldestFirst());
		expect(replaying.pendingAsks().map((ask) => ask.question)).toEqual(["which port?"]);
		await session.kernel.dispose();
		session.stop();
	});

	it("keeps a narrower toolset a journal already chose", async () => {
		const storage = new MemoryStorage();
		const first = await openSession({ storage, models: fakeModels([]) as never, env: env as never });
		// Somebody narrows the session down to `read` and that decision is journalled.
		first.kernel.config.update({ activeToolNames: ["read"] });
		await first.journaling.flush();
		await first.kernel.dispose();
		first.stop();

		const warnings: string[] = [];
		const again = await openSession({
			storage,
			models: fakeModels([]) as never,
			env: env as never,
			kernel: { warn: (message) => warnings.push(message) },
		});
		expect(again.config.activeToolNames).toEqual(["read"]);
		// Everything is still installed; the selection is what the model is told.
		expect(registered(again)).toContain("bash");
		expect(warnings.join(" ")).not.toContain("not installed");
		await again.kernel.dispose();
		again.stop();
	});

	it("warns when a configured tool is not installed instead of quietly dropping it", async () => {
		const storage = new MemoryStorage();
		const first = await openSession({ storage, models: fakeModels([]) as never });
		first.kernel.config.update({ activeToolNames: ["mystery_tool"] });
		await first.journaling.flush();
		await first.kernel.dispose();
		first.stop();

		const warnings: string[] = [];
		// Same journal, no environment: the tool it was configured for is not here.
		const again = await openSession({
			storage,
			models: fakeModels([]) as never,
			kernel: { warn: (message) => warnings.push(message) },
		});
		expect(warnings.join(" ")).toContain("mystery_tool");
		await again.kernel.dispose();
		again.stop();
	});
});
