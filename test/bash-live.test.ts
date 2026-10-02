/**
 * The live view of a running command (T6b, eta-agent's AdaptivePublisher +
 * OutputCapture).
 *
 * A command can print faster than anything upstream can consume, so the contract
 * is not "every byte arrives" — it is: the frames are rate-limited, the newest
 * state always wins, the last frame is the whole truth, and a consumer that
 * applies the deltas ends up holding exactly the view the producer had.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellOutputUpdate, ShellOutputView } from "@eta/execution";
import { getOrThrow } from "@eta/execution";
import { applyShellOutputUpdate, OUTPUT_MIN_EMIT_INTERVAL_MS } from "@eta/execution/output";
import { NodeEnvironment } from "@eta/execution-node";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash";
import type { ExecutionToolContext } from "../src/tools/context";
import type { ToolResult } from "../src/tools/tool";

const limits = { maxBytes: 2_048, maxLines: 50, retain: "tail" as const };

/** Where a frame says the full output went (`replace` carries a whole view). */
const spillOf = (update: ShellOutputUpdate): string | undefined =>
	update.kind === "replace" ? update.output.spillPath : update.metadata.spillPath;

async function environment(): Promise<NodeEnvironment> {
	const cwd = await mkdtemp(join(tmpdir(), "eta-live-"));
	return new NodeEnvironment({ cwd });
}

describe("a command that keeps talking", () => {
	it("publishes rate-limited views while it runs, and the last one is the whole output", async () => {
		const env = await environment();
		const updates: ShellOutputUpdate[] = [];
		const started = Date.now();
		const result = getOrThrow(
			await env.exec(
				// 60 lines over ~1.2s: more chunks than a 100ms floor allows frames.
				'for i in $(seq 1 60); do echo "line $i"; sleep 0.02; done',
				{ limits, onUpdate: (update) => updates.push(update) },
			),
		);
		const elapsed = Date.now() - started;

		// The command said 60 things; the client heard far fewer frames than that.
		expect(updates.length).toBeGreaterThan(1);
		expect(updates.length).toBeLessThan(60);
		// And the frames are spaced: the floor bounds both event count and bandwidth.
		expect(updates.length).toBeLessThanOrEqual(Math.ceil(elapsed / OUTPUT_MIN_EMIT_INTERVAL_MS) + 1);

		// Applying the deltas reconstructs exactly what the command printed.
		let view: ShellOutputView | undefined;
		for (const update of updates) view = applyShellOutputUpdate(view, update);
		expect(view?.text).toBe(result.output);
		expect(view?.text).toContain("line 60");
		expect(result.exitCode).toBe(0);
	});

	it("keeps publishing after the output is cut, and names the spill file when it opens one", async () => {
		const env = await environment();
		const updates: ShellOutputUpdate[] = [];
		const result = getOrThrow(
			await env.exec(
				// 400 lines against a 50-line window: the cut lands early, the frames do not stop.
				'for i in $(seq 1 400); do echo "line $i $(printf x%.0s {1..40})"; done',
				{ limits, spill: true, onUpdate: (update) => updates.push(update) },
			),
		);

		// One of the frames after the cut says where the whole output went.
		expect(updates.some((update) => spillOf(update) !== undefined)).toBe(true);
		let view: ShellOutputView | undefined;
		for (const update of updates) view = applyShellOutputUpdate(view, update);
		// The window is the tail, and it still ends where the command did.
		expect(view?.truncation.truncated).toBe(true);
		expect(view?.truncation.totalLines).toBe(400);
		expect(view?.text).toBe(result.output);
		expect(view?.text).toContain("line 400");
		expect(view?.text).not.toContain("line 1 ");
		expect(view?.spillPath).toBe(result.spillPath);
	});

	it("does not send a frame per chunk when a command floods in one burst", async () => {
		const env = await environment();
		const updates: ShellOutputUpdate[] = [];
		const started = Date.now();
		getOrThrow(
			await env.exec('seq 1 5000 | sed "s/^/line /"', { limits, onUpdate: (update) => updates.push(update) }),
		);
		const elapsed = Date.now() - started;
		// 5000 lines, hundreds of chunks, and a frame budget measured in milliseconds.
		expect(updates.length).toBeLessThanOrEqual(Math.ceil(elapsed / OUTPUT_MIN_EMIT_INTERVAL_MS) + 2);
		expect(updates.length).toBeLessThan(100);
		// Every byte of the window that arrived is accounted for in the last frame.
		let view: ShellOutputView | undefined;
		for (const update of updates) view = applyShellOutputUpdate(view, update);
		expect(view?.text).toContain("line 5000");
	});

	it("sends nothing when the caller did not ask for updates", async () => {
		const env = await environment();
		const result = getOrThrow(await env.exec("echo quiet", { limits }));
		expect(result.output).toBe("quiet\n");
	});
});

describe("the tool's live frames", () => {
	it("streams partial results to the running call, and marks checkpoints", async () => {
		const env = await environment();
		const partials: { text: string; checkpoint: boolean }[] = [];
		const result = await createBashTool().execute(
			{ command: 'for i in $(seq 1 40); do echo "tick $i"; sleep 0.05; done' },
			{
				call: { turn: 1, toolCallId: "bash-live", toolContext: { env } satisfies ExecutionToolContext },
				context: { env },
				update: (partial: ToolResult<unknown>, options?: { checkpoint?: boolean }) => {
					const text = partial.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
					partials.push({ text, checkpoint: options?.checkpoint === true });
				},
			},
		);

		// The call is announced before the command says anything…
		expect(partials[0]?.text).toBe("");
		// …then fills in, with the last frame holding everything the command printed.
		expect(partials.at(-1)?.text).toContain("tick 40");
		expect(JSON.stringify(result.content)).toContain("tick 40");
		// A two-second command earns at least one checkpoint frame.
		expect(partials.some((partial) => partial.checkpoint)).toBe(true);
		expect(partials.length).toBeGreaterThan(2);
	});
});
