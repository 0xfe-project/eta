// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, useSearchParams } from "@solidjs/router";
import type { SidebarSession } from "@eta/core";
import { SessionsPage } from "../src/pages/sessions-page.tsx";
import { etaStore } from "../src/lib/eta-store.ts";
import { sidebarPrefs } from "../src/lib/prefs.ts";
import { byId, findId, queryId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { click, flush, render } from "./render.tsx";
import { MemoryRouter } from "./memory-router.tsx";

function NewPage() {
	const [params] = useSearchParams();
	return <div data-testid="new-page" data-cwd={params.cwd ?? ""} data-remote={params.remote ?? ""} />;
}
const session = (name: string, cwd = "/work/项目 #1"): SidebarSession => ({ name, cwd, badges: [], personas: [] });
function mount(sessions: SidebarSession[], attach = sessions[0]!.name) {
	render(<MemoryRouter><Route path="/" component={SessionsPage} /><Route path="/new" component={NewPage} /></MemoryRouter>);
	const socket = FakeSocket.instances[0]!;
	const receive = (frame: unknown) => flush(() => socket.fire("message", { data: JSON.stringify(frame) }));
	receive({ type: "hello", sessions, attach });
	return receive;
}

beforeEach(() => {
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => [] })));
	sidebarPrefs.setCollapsed([]);
});

describe("active session removal", () => {
	for (const remote of [false, true]) {
		for (const action of ["delete", "archive"] as const) {
			it(`${action} opens a new session in the same ${remote ? "remote" : "local"} workspace after confirmation`, async () => {
				const active = session(remote ? "remote:mini:s1" : "s1");
				if (remote) active.remote = { connectionId: "mini", label: "mini", host: "devbox", status: "connected" };
				const other = session("s2", "/different");
				const receive = mount([active, other]);
				click(`session-menu-${active.name}`);
				click(`session-${action}-${active.name}`);
				expect(queryId("new-page")).toBeNull();
				expect(FakeSocket.last().op).toBe(`session.${action}`);
				receive({ type: "sessions", sessions: action === "delete" ? [other] : [{ ...active, archived: true }, other] });
				const page = await findId("new-page");
				expect(page.getAttribute("data-cwd")).toBe(active.cwd);
				expect(page.getAttribute("data-remote")).toBe(remote ? "mini" : "");
			});
		}
	}

	it("preserves the directory when the last session is deleted", async () => {
		const receive = mount([session("s1")]);
		receive({ type: "sessions", sessions: [] });
		expect((await findId("new-page")).getAttribute("data-cwd")).toBe("/work/项目 #1");
	});

	it("stays on the current page after an error or changes to background sessions", () => {
		const active = session("s1"), other = session("s2");
		const receive = mount([active, other]);
		click("session-menu-s1");
		click("session-delete-s1");
		receive({ type: "error", message: "Deletion failed" });
		receive({ type: "sessions", sessions: [active, { ...other, archived: true }] });
		receive({ type: "sessions", sessions: [active] });
		expect(queryId("new-page")).toBeNull();
		expect(byId("active-session").textContent).toBe("s1");
	});

	it("does not pull the user away after they switch to another session", () => {
		const first = session("s1"), second = session("s2");
		const receive = mount([first, second]);
		etaStore().send({ op: "focus", session: "s2" });
		receive({ type: "sessions", sessions: [second] });
		expect(queryId("new-page")).toBeNull();
		expect(byId("active-session").textContent).toBe("s2");
	});

	it("allows opening and restoring an already archived session", () => {
		const archived = { ...session("s1"), archived: true };
		const receive = mount([archived]);
		receive({ type: "sessions", sessions: [archived] });
		receive({ type: "sessions", sessions: [{ ...archived, archived: false }] });
		expect(queryId("new-page")).toBeNull();
	});
});
