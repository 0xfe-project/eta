/**
 * The tool layer (REFACTOR.md §6.2).
 *
 * The kernel knows a tool as a name, a description and an `execute`. What this
 * file pins is the layer on top: a parameter schema the provider can see,
 * arguments validated before the body runs, a typed context, and a result that
 * reaches the model as content blocks rather than as stringified JSON.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, Runner, SessionLog, type ToolCallInfo } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { NodeEnvironment } from "../src/env/node-shell";
import { getOrThrow } from "@eta/execution";
import { journaledKernel } from "../src/testing";
import { type ExecutionToolContext, executionContext } from "../src/tools/context";
import { defineTool, toKernelTool } from "../src/tools/tool";

const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

// `Type.Object(...)`'s static type, named once so the tool below can use it.
const echoSchema = Type.Object({
	path: Type.String(),
	text: Type.String(),
});

const echo = defineTool<ExecutionToolContext, typeof echoSchema>({
	name: "echo",
	description: "Write text into a file in the environment's working directory.",
	parameters: Type.Object({
		path: Type.String({ description: "Where to write, relative to the working directory" }),
		text: Type.String({ description: "What to write" }),
	}),
	async execute(args, run) {
		const written = await run.context.env.writeFile(args.path, args.text);
		if (!written.ok) return { content: [{ type: "text", text: written.error.message }], isError: true };
		return { content: [{ type: "text", text: `wrote ${args.text} to ${args.path}` }] };
	},
});

function session(script: Parameters<typeof fakeModels>[0], toolContext: unknown) {
	const { kernel } = journaledKernel(SessionLog.create(new MemoryStorage()));
	const registered = toKernelTool(echo, executionContext);
	kernel.tools.register(registered);
	kernel.config.update({ activeToolNames: ["echo"] });
	const fake = fakeModels(script);
	const runner = new Runner(kernel, { models: fake, toolContext });
	return { kernel, runner, fake };
}

const callEcho = (args: Record<string, unknown>) =>
	assistantMessage({
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: args } as never],
	});

describe("harness tools", () => {
	it("is called by the model end to end, and its result reaches it as text", async () => {
		const env = new NodeEnvironment({ cwd: await mkdtemp(join(tmpdir(), "eta-tools-")) });
		const { kernel, runner, fake } = session(
			[
				callEcho({ path: "note.txt", text: "hello" }),
				assistantMessage({ content: [{ type: "text", text: "done" }] }),
			],
			{ env },
		);
		kernel.inject(userMsg("write a note"));
		const result = await runner.run();
		expect(result.error).toBeUndefined();
		// The tool ran, through the environment, with the schema's arguments.
		expect(getOrThrow(await env.readTextFile("note.txt"))).toBe("hello");
		// And the model saw the tool's own words, not JSON of a result object.
		const toolResult = fake.calls[1]!.context.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(toolResult)).toContain("wrote hello to note.txt");
		expect(JSON.stringify(toolResult)).not.toContain('content\\":[{');
		await env.cleanup();
	});

	it("refuses invalid arguments before the body runs, and says why", async () => {
		const env = new NodeEnvironment({ cwd: await mkdtemp(join(tmpdir(), "eta-tools-")) });
		const { kernel, runner, fake } = session(
			[callEcho({ path: "note.txt" }), assistantMessage({ content: [{ type: "text", text: "ok" }] })],
			{ env },
		);
		kernel.inject(userMsg("write a note"));
		await runner.run();
		// Nothing was written: the missing argument never reached the body.
		expect(getOrThrow(await env.exists("note.txt"))).toBe(false);
		const toolResult = fake.calls[1]!.context.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(toolResult)).toContain("invalid arguments for echo");
		expect((toolResult as { isError?: boolean } | undefined)?.isError).toBe(true);
		await env.cleanup();
	});

	it("tells the model when a tool needs an environment and the run has none", async () => {
		const { kernel, runner, fake } = session(
			[callEcho({ path: "note.txt", text: "x" }), assistantMessage({ content: [{ type: "text", text: "ok" }] })],
			undefined,
		);
		kernel.inject(userMsg("go"));
		const result = await runner.run();
		// Fail-closed and visible: the call is an error the model can read, not a
		// silent success and not a dead run.
		expect(result.status).toBe("completed");
		const toolResult = fake.calls[1]!.context.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(toolResult)).toContain("needs an execution environment");
		expect((toolResult as { isError?: boolean } | undefined)?.isError).toBe(true);
	});

	it("gives a tool the call's signal and a typed context", async () => {
		let seen: ToolCallInfo | undefined;
		const probe = defineTool<ExecutionToolContext, typeof probeSchema>({
			name: "probe",
			description: "Record what the run handed over.",
			parameters: probeSchema,
			execute(_args, run) {
				seen = run.call;
				return { content: [{ type: "text", text: typeof run.context.env.cwd }] };
			},
		});
		const { kernel } = journaledKernel(SessionLog.create(new MemoryStorage()));
		kernel.tools.register(toKernelTool(probe, executionContext));
		const fake = fakeModels([
			assistantMessage({
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c1", name: "probe", arguments: {} }],
			}),
			assistantMessage({ content: [{ type: "text", text: "done" }] }),
		]);
		const runner = new Runner(kernel, {
			models: fake,
			toolContext: { env: new NodeEnvironment({ cwd: "/tmp" }) },
		});
		kernel.inject(userMsg("go"));
		await runner.run();
		expect(seen?.toolCallId).toBe("c1");
		expect(seen?.turn).toBeGreaterThan(0);
	});
});

const probeSchema = Type.Object({});
