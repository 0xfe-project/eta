import { describe, expect, it } from "vitest";
import { connectTest } from "@gpuix/react/automation";
import { createTestRoot, hasNativeTestRenderer } from "@gpuix/react/testing";
import type { GuiOps, TaskStatus } from "../src/app.tsx";
import { EtaApp, noOps } from "../src/app.tsx";
import { fakeFeed } from "../src/fake.ts";

const describeNative = hasNativeTestRenderer ? describe : describe.skip;

describeNative("G0 layout", () => {
	it("renders sidebar, timeline, Context/Dev tabs and composer", async () => {
		const feed = fakeFeed();
		const { render, renderer } = createTestRoot();
		render(<EtaApp sessions={feed.sessions} active="eta-main" view={feed.view} dev={feed.dev} ops={noOps} />);
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
		expect(painted.some((line) => line.startsWith("turn"))).toBe(true);
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

describeNative("G2-G6 panels", () => {
	it("Context tab paints goal card, tasks, loops, memory and fleet; ask modal shows options", async () => {
		const feed = fakeFeed();
		const { render, renderer } = createTestRoot();
		render(<EtaApp sessions={feed.sessions} active="eta-main" view={feed.view} dev={feed.dev} ops={noOps} defaultTab="context" />);
		await connectTest(renderer);
		const painted = renderer.getPaintedText();
		expect(painted.some((line) => line.includes("goal: paint the window"))).toBe(true);
		expect(painted).toContain("pause");
		expect(painted).toContain("resume");
		expect(painted).toContain("clear");
		expect(painted).toContain("write the thing");
		expect(painted).toContain("pending");
		expect(painted).toContain("check ci");
		expect(painted).toContain("/20000");
		expect(painted).toContain("a1");
		expect(painted).toContain("running");
		expect(painted).toContain("compact");
		expect(painted).toContain("which theme?");
		expect(painted).toContain("dark");
		expect(painted).toContain("light");
		expect(painted).toContain("decline");
	});

	it("ops fire back: composer submit prompts the host and focus switches pointer", async () => {
		const { Host } = await import("../src/host.ts");
		const { makeFauxAgent } = await import("../src/faux-agent.ts");
		const { LiveApp } = await import("../src/main.tsx");
		const host = new Host();
		await host.open("eta-main", () => makeFauxAgent("eta-main"));
		await host.open("side", () => makeFauxAgent("side"));
		const { render, renderer } = createTestRoot();
		render(<LiveApp host={host} />);
		const app = await connectTest(renderer);
		await app.getByTestId("session-side").click();
		expect(host.attachPointer).toBe("side");
		const composer = app.getByTestId("composer");
		await composer.fill("paint it");
		await composer.press("enter");
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if ((host.viewOf("side")?.messages.length ?? 0) >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(host.viewOf("side")?.messages.length).toBeGreaterThanOrEqual(2);
		await host.close();
	});
});

describeNative("L2 timeline rows", () => {
	it("paints tool call code, tool result, thinking, transient rows and sideThread", async () => {
		const feed = fakeFeed();
		const { render, renderer } = createTestRoot();
		render(<EtaApp sessions={feed.sessions} active="eta-main" view={feed.view} dev={feed.dev} ops={noOps} defaultTab="context" />);
		await connectTest(renderer);
		const painted = renderer.getPaintedText();
		const has = (needle: string) => painted.some((line) => line.includes(needle));
		expect(has("⚙ TaskCreate")).toBe(true);
		expect(has('\"content\":\"write the thing\"')).toBe(true);
		expect(has("↳ TaskCreate")).toBe(true);
		expect(has("Created t1.")).toBe(true);
		expect(has("pick a tool first")).toBe(true);
		expect(has("loop · fired")).toBe(true);
		expect(has("btw b1 · tangent · 1 exchanges · not-saved")).toBe(true);
	});

	it("clicking a task row cycles its status through ops", async () => {
		const feed = fakeFeed();
		const calls: [string, TaskStatus][] = [];
		const ops: GuiOps = { ...noOps, taskSet: (id, status) => calls.push([id, status]) };
		const { render, renderer } = createTestRoot();
		render(<EtaApp sessions={feed.sessions} active="eta-main" view={feed.view} dev={feed.dev} ops={ops} defaultTab="context" />);
		const app = await connectTest(renderer);
		await app.getByTestId("task-t1").click();
		expect(calls).toEqual([["t1", "in_progress"]]);
	});

	it("dev rail paints every event category", async () => {
		const feed = fakeFeed();
		const categories = ["lifecycle", "turn", "usage", "prompt", "compaction", "loop", "goal", "memory", "skill", "todo", "state", "tool", "retry", "ask_user", "btw"];
		feed.dev = categories.map((category, index) => ({ ts: index, session: "eta-main", category, action: `act-${category}`, data: {} }));
		const { render, renderer } = createTestRoot();
		render(<EtaApp sessions={feed.sessions} active="eta-main" view={feed.view} dev={feed.dev} ops={noOps} />);
		await connectTest(renderer);
		const painted = renderer.getPaintedText();
		for (const category of categories) {
			expect(painted.some((line) => line.includes(`${category} · act-${category}`))).toBe(true);
		}
	});
});
