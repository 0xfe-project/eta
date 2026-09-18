// @vitest-environment jsdom
/**
 * Forking from the side that asks for it: the chooser lists the messages of the session you are
 * looking at, and clicking one asks the server to branch at that entry id. The assertions stay on
 * the wire — what a click puts on the socket, and what the client does with the answer — because
 * which entries end up in the copy is the server's rule, covered there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@eta/core";
import { FakeSocket } from "./fake-socket.ts";
import { byId } from "./dom.ts";
import { click, keyDown, render, setField } from "./render.tsx";

function userEntry(entryId: string, text: string, at: number, images = 0) {
	return {
		entryId,
		seq: Number(entryId.slice(1)),
		at,
		message: {
			role: "user",
			content: [
				...(text.length > 0 ? [{ type: "text", text }] : []),
				...Array.from({ length: images }, () => ({ type: "image", mimeType: "image/png", data: "abc" })),
			],
			timestamp: at,
		},
	};
}

function viewWith(messages: unknown[]): SessionView {
	return {
		messages,
		systems: [],
		thinking: [],
		queue: [],
		tasks: [],
		loops: [],
		sideThread: [],
		subagents: [],
		stateKeys: [],
		compactionEpoch: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		cacheRate: 0,
		branch: { tipId: null },
		tools: [],
		personas: ["Thinker"],
		model: "local:test",
		thinkingLevel: "off",
		cwd: "/tmp/eta",
		streaming: undefined,
		goal: undefined,
		pendingAsk: undefined,
	} as unknown as SessionView;
}

const MORNING = new Date("2024-01-01T09:00:00").getTime();

async function mountDialog(messages: unknown[]): Promise<void> {
	const { ForkDialog } = await import("../src/features/sessions/fork-dialog.tsx");
	render(<ForkDialog session="s1" view={viewWith(messages)} open onOpenChange={() => undefined} />);
	// The dialog imports the store, which opens the socket on first use.
	await Promise.resolve();
}

function sentOps(): Record<string, unknown>[] {
	return FakeSocket.sent.map((frame) => JSON.parse(String(frame)) as Record<string, unknown>);
}

function rowOrder(): string[] {
	return Array.from(document.querySelectorAll("[data-testid^='fork-row-']")).map(
		(node) => (node.getAttribute("data-testid") ?? "").replace("fork-row-", ""),
	);
}

beforeEach(() => {
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
});

describe("the fork chooser", () => {
	it("lists the messages you can branch at, newest first", async () => {
		await mountDialog([
			userEntry("e1", "first ask", MORNING),
			userEntry("e2", "second ask", MORNING + 60_000),
			userEntry("e3", "third ask", MORNING + 120_000),
		]);
		expect(rowOrder()).toEqual(["e3", "e2", "e1"]);
	});

	it("narrows the list to what you type", async () => {
		await mountDialog([
			userEntry("e1", "rename the parser", MORNING),
			userEntry("e2", "run the tests", MORNING + 60_000),
		]);
		setField("fork-search", "tests");
		expect(rowOrder()).toEqual(["e2"]);
	});

	it("says so when nothing matches, instead of showing an empty box", async () => {
		await mountDialog([userEntry("e1", "rename the parser", MORNING)]);
		setField("fork-search", "nothing like this");
		expect(rowOrder()).toEqual([]);
		expect(byId("fork-empty").textContent).toContain("no message matches");
	});

	it("lists a message that carried only an image", async () => {
		await mountDialog([userEntry("e1", "", MORNING, 2)]);
		expect(rowOrder()).toEqual(["e1"]);
		expect(byId("fork-row-e1").textContent).toContain("2 images");
	});
});

describe("asking for the branch", () => {
	it("sends the entry id the row was built from", async () => {
		await mountDialog([userEntry("e1", "first ask", MORNING), userEntry("e2", "second ask", MORNING + 60_000)]);
		FakeSocket.sent = [];
		click("fork-row-e1");
		const fork = sentOps().find((frame) => frame.op === "session.fork");
		expect(fork).toMatchObject({ op: "session.fork", from: "s1", entryId: "e1" });
		expect(typeof fork?.name).toBe("string");
	});

	it("moves to the branch once the server says it exists — not before", async () => {
		const { forkFromMessage } = await import("../src/lib/fork.ts");
		FakeSocket.sent = [];
		forkFromMessage("s1", "e1");
		// The store opens its socket when it is first asked for anything, so the socket to
		// answer on is only knowable after the request went out.
		const socket = FakeSocket.instances.at(-1);
		if (socket === undefined) throw new Error("the store did not open a socket");
		const fork = sentOps().find((frame) => frame.op === "session.fork") as { name: string };
		// The transcript stays where it was while the answer is outstanding.
		expect(sentOps().some((frame) => frame.op === "focus")).toBe(false);

		socket.fire("message", { data: JSON.stringify({ type: "created", name: fork.name }) });
		expect(sentOps().find((frame) => frame.op === "focus")).toMatchObject({ op: "focus", session: fork.name });
	});

	it("does not move when the fork was refused", async () => {
		const { forkFromMessage } = await import("../src/lib/fork.ts");
		FakeSocket.sent = [];
		forkFromMessage("s1", "e1");
		const socket = FakeSocket.instances.at(-1);
		if (socket === undefined) throw new Error("the store did not open a socket");
		socket.fire("message", { data: JSON.stringify({ type: "error", message: "no such session: s1" }) });
		expect(sentOps().some((frame) => frame.op === "focus")).toBe(false);
	});
});

describe("forking from a message", () => {
	it("offers the action on a user bubble and names the entry it was clicked on", async () => {
		const { Timeline } = await import("../src/features/sessions/timeline.tsx");
		const picked: string[] = [];
		render(
			<Timeline
				view={viewWith([userEntry("e7", "branch from here", MORNING)])}
				session="s1"
				onFork={(entryId) => picked.push(entryId)}
			/>,
		);
		click("msg-fork");
		expect(picked).toEqual(["e7"]);
	});

	it("leaves the action off when nothing is listening", async () => {
		const { Timeline } = await import("../src/features/sessions/timeline.tsx");
		render(<Timeline view={viewWith([userEntry("e7", "no branch here", MORNING)])} session="s1" />);
		expect(document.querySelector("[data-testid='msg-fork']")).toBeNull();
	});
});

describe("the composer command", () => {
	it("/fork raises the chooser instead of sending a message", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		const opened: number[] = [];
		render(<Composer session="s1" running={false} hasPendingAsk={false} onFork={() => opened.push(1)} />);
		setField("composer-input", "/fork");
		keyDown("composer-input", "Enter");
		expect(opened).toEqual([1]);
		expect(sentOps().some((frame) => frame.op === "prompt")).toBe(false);
	});
});
