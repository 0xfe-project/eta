// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@solidjs/router";
import { Welcome } from "../src/features/sessions/welcome.tsx";
import { byId, findId, queryId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { click, keyDown, render, setField } from "./render.tsx";
import { MemoryRouter } from "./memory-router.tsx";

async function mountWizard() {
	const { NewSessionPage } = await import("../src/pages/new-session-page.tsx");
	render(
		<MemoryRouter initial="/new">
			<Route path="/new" component={NewSessionPage} />
			<Route path="/" component={() => <div data-testid="home">home</div>} />
		</MemoryRouter>,
	);
}

describe("new session wizard", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => ({
				ok: true,
				// The native endpoints answer with an object; everything else with personas.
				json: async () =>
					String(input).includes("/api/native/")
						? { path: "/picked/dir" }
						: [
								{ id: "Thinker", name: "Thinker", description: "INTP card" },
								{ id: "Executor", name: "Executor", description: "doer card" },
							],
			})),
		);
	});

	it("requires a persona before create is possible and sends session.create", async () => {
		await mountWizard();
		await findId("persona-card-Thinker");
		expect(byId("persona-grid").children).toHaveLength(2);
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(true);
		expect(queryId("persona-required")).not.toBeNull();

		click("persona-card-Executor");
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(false);
		click("create-session");

		expect(FakeSocket.last()).toMatchObject({ op: "session.create", personaId: "Executor" });
		expect(await findId("home")).toBeTruthy();
	});

	it("gives the transcript area back when closed", async () => {
		await mountWizard();
		await findId("persona-card-Thinker");
		// A browser tab has no folder dialog to reach, so it gets no dead button for one.
		expect(queryId("cwd-browse")).toBeNull();
		click("new-close");
		expect(await findId("home")).toBeTruthy();
	});
});


describe("remote session models", () => {
	let remoteModels = true;
	let lateLocal: Promise<Response> | undefined;
	beforeEach(() => {
		remoteModels = true;
		lateLocal = undefined;
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const remote = url.startsWith("/api/remote/mini/");
			if (url === "/api/models" && lateLocal) return lateLocal;
			if (url.includes("/api/models")) return Response.json({ models: remote && !remoteModels ? [] : [1, 2].map((n) => ({ id: `${remote ? "remote" : "local"}:${n}`, label: `${remote ? "Remote" : "Local"} ${n}` })), current: `${remote ? "remote" : "local"}:1` });
			if (url.includes("/api/settings")) return Response.json({ personaId: "Thinker", modelId: `${remote ? "remote" : "local"}:1`, cwd: remote ? "/remote" : "/local" });
			if (url.includes("/api/personas")) return Response.json([{ id: "Thinker", name: "Thinker", description: "test" }]);
			if (url === "/api/remotes") return Response.json([{ id: "mini", name: "Mac mini", host: "mini", status: "connected", projects: ["/remote"] }]);
			if (url.includes("/api/directories")) return Response.json({ path: "/remote", parent: "/", directories: [] });
			return Response.json({});
		}));
	});

	async function selectRemote() {
		await vi.waitFor(() => expect(byId("workspace-host").querySelector('option[value="mini"]')).not.toBeNull());
		setField("workspace-host", "mini");
	}

	it("drops a local model selection when creating on another machine", async () => {
		render(<Welcome onCreated={() => undefined} onNavigateSettings={() => undefined} />);
		await findId("model-picker");
		click("model-picker");
		click("model-local:2");
		await selectRemote();
		await vi.waitFor(() => expect(byId("model-picker").textContent).toContain("Remote 1"));
		click("model-picker");
		expect(queryId("model-local:1")).toBeNull();
		click("model-remote:2");
		await vi.waitFor(() => expect(byId("persona-Thinker")).toBeTruthy());
		click("persona-Thinker");
		setField("composer-input", "hello");
		keyDown("composer-input", "Enter");
		expect(FakeSocket.last()).toMatchObject({ op: "session.create", remoteId: "mini", modelId: "remote:2", cwd: "/remote" });
	});

	it("does not restore a late local catalog when the remote has no models", async () => {
		let finish!: (response: Response) => void;
		lateLocal = new Promise((resolve) => { finish = resolve; });
		remoteModels = false;
		render(<Welcome onCreated={() => undefined} onNavigateSettings={() => undefined} />);
		await selectRemote();
		await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/remote/mini/api/models")).toBe(true));
		finish(Response.json({ models: [{ id: "local:2", label: "Local 2" }], current: "local:2" }));
		await vi.waitFor(() => expect(document.body.textContent).toMatch(/Configure models|配置模型/));
		expect(queryId("model-picker")).toBeNull();
		expect(document.body.textContent).not.toContain("Local 2");
	});

	it("lets the remote server choose its default in the new-session page", async () => {
		await mountWizard();
		await findId("persona-card-Thinker");
		await selectRemote();
		await vi.waitFor(() => expect((byId("create-session") as HTMLButtonElement).disabled).toBe(false));
		click("create-session");
		expect(FakeSocket.last()).toMatchObject({ op: "session.create", remoteId: "mini", cwd: "/remote" });
		expect(FakeSocket.last()).not.toHaveProperty("modelId");
		expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/remote/mini/api/settings")).toBe(true);
	});
});
