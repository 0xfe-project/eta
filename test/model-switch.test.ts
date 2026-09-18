import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@eta/core";
import { Host } from "../src/host.ts";

type Payload = { model: string; messages: { role: string; content: unknown }[] };

async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await ready())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the lane to settle");
		await Bun.sleep(10);
	}
}

async function idle(host: Host): Promise<void> {
	await until(async () => {
		for (const session of host.sidebar()) {
			const execution = await host.agentOf(session.name)!.lane.inspectExecution(BACKGROUND_CONTEXT);
			if (execution.running || execution.activeOperation) return false;
		}
		return true;
	});
}

const messageChars = (payload: Payload): number => JSON.stringify(payload.messages).length;

// A conversation written under a window large enough for it, then switched to a model that
// cannot hold it: the switch has to summarize the history first, and what it sends to the new
// model has to fit the window the new model actually has.
async function fixture(
	history: number,
	run: (host: Host, payloads: Payload[], historyChars: number) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "eta-model-switch-"));
	const payloads: Payload[] = [];
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as Payload;
			payloads.push(body);
			const chunk = {
				id: "test",
				object: "chat.completion.chunk",
				created: 1,
				model: body.model,
				choices: [{ index: 0, delta: { role: "assistant", content: "noted" }, finish_reason: "stop" }],
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const host = new Host({ configPath: join(directory, "config.json"), dataDir: join(directory, "sessions"), heartbeatMs: 0 });
	try {
		await writeFile(
			host.configPath,
			JSON.stringify({
				providers: [
					{
						id: "local",
						kind: "openai-compatible",
						baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
						apiKey: "test-only",
						models: [
							{ id: "wide", contextWindow: 200_000 },
							// Eight thousand tokens: less than half of the history written below.
							{ id: "narrow", contextWindow: 8_000 },
							{ id: "roomy", contextWindow: 100_000 },
						],
					},
				],
			}),
		);
		await host.createSession("one", "Thinker", directory);
		await host.modelSet("one", "local:wide");
		for (let turn = 0; turn < history; turn += 1) {
			await host.prompt("one", `turn ${turn}: ${"y".repeat(8000)}`);
			await idle(host);
		}
		// What the wide model was last asked to hold: the whole history, unsummarized.
		const written = messageChars(payloads[payloads.length - 1]!);
		payloads.length = 0;
		await run(host, payloads, written);
	} finally {
		try {
			await idle(host);
		} finally {
			try {
				await host.close();
			} finally {
				upstream.stop(true);
				for (let attempt = 0; attempt < 8; attempt++) {
					try {
						await rm(directory, { recursive: true, force: true });
						break;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 7) throw error;
						await Bun.sleep(25);
					}
				}
			}
		}
	}
}

describe("switching to a smaller context window", () => {
	it("compacts the history it wrote under the wider window", async () => {
		await fixture(6, async (host, payloads, historyChars) => {
			const epoch = host.viewOf("one")!.compactionEpoch;
			await host.modelSet("one", "local:narrow");
			await idle(host);

			// The switch itself summarizes: no request carrying the whole history is sent to the
			// model that refused it.
			const summarization = payloads.filter((payload) => messageChars(payload) > 0 && JSON.stringify(payload.messages).includes("<conversation>"));
			expect(summarization.length).toBeGreaterThan(1);
			for (const payload of summarization) {
				// One window's worth, tokens measured the way the estimator measures them.
				expect(messageChars(payload)).toBeLessThanOrEqual(4 * 8_000);
			}

			// The transcript now carries a compaction rather than the raw history.
			await until(() => host.viewOf("one")!.compactionEpoch > epoch);

			// And what the narrow model is asked next is the summary plus a tail: less than the
			// history it replaced, and not another summarization of it.
			await host.prompt("one", "after the switch");
			await idle(host);
			const next = payloads[payloads.length - 1]!;
			const carried = JSON.stringify(next.messages);
			expect(carried).toContain("after the switch");
			expect(carried).not.toContain("<conversation>");
			expect(messageChars(next)).toBeLessThan(historyChars);
		});
	}, 30_000);

	it("leaves a history the new window can hold alone", async () => {
		await fixture(6, async (host, payloads) => {
			await host.modelSet("one", "local:roomy");
			await idle(host);
			expect(payloads).toHaveLength(0);
			await Bun.sleep(50);
			expect(host.viewOf("one")!.compactionEpoch).toBe(0);
		});
	}, 30_000);
});
