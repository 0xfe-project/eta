import { describe, expect, it } from "vitest";
import { connectTest } from "@gpuix/react/automation";
import { createTestRoot, hasNativeTestRenderer } from "@gpuix/react/testing";
import { EtaApp } from "../src/app.tsx";
import { fakeFeed } from "../src/fake.ts";

const describeNative = hasNativeTestRenderer ? describe : describe.skip;

describeNative("G0 layout", () => {
	it("renders sidebar, timeline, Context/Dev tabs and composer", async () => {
		const feed = fakeFeed();
		const { render, renderer } = createTestRoot();
		render(<EtaApp sessions={feed.sessions} view={feed.view} dev={feed.dev} />);
		await connectTest(renderer);
		const painted = renderer.getPaintedText();
		expect(painted).toContain("sessions");
		expect(painted).toContain("eta-main");
		expect(painted.some((line) => line.includes("hello eta"))).toBe(true);
		expect(painted.some((line) => line.includes("rendering the first frame"))).toBe(true);
		expect(painted).toContain("Context");
		expect(painted).toContain("Dev");
		expect(painted).toContain("ask eta anything…");
		expect(painted).toContain("goal");
		expect(painted).toContain("turn");
	});
});

describeNative("G1 live turn", () => {
	it("paints a real turn streamed through the host", async () => {
		const { Host } = await import("../src/host.ts");
		const { makeFauxAgent } = await import("../src/faux-agent.ts");
		const { LiveApp } = await import("../src/main.tsx");
		const host = new Host();
		await host.open("eta-main", () => makeFauxAgent("eta-main"));
		const { render, renderer } = createTestRoot();
		render(<LiveApp host={host} />);
		const app = await connectTest(renderer);
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (renderer.getPaintedText().some((line) => line.includes("first frame, fed by the real core"))) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
			void app;
		}
		expect(renderer.getPaintedText().some((line) => line.includes("first frame, fed by the real core"))).toBe(true);
		await host.close();
	});
});
