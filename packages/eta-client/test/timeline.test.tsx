// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@eta/core";
import { byId, queryId } from "./dom.ts";
import { click, render } from "./render.tsx";
import { Timeline } from "../src/features/sessions/timeline.tsx";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

let scrolled: string[] = [];

function entry(role: "user" | "assistant", id: string, text: string) {
	return { entryId: id, seq: 0, at: 0, message: { role, content: [{ type: "text", text }] } } as unknown as SessionView["messages"][number];
}

/** A turn with no prose at all: thinking, then two tool calls. */
function toolTurn(id: string, tools: string[]) {
	return {
		entryId: id,
		seq: 0,
		at: 0,
		message: { role: "assistant", content: [{ type: "thinking", thinking: "先看一眼" }, ...tools.map((name) => ({ type: "toolCall", name, arguments: {} }))] },
	} as unknown as SessionView["messages"][number];
}

function view(messages: SessionView["messages"]): SessionView {
	return { messages, systems: [], streaming: undefined } as unknown as SessionView;
}

function renderTimeline(messages: SessionView["messages"]) {
	render(<Timeline view={view(messages)} session="s-1" />);
}

beforeEach(() => {
	scrolled = [];
	Element.prototype.scrollIntoView = function (this: Element) {
		scrolled.push(this.id);
	};
});

describe("timeline jump rail", () => {
	it("navigates agent turns when one prompt set off a long run", () => {
		renderTimeline([
			entry("user", "u1", "去把渲染那条链路查一遍"),
			entry("assistant", "a1", "先看主线程"),
			toolTurn("a2", ["bash", "read"]),
			entry("assistant", "a3", "最后是虚拟列表"),
		]);
		// One prompt has nothing to choose between, so the prompt column stays hidden...
		expect(queryId("prompt-rail")).toBeNull();
		// ...but sixty replies are still worth jumping through.
		expect(byId("turn-rail").children).toHaveLength(3);
		// A turn made only of tool calls still says where it lands.
		expect(byId("turn-rail-2").getAttribute("title")).toContain("bash · read");
		click("turn-rail-2");
		expect(scrolled).toEqual(["eta-msg-a2"]);
	});

	it("keeps a prompt column beside the turn column once there is a choice", () => {
		renderTimeline([
			entry("user", "u1", "第一个问题"),
			entry("assistant", "a1", "答一"),
			entry("user", "u2", "第二个问题,长一点的问题要能看见头几个字才敢点"),
			entry("assistant", "a2", "答二"),
		]);
		expect(byId("prompt-rail").children).toHaveLength(2);
		expect(byId("turn-rail").children).toHaveLength(2);
		expect(byId("prompt-rail-2").getAttribute("title")).toContain("第二个问题");
		// The rail lives in a lane the transcript yields, not on top of the cards.
		expect(byId("timeline").getAttribute("class")).toContain("pr-14");
		click("prompt-rail-2");
		expect(scrolled).toEqual(["eta-msg-u2"]);
	});

	it("renders no rail at all when there is nothing to jump between", () => {
		renderTimeline([entry("user", "u1", "只问了一句"), entry("assistant", "a1", "只答了一句")]);
		expect(queryId("rail")).toBeNull();
		expect(byId("timeline").getAttribute("class")).toContain("pr-6");
	});

	it("marks the number you are looking at once you scroll", async () => {
		renderTimeline([
			entry("user", "u1", "第一个问题"),
			entry("assistant", "a1", "答一"),
			entry("user", "u2", "第二个问题"),
			entry("assistant", "a2", "答二"),
		]);
		// jsdom reports every rect as zero, so hand it the geometry instead: the first
		// three are scrolled past the top edge, a2 is the first thing still on screen.
		const place = (id: string, top: number) => {
			const node = document.getElementById(`eta-msg-${id}`);
			if (node === null) throw new Error(`missing message ${id}`);
			node.getBoundingClientRect = () => ({ top, bottom: top + 10, left: 0, right: 0, width: 0, height: 10, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
		};
		place("u1", -300);
		place("a1", -120);
		place("u2", -10);
		place("a2", 200);
		byId("timeline").dispatchEvent(new Event("scroll"));
		await new Promise((resolve) => requestAnimationFrame(resolve));
		// The last thing scrolled above the fold is the position you are at.
		expect(byId("prompt-rail-2").getAttribute("aria-current")).toBe("true");
		expect(byId("turn-rail-1").getAttribute("aria-current")).not.toBe("true");
	});

	it("samples a long run: both ends, a window around you, coarse jumps elsewhere", async () => {
		const long = [entry("user", "u1", "开个头"), entry("user", "u2", "再补一句")];
		for (let turn = 1; turn <= 40; turn += 1) long.push(entry("assistant", `a${turn}`, `第 ${turn} 次回答`));
		renderTimeline(long);
		// Scroll so that turn 20 is the thing pressed up against the top edge.
		const place = (id: string, top: number) => {
			const node = document.getElementById(`eta-msg-${id}`);
			if (node === null) throw new Error(`missing message ${id}`);
			node.getBoundingClientRect = () => ({ top, bottom: top + 10, left: 0, right: 0, width: 0, height: 10, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
		};
		place("u1", -400);
		place("u2", -300);
		for (let turn = 1; turn <= 40; turn += 1) place(`a${turn}`, -200 + turn * 10);
		byId("timeline").dispatchEvent(new Event("scroll"));
		await new Promise((resolve) => requestAnimationFrame(resolve));

		const rail = byId("turn-rail");
		// Forty turns, and the whole rail still fits: ends pinned, ±3 around turn 20,
		// coarse anchors elsewhere, and every skipped stretch admitted with a ⋯.
		expect(rail.querySelector("button")?.getAttribute("data-testid")).toBe("turn-rail-1");
		expect(queryId("turn-rail-40")).not.toBeNull();
		for (const turn of [17, 18, 19, 20, 21, 22, 23]) expect(queryId(`turn-rail-${turn}`)).not.toBeNull();
		expect(queryId("turn-rail-30")).toBeNull();
		expect(byId("turn-rail-20").getAttribute("aria-current")).toBe("true");
		expect(rail.querySelectorAll("button").length).toBeLessThanOrEqual(20);
		expect(document.querySelectorAll('[data-testid="turn-rail-gap"]').length).toBeGreaterThan(0);
	});

	it("loads older transcript rows from disk on demand", async () => {
		const fakeFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve([entry("user", "u0", "最早的一条")]),
		} as Response);
		vi.stubGlobal("fetch", fakeFetch);
		const v = view([entry("user", "u1", "最近的一条")]) as SessionView & { messagesBefore?: number };
		v.messagesBefore = 5;
		render(<Timeline view={v} session="s-1" />);
		expect(byId("load-earlier")).not.toBeNull();
		click("load-earlier");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fakeFetch).toHaveBeenCalledWith(expect.stringContaining("/api/history?session=s-1&before="));
		expect(document.getElementById("eta-msg-u0")).not.toBeNull();
		expect(document.body.textContent).toContain("最早的一条");
	});
});

describe("a turn that died", () => {
	function failedView(stopReason: string, errorMessage?: string) {
		const message = { role: "assistant", content: [], stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) } as unknown as SessionView["messages"][number]["message"];
		return { messages: [{ entryId: "a1", seq: 0, at: 0, message }] as SessionView["messages"], systems: [], streaming: undefined } as unknown as SessionView;
	}

	it("says why instead of showing an empty bubble", () => {
		render(<Timeline view={failedView("error", '400: {"message":"Failed to load image"}')} session="s-1" />);
		expect(byId("message-error-detail").textContent).toContain("Failed to load image");
	});

	it("still speaks when the provider stays silent", () => {
		render(<Timeline view={failedView("aborted")} session="s-1" />);
		expect(byId("message-error-detail").textContent!.trim().length).toBeGreaterThan(0);
	});

	it("stays out of the way when the turn is fine", () => {
		render(<Timeline view={failedView("stop")} session="s-1" />);
		expect(queryId("message-error")).toBeNull();
	});

	it("keeps the line breaks the author typed in a user bubble", () => {
		// jsdom runs no stylesheets, so the guard is the rule itself: the bubble is
		// plain text, and the one thing the CSS owes it is the newlines it was given.
		const relative = "src/styles/graphite.css";
		let dir = process.cwd();
		for (let depth = 0; depth < 4; depth++) {
			for (const candidate of [relative, join("packages/eta-client", relative)]) {
				const path = join(dir, candidate);
				if (existsSync(path)) {
					const css = readFileSync(path, "utf8");
					const rule = css.slice(css.indexOf(".message.user .message-content {"));
					expect(rule.slice(0, rule.indexOf("}"))).toMatch(/white-space:\s*pre-wrap/);
					return;
				}
			}
			dir = dirname(dir);
		}
		throw new Error(`${relative} 不在测试能找到的地方`);
	});
});
