// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "./fake-socket.ts";
import { render } from "./render.tsx";
import {
	cancelQueued,
	pullBackQueued,
	registerDraftSink,
	returnToDraft,
	steerQueued,
} from "../src/lib/queue-actions.ts";

/**
 * The queue chip buttons, and the one rule they all obey: act only on the `ack` that
 * says the entry was still there. A run drains its queue at tool boundaries, so a
 * chip disappearing proves nothing on its own — and a button that re-injects a
 * message the run already took sends it twice, which is worse than a button that did
 * nothing.
 *
 * Frames go through the fake socket rather than a hand-made window event, so the
 * store's dispatch is covered too: that dispatch is the only thing connecting the
 * wire's `queueAck` to these waiters. Assertions are scoped to this test's own
 * container, because a previous test's composer can well still be in the document.
 */

const ITEM = { entryId: "e1", kind: "followUp", text: "先看 test" };
const IMAGE_ITEM = { ...ITEM, images: [{ mime: "image/png", dataBase64: "abc123" }] };

interface Mounted {
	socket: FakeSocket;
	box: HTMLTextAreaElement;
}

/** The store is a singleton, so the socket is opened once per test however many
 * composers mount; the first mount captures it for the rest. */
let SOCKET: FakeSocket | undefined;

async function mountComposer(running = true): Promise<Mounted> {
	const { Composer } = await import("../src/features/sessions/composer.tsx");
	const view = render(<Composer session="s1" running={running} hasPendingAsk={false} />);
	SOCKET = FakeSocket.instances.at(-1) ?? SOCKET;
	if (SOCKET === undefined) throw new Error("the store did not open a socket");
	// Only the traffic is dropped — the instance list is where SOCKET came from.
	FakeSocket.sent = [];
	// Scoped to this render, and not to `document`: the harness reuses one container
	// across tests, so a document-wide query can answer with a composer from a test
	// that already finished — which is how this file briefly appeared to fail.
	const box = view.queryByTestId("composer-input") as HTMLTextAreaElement | null;
	if (box === null) throw new Error("the composer did not mount");
	return { socket: SOCKET, box };
}

function ack(target: Mounted, outcome: string): void {
	target.socket.fire("message", {
		data: JSON.stringify({ type: "queueAck", session: "s1", entryId: ITEM.entryId, outcome }),
	});
}

/** Let the ack's promise chain and Solid's render pass both run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Type into one specific box — `setField` from dom.ts queries the whole document,
 * and more than one composer is mounted in some of these. */
function type(box: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	setter?.call(box, value);
	box.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
}

/** Each test gets its own store (setup.ts resets it), so its own socket — and its own
 * empty box, because the composer restores a per-session draft from localStorage and
 * every test here uses session "s1". */
beforeEach(() => {
	SOCKET = undefined;
	localStorage.removeItem("eta.draft.s1");
});

describe("queue chip actions", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
	});

	it("asks the lane to drop the entry first, and sends nothing before the answer", async () => {
		await mountComposer();
		void steerQueued("s1", ITEM);
		await settled();
		expect(FakeSocket.sent.map((raw) => JSON.parse(String(raw)).op)).toEqual(["queueRemove"]);
	});

	it("steers once the lane confirms it took the entry out", async () => {
		const target = await mountComposer();
		const done = steerQueued("s1", ITEM);
		await settled();
		ack(target, "cancelled");
		await done;
		expect(FakeSocket.last()).toMatchObject({ op: "prompt", text: "先看 test", mode: "steer" });
	});

	it("sends nothing when the run got there first", async () => {
		const target = await mountComposer();
		const done = steerQueued("s1", ITEM);
		await settled();
		const before = FakeSocket.sent.length;
		ack(target, "already_consumed");
		await done;
		expect(FakeSocket.sent).toHaveLength(before);
	});

	it("does nothing at all when no answer comes", async () => {
		vi.useFakeTimers();
		try {
			await mountComposer();
			const answer = cancelQueued("s1", ITEM.entryId);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(await answer).toBe("no-ack");
			expect(FakeSocket.sent).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("pulling an entry back into the composer", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
	});

	it("types it into the box once the lane confirms", async () => {
		const target = await mountComposer();
		const done = pullBackQueued("s1", ITEM);
		await settled();
		ack(target, "cancelled");
		await done;
		await settled();
		expect(target.box.value).toBe("先看 test");
	});

	it("restores queued images into the composer attachments", async () => {
		const target = await mountComposer();
		const done = pullBackQueued("s1", IMAGE_ITEM);
		await settled();
		ack(target, "cancelled");
		await done;
		await settled();
		expect(target.box.value).toBe("先看 test");
		expect(document.querySelector('[data-testid="attach-chips"] img')?.getAttribute("src")).toBe("data:image/png;base64,abc123");
	});

	it("keeps what was already being typed, below it and one line down", async () => {
		const target = await mountComposer();
		type(target.box, "我自己的半句话");
		const done = pullBackQueued("s1", ITEM);
		await settled();
		ack(target, "cancelled");
		await done;
		await settled();
		expect(target.box.value).toBe("先看 test\n\n我自己的半句话");
	});

	it("leaves the draft alone when the entry had already gone out", async () => {
		const target = await mountComposer();
		type(target.box, "我自己的半句话");
		const done = pullBackQueued("s1", ITEM);
		await settled();
		ack(target, "already_consumed");
		await done;
		await settled();
		expect(target.box.value).toBe("我自己的半句话");
	});

	it("hands it to the composer that mounted last, and survives the others going away", () => {
		// The empty sessions page keeps a welcome composer alive behind the real one,
		// so "whoever picks it up first" would be a coin toss the user can see. And an
		// older composer unmounting must not hand the text to a component that has
		// already gone away — the shape that broke when this was a restore-the-previous.
		const received: string[] = [];
		const offBehind = registerDraftSink((draft) => received.push(`behind:${draft.text}`));
		const offFront = registerDraftSink((draft) => received.push(`front:${draft.text}`));
		expect(returnToDraft({ text: "a" })).toBe(true);
		expect(received).toEqual(["front:a"]);
		offBehind();
		returnToDraft({ text: "b" });
		expect(received).toEqual(["front:a", "front:b"]);
		offFront();
		// Not "nobody received it": other tests leave composers mounted, and one of
		// them is a legitimate sink. What matters is that neither of ours did.
		const before = received.length;
		returnToDraft({ text: "c" });
		expect(received).toHaveLength(before);
	});
});
