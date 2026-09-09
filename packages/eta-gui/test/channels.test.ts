import { describe, expect, it } from "vitest";
import type { HarnessEventPayload } from "@eta/core";
import { decodeFrame, DevRing, encodeFrame, type ChannelFrame } from "../src/channels.ts";
import { emptyView } from "../src/fake.ts";

describe("channel contract", () => {
	it("every channel frame survives a JSON roundtrip", () => {
		const event: HarnessEventPayload = { type: "eta", category: "goal", action: "set", data: { objective: "ship" } };
		const frames: ChannelFrame[] = [
			{ channel: "view", view: emptyView() },
			{ channel: "agent", event },
			{ channel: "dev", frame: { ts: 1, session: "s", category: "loop", action: "fired", data: { id: "l1" } } },
		];
		for (const frame of frames) {
			expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
		}
	});

	it("dev ring keeps the last N frames and filters", () => {
		const ring = new DevRing(3);
		for (const [index, category] of ["turn", "tool", "goal", "loop"].entries()) {
			ring.push({ ts: index, session: "s", category, action: "x", data: {} });
		}
		expect(ring.tail().map((f) => f.category)).toEqual(["tool", "goal", "loop"]);
		expect(ring.tail("tool").map((f) => f.category)).toEqual(["tool"]);
	});
});
