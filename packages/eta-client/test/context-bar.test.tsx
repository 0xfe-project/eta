// @vitest-environment jsdom
/**
 * The queue chip: which verbs a waiting message offers.
 *
 * The set is not cosmetic. An entry that is already in the steering queue cannot be
 * steered again, so it gets two buttons where a follow-up gets three — and the chip
 * has to say which kind it is, or the missing one reads as a broken row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@eta/core";
import { FakeSocket } from "./fake-socket.ts";
import { render } from "./render.tsx";

type Queued = SessionView["queue"][number];

function viewWith(queue: Queued[]) {
	return { queue, loops: [], goal: null, tasks: [] } as unknown as SessionView;
}

function chip(kind: Queued["kind"], entryId: string): Queued {
	return { entryId, kind, text: "先看 test", type: "message" } as unknown as Queued;
}

async function renderBar(queue: Queued[]) {
	const { ContextBar } = await import("../src/features/sessions/context-bar.tsx");
	return render(<ContextBar session="s1" view={viewWith(queue)} />);
}

describe("queue chip actions", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
	});

	it("a waiting follow-up offers all three verbs", async () => {
		const view = await renderBar([chip("followUp", "e1")]);
		expect(view.queryByTestId("queue-steer-e1")).not.toBeNull();
		expect(view.queryByTestId("queue-return-e1")).not.toBeNull();
		expect(view.queryByTestId("queue-drop-e1")).not.toBeNull();
	});

	it("an entry already queued as a steer is not offered a steer again", async () => {
		const view = await renderBar([chip("steer", "e2")]);
		expect(view.queryByTestId("queue-steer-e2")).toBeNull();
		expect(view.queryByTestId("queue-return-e2")).not.toBeNull();
		expect(view.queryByTestId("queue-drop-e2")).not.toBeNull();
	});

	/*
	 * The reason the two rows above are allowed to look different: the chip carries
	 * the queue it belongs to, so an absent button is explained by the prefix rather
	 * than looking like a row that lost a control. Language-independent, because the
	 * test environment picks its own locale — what matters is that the two differ.
	 */
	it("says which queue each entry is waiting in", async () => {
		const view = await renderBar([chip("followUp", "e1"), chip("steer", "e2")]);
		const label = (entryId: string) =>
			view.getByTestId(`queue-${entryId}`).querySelector(".queued-message-chip-text")?.textContent ?? "";
		expect(label("e1")).toContain("先看 test");
		expect(label("e2")).toContain("先看 test");
		expect(label("e1")).not.toBe(label("e2"));
	});
});
