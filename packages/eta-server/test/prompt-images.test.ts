import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@eta/core";
import { Host } from "../src/host.ts";
import { applyOp } from "../src/server.ts";

const images = [{ mime: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=" }];
type Payload = { model: string; messages: { role: string; content: unknown }[] };

async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!(await ready())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for model request");
		await Bun.sleep(10);
	}
}

// Like providers.test.ts, run a real Host against a local Chat Completions server.
// Holding its first response lets a second prompt arrive during an actual run.
async function fixture(holdFirst: boolean, run: (host: Host, directory: string, payloads: Payload[], release: () => void) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "eta-prompt-images-"));
	const payloads: Payload[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const body = await request.json() as Payload;
		payloads.push(body);
		if (holdFirst && payloads.length === 1) await gate;
		const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: body.model,
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	} });
	const host = new Host({ configPath: join(directory, "config.json"), dataDir: join(directory, "sessions"), heartbeatMs: 0 });
	try {
		await writeFile(host.configPath, JSON.stringify({ providers: [{ id: "local", kind: "openai-compatible",
			baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "test-only",
			models: [{ id: "vision", contextWindow: 128000, input: ["text", "image"] }] }] }));
		await run(host, directory, payloads, release);
	} finally {
		release();
		try {
			await until(async () => {
				for (const session of host.sidebar()) {
					const execution = await host.agentOf(session.name)!.lane.inspectExecution(BACKGROUND_CONTEXT);
					if (execution.running || execution.activeOperation) return false;
				}
				return true;
			});
		} finally {
			try { await host.close(); }
			finally {
				upstream.stop(true);
				for (let attempt = 0; attempt < 8; attempt++) {
					try { await rm(directory, { recursive: true, force: true }); break; }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 7) throw error; await Bun.sleep(25); }
				}
			}
		}
	}
}

function expectImage(payload: Payload) {
	const user = payload.messages.filter((message) => message.role === "user").at(-1);
	expect(user?.content).toContainEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${images[0]!.dataBase64}` } });
}

describe("prompt image forwarding", () => {
	for (const mode of ["prompt", "queue", "steer"] as const) {
		it(`delivers image content through ${mode}`, async () => {
			await fixture(mode !== "prompt", async (host, directory, payloads, release) => {
				await host.createSession("s1", "Thinker", directory);
				if (mode !== "prompt") {
					await applyOp(host, { op: "prompt", session: "s1", text: "first turn" });
					await until(() => payloads.length === 1);
				}
				await applyOp(host, { op: "prompt", session: "s1", text: "inspect image", mode: mode === "steer" ? "steer" : "queue", images });
				if (mode === "queue") {
					await until(() => host.viewOf("s1")?.queue.some((item) => item.images?.[0]?.dataBase64 === images[0]!.dataBase64) === true);
				}
				release();
				await until(() => payloads.length === (mode === "prompt" ? 1 : 2));
				expectImage(payloads.at(-1)!);
			});
		});
	}
	for (const prompt of [undefined, "inspect image"]) {
		it(`starts a new session with images (${prompt ?? "image only"})`, async () => {
			await fixture(false, async (host, directory, payloads) => {
				await applyOp(host, { op: "session.create", name: "new", personaId: "Thinker", cwd: directory, images,
					...(prompt === undefined ? {} : { prompt }) });
				await until(() => payloads.length === 1);
				expectImage(payloads[0]!);
			});
		});
	}
	it("keeps text file references intact without adding images", async () => {
		await fixture(false, async (host, directory, payloads) => {
			await host.createSession("s1", "Thinker", directory);
			await applyOp(host, { op: "prompt", session: "s1", text: "read @README.md" });
			await until(() => payloads.length === 1);
			expect(payloads[0]!.messages.filter((message) => message.role === "user").at(-1)?.content).toEqual([{ type: "text", text: "read @README.md" }]);
		});
	});
});
