import { describe, expect, it, mock } from "bun:test";
import { BACKGROUND_CONTEXT } from "@eta/core";
import { Host } from "../src/host.ts";
import { applyOp } from "../src/server.ts";

// Exercise the real op dispatcher and Host queue routing with a recording lane.
// No provider requests or persistent sessions are needed at this boundary.
describe("prompt image forwarding", () => {
	for (const [running, mode, target] of [
		[false, "queue", "prompt"], [true, "queue", "followUp"], [true, "steer", "steer"],
	] as const) {
		it(`forwards images to ${target}`, async () => {
			const lane = { prompt: mock(async () => {}), followUp: mock(async () => {}), steer: mock(async () => {}) };
			const host = Object.assign(Object.create(Host.prototype), {
				hosted: new Map([["s1", { running, agent: { lane } }]]),
			}) as Host;
			await applyOp(host, { op: "prompt", session: "s1", text: "inspect @shot.png", mode,
				images: [{ mime: "image/png", dataBase64: "aW1hZ2U=" }] });
			expect(lane[target]).toHaveBeenCalledWith("inspect @shot.png", [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }], BACKGROUND_CONTEXT);
			expect(Object.values(lane).reduce((sum, fn) => sum + fn.mock.calls.length, 0)).toBe(1);
		});
	}
	for (const prompt of [undefined, "inspect image"]) {
		it(`starts a newly created session with images (${prompt ?? "image only"})`, async () => {
			const queue = mock(() => {});
			const createSession = mock(async () => {});
			const host = { createSession, queue } as unknown as Host;
			const images = [{ mime: "image/png", dataBase64: "aW1hZ2U=" }];
			await applyOp(host, { op: "session.create", name: "new", personaId: "Thinker", images, ...(prompt === undefined ? {} : { prompt }) });
			expect(createSession).toHaveBeenCalledTimes(1);
			expect(queue).toHaveBeenCalledWith("new", prompt ?? "", "queue", images);
		});
	}

	it("keeps text file references intact without manufacturing attachments", async () => {
		const prompt = mock(async () => {});
		const host = Object.assign(Object.create(Host.prototype), {
			hosted: new Map([["s1", { running: false, agent: { lane: { prompt } } }]]),
		}) as Host;
		await applyOp(host, { op: "prompt", session: "s1", text: "read @README.md" });
		expect(prompt).toHaveBeenCalledWith("read @README.md", undefined, BACKGROUND_CONTEXT);
	});
});
