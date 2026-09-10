// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@solidjs/router";
import { byId, queryId } from "./dom.ts";
import { click, flush, keyDown, render, setField } from "./render.tsx";
import { FakeSocket } from "./fake-socket.ts";
import { MemoryRouter } from "./memory-router.tsx";
import { sidebarPrefs } from "../src/lib/prefs.ts";
import { Sidebar } from "../src/features/sessions/sidebar.tsx";

function session(name: string, patch: Record<string, unknown> = {}): unknown {
	return { name, badges: [], personas: [], cwd: "/work/eta", updated: 1_700_000_000_000, ...patch };
}

function mount(sessions: unknown[] = [session("s1")]) {
	render(
		<MemoryRouter>
			<Route path="/" component={() => <Sidebar selected="s1" termActive={false} onTerminal={() => undefined} />} />
		</MemoryRouter>,
	);
	const socket = FakeSocket.instances[0]!;
	flush(() => socket.fire("open", {}));
	const send = (payload: unknown) => flush(() => socket.fire("message", { data: JSON.stringify(payload) }));
	send({ type: "hello", sessions, attach: "s1" });
	return { socket, send };
}

function press(node: HTMLElement): void {
	node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

describe("sidebar session rows", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, json: () => Promise.resolve([]) } as Response));
		// The prefs module keeps its signal across tests; start each one clean.
		sidebarPrefs.setCollapsed([]);
		sidebarPrefs.setSort("recent");
	});

	it("keeps the row menu open across the sessions frame the server sends after every op", () => {
		const { send } = mount();
		click("session-menu-s1");
		expect(queryId("session-menu-open-s1")).not.toBeNull();

		// Every op makes the host re-emit the whole list. Rebuilding the rows here
		// would throw the open menu away, which is what made ⋯ look dead.
		send({ type: "sessions", sessions: [session("s1", { updated: 1_700_000_000_600_000 })] });
		expect(queryId("session-menu-open-s1")).not.toBeNull();

		click("session-delete-s1");
		expect(FakeSocket.last()).toEqual({ op: "session.delete", name: "s1" });
	});

	it("closes the row menu on an outside press", () => {
		mount([session("s1"), session("s2", { cwd: "/work/other" })]);
		click("session-menu-s1");
		expect(queryId("session-menu-open-s1")).not.toBeNull();
		press(byId("session-list"));
		expect(queryId("session-menu-open-s1")).toBeNull();
	});

	it("lifts pinned sessions into their own group above the projects", () => {
		mount([session("s1", { pinned: true }), session("s2", { cwd: "/work/other" })]);
		expect(queryId("group-pinned")).not.toBeNull();
		// The pinned row is rendered once, in the pinned group, not in its project.
		expect(document.querySelectorAll('[data-testid="session-row-s1"]')).toHaveLength(1);
		expect(byId("group-pinned").textContent).toContain("s1");
		click(`session-menu-s1`);
		click("session-pin-s1");
		expect(FakeSocket.last()).toEqual({ op: "session.pin", session: "s1", pinned: false });
	});

	it("collects sessions without a cwd under ungrouped instead of one group each", () => {
		mount([session("s1", { cwd: undefined }), session("s2", { cwd: undefined })]);
		const group = queryId("group-project-ungrouped");
		expect(group).not.toBeNull();
		expect(group?.textContent).toContain("s1");
		expect(group?.textContent).toContain("s2");
	});

	it("summarises running and unread sessions on the project header", () => {
		const { send } = mount([session("s1", { badges: ["running"] }), session("s2"), session("s3", { cwd: "/work/other" })]);
		// s2 is not the attached session, so a transcript that grows marks it unread.
		send({ type: "view", session: "s2", view: { messages: [] } });
		send({ type: "view", session: "s2", view: { messages: [{ entryId: "e1" }] } });
		const header = byId("group-project-eta");
		expect(queryId("group-project-eta-running")).not.toBeNull();
		expect(header.textContent).toContain("2");
	});

	it("collapses a project and remembers it", () => {
		mount([session("s1"), session("s2", { cwd: "/work/other" })]);
		// Each group folds from its own header; the "fold everything" button is gone,
		// since that corner of the bar now carries the traffic lights.
		click("group-project-eta-toggle");
		expect(queryId("session-row-s1")).toBeNull();
		expect(queryId("session-row-s2")).not.toBeNull();
		click("group-project-other-toggle");
		expect(queryId("session-row-s2")).toBeNull();
		expect(
			(JSON.parse(localStorage.getItem("eta:sidebar:prefs") ?? "{}") as { collapsed?: string[] }).collapsed?.length,
		).toBeGreaterThanOrEqual(2);
		click("group-project-eta-toggle");
		expect(queryId("session-row-s1")).not.toBeNull();
	});

	it("renames through an inline field instead of window.prompt", () => {
		const prompt = vi.fn(() => null);
		vi.stubGlobal("prompt", prompt);
		mount();
		click("session-menu-s1");
		click("session-rename-s1");
		expect(prompt).not.toHaveBeenCalled();
		const input = byId("session-rename-input-s1");
		// Naming means replacing the old title, so the field arrives focused and selected.
		expect(document.activeElement).toBe(input);
		setField("session-rename-input-s1", "fix the sidebar");
		keyDown("session-rename-input-s1", "Enter");
		expect(FakeSocket.last()).toEqual({ op: "session.rename", session: "s1", title: "fix the sidebar" });
		expect(queryId("session-rename-input-s1")).toBeNull();
		void input;
	});

	it("drops an inline rename on Escape without sending anything", () => {
		mount();
		click("session-menu-s1");
		click("session-rename-s1");
		setField("session-rename-input-s1", "discarded");
		keyDown("session-rename-input-s1", "Escape");
		expect(queryId("session-rename-input-s1")).toBeNull();
		expect(FakeSocket.sent.some((raw) => raw.includes("session.rename"))).toBe(false);
	});
});
