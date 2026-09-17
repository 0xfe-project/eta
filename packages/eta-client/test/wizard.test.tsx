// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@solidjs/router";
import { etaStore } from "../src/lib/eta-store.ts";
import { Welcome } from "../src/features/sessions/welcome.tsx";
import { byId, findId, queryId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { cleanup, click, fireEvent, flush, keyDown, render, setField } from "./render.tsx";
import { MemoryRouter } from "./memory-router.tsx";

/**
 * `/new` renders the same `Welcome` surface the empty sessions page shows, so these specs
 * are about the two things the route adds: the way back, and the folder it hands over.
 */
async function mountWizard(initial = "/new") {
	const { NewSessionPage } = await import("../src/pages/new-session-page.tsx");
	render(
		<MemoryRouter initial={initial}>
			<Route path="/new" component={NewSessionPage} />
			<Route path="/" component={() => <div data-testid="home">home</div>} />
		</MemoryRouter>,
	);
}

const personas = [
	{ id: "Thinker", name: "Thinker", description: "INTP card" },
	{ id: "Executor", name: "Executor", description: "doer card" },
];

describe("new session surface", () => {
	// Every spec mounts a listener on `window` (personas, settings, the shell's ⌘O), so the
	// tree from the one before it must be gone or the next assertion answers for both.
	afterEach(cleanup);

	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => ({
				ok: true,
				json: async () => personas,
			})),
		);
	});

	it("needs a persona before a session can open empty, and sends session.create", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		expect(byId("persona-chips").children).toHaveLength(2);
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(true);

		click("persona-Executor");
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(false);
		click("create-session");

		expect(FakeSocket.last()).toMatchObject({ op: "session.create", personaId: "Executor" });
		expect(queryId("home")).toBeNull();
		const name = FakeSocket.last().name;
		flush(() => FakeSocket.instances.at(-1)!.fire("message", { data: JSON.stringify({ type: "created", name }) }));
		expect(etaStore().snapshot().attach).toBe(name);
		expect(await findId("home")).toBeTruthy();
	});

	it("sends a first message without a persona and lets the server pick", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		// Nothing picked yet, so the line above the composer explains what sending will do.
		expect(byId("persona-hint").textContent!.trim().length).toBeGreaterThan(0);
		setField("composer-input", "帮我把这个模块拆开");
		click("composer-submit");

		const sent = FakeSocket.last() as Record<string, unknown>;
		expect(sent).toMatchObject({ op: "session.create", prompt: "帮我把这个模块拆开" });
		expect("personaId" in sent).toBe(false);
	});

	for (const text of ["", "请分析截图"]) {
		it(`creates a session with a pasted image and ${text ? "text" : "no text"}`, async () => {
			await mountWizard();
			await findId("persona-Thinker");
			setField("composer-input", text);
			fireEvent.paste(byId("composer-input"), { clipboardData: { files: [new File(["image bytes"], "shot.png", { type: "image/png" })] } });
			await findId("attach-chip-0");
			expect((byId("composer-input") as HTMLTextAreaElement).value).toBe(text);
			expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/upload"))).toBe(false);
			click("composer-submit");
			expect(FakeSocket.last()).toMatchObject({ op: "session.create", images: [{ mime: "image/png", dataBase64: btoa("image bytes") }] });
			if (text) expect(FakeSocket.last().prompt).toBe(text);
			// A failed creation must leave the image available for a retry.
			flush(() => FakeSocket.instances.at(-1)!.fire("message", { data: JSON.stringify({ type: "error", message: "Try again" }) }));
			expect(byId("attach-chip-0")).toBeTruthy();
			click("composer-submit");
			expect(FakeSocket.last()).toMatchObject({ op: "session.create", images: [{ mime: "image/png", dataBase64: btoa("image bytes") }] });
		});
	}

	it("keeps the old session until creation succeeds, then focuses the new first-prompt session", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		const socket = FakeSocket.instances.at(-1)!;
		const receive = (frame: unknown) => flush(() => socket.fire("message", { data: JSON.stringify(frame) }));
		receive({ type: "hello", sessions: [{ name: "old", badges: [], personas: [] }], attach: "old" });
		setField("composer-input", "First prompt");
		click("composer-submit");
		const name = FakeSocket.last().name;
		expect(etaStore().snapshot().attach).toBe("old");
		expect(queryId("home")).toBeNull();
		receive({ type: "created", name: "another-client" });
		expect(etaStore().snapshot().attach).toBe("old");
		receive({ type: "created", name });
		expect(etaStore().snapshot().attach).toBe(name);
		expect(FakeSocket.last()).toEqual({ op: "focus", session: name });
		expect(await findId("home")).toBeTruthy();
	});

	it("stays on the new page and allows retry after a create error", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		click("persona-Thinker");
		setField("composer-input", "Retry this prompt");
		click("composer-submit");
		flush(() => FakeSocket.instances.at(-1)!.fire("message", { data: JSON.stringify({ type: "error", message: "Creation failed" }) }));
		expect(queryId("home")).toBeNull();
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(false);
		expect((byId("composer-input") as HTMLTextAreaElement).value).toBe("Retry this prompt");
		click("composer-submit");
		expect(FakeSocket.last()).toMatchObject({ op: "session.create", prompt: "Retry this prompt" });
	});

	it("sends the folder with the session, and writes it back as the default when asked", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		setField("composer-cwd", "/work/eta");
		click("cwd-remember");
		click("persona-Thinker");
		click("create-session");

		expect(FakeSocket.last()).toMatchObject({ op: "session.create", personaId: "Thinker", cwd: "/work/eta" });
		const posted = vi
			.mocked(fetch)
			.mock.calls.filter(([input, init]) => String(input).endsWith("/api/settings") && (init as RequestInit | undefined)?.method === "POST");
		expect(posted.map(([input, init]) => [String(input), (init as RequestInit).body])).toContainEqual(["/api/settings", JSON.stringify({ cwd: "/work/eta" })]);
	});

	it("takes the folder of the group that asked, and says so under the composer", async () => {
		await mountWizard(`/new?cwd=${encodeURIComponent("/work/from-group")}`);
		await findId("persona-Thinker");
		expect((byId("composer-cwd") as HTMLInputElement).value).toBe("/work/from-group");
		expect(byId("cwd-hint").textContent).toContain("/work/from-group");
	});

	it("gives the transcript area back when closed", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		// A browser tab has no folder dialog to reach, so it gets no dead button for one.
		expect(queryId("cwd-browse")).toBeNull();
		click("new-close");
		expect(await findId("home")).toBeTruthy();
	});

	it("wears the same chrome as the session it steps in front of", async () => {
		await mountWizard();
		await findId("sidebar");
		expect(queryId("drawer-right")).not.toBeNull();

		// …and the list is a way out: picking a session focuses it and leaves `/new`.
		const socket = FakeSocket.instances.at(-1)!;
		flush(() => socket.fire("open", {}));
		flush(() => socket.fire("message", { data: JSON.stringify({ type: "hello", sessions: [{ name: "s1", badges: [], personas: [], cwd: "/work/chrome" }], attach: "s1" }) }));
		await findId("session-row-s1");
		click("session-row-s1");
		expect(FakeSocket.last()).toMatchObject({ op: "focus", session: "s1" });
		expect(await findId("home")).toBeTruthy();
	});
});


describe("remote session models", () => {
	let remoteModels = true;
	let preferredPersona: string | undefined = "Thinker";
	let lateLocal: Promise<Response> | undefined;
	beforeEach(() => {
		remoteModels = true;
		preferredPersona = "Thinker";
		lateLocal = undefined;
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const remote = url.startsWith("/api/remote/mini/");
			if (url === "/api/models" && lateLocal) return lateLocal;
			if (url.includes("/api/models")) return Response.json({ models: remote && !remoteModels ? [] : [1, 2].map((n) => ({ id: `${remote ? "remote" : "local"}:${n}`, label: `${remote ? "Remote" : "Local"} ${n}` })), current: `${remote ? "remote" : "local"}:1` });
			if (url.includes("/api/settings")) return Response.json({ personaId: preferredPersona, modelId: `${remote ? "remote" : "local"}:1`, cwd: remote ? "/remote" : "/local" });
			if (url.includes("/api/personas")) return Response.json([{ id: "Thinker", name: "Thinker", description: "test" }]);
			if (url === "/api/remotes") return Response.json([{ id: "mini", name: "Mac mini", host: "mini", status: "connected", projects: ["/remote"] }]);
			if (url.includes("/api/directories")) return Response.json({ path: new URL(url, "http://eta.test").searchParams.get("path") ?? "/remote", parent: "/", directories: [] });
			return Response.json({});
		}));
	});

	async function selectRemote() {
		await vi.waitFor(() => expect(byId("workspace-host").querySelector('option[value="mini"]')).not.toBeNull());
		setField("workspace-host", "mini");
	}

	it("keeps local directory edits without reloading the configured default", async () => {
		render(<Welcome onCreated={() => undefined} onNavigateSettings={() => undefined} />);
		await vi.waitFor(() => expect((byId("composer-cwd") as HTMLInputElement).value).toBe("/local"));
		const settingsCalls = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/settings").length;
		const count = settingsCalls();
		setField("composer-cwd", "");
		await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/personas")).toBe(true));
		expect((byId("composer-cwd") as HTMLInputElement).value).toBe("");
		expect(settingsCalls()).toBe(count);
	});

	it("keeps the unified surface and the remote target from the project link", async () => {
		await mountWizard("/new?cwd=%2Fremote%2Fproject&remote=mini");
		await findId("persona-Thinker");
		await vi.waitFor(() => expect((byId("workspace-host") as HTMLSelectElement).value).toBe("mini"));
		expect(queryId("sidebar")).not.toBeNull();
		expect(queryId("drawer-right")).not.toBeNull();
		expect(document.querySelectorAll('[data-testid="composer-input"]')).toHaveLength(1);
		expect(queryId("composer-cwd")).toBeNull();
		expect(queryId("cwd-input")).toBeNull();
		expect(queryId("persona-grid")).toBeNull();
		expect((byId("remote-directory-path") as HTMLInputElement).value).toBe("/remote/project");
		click("cwd-remember");
		click("create-session");
		expect(FakeSocket.last()).toMatchObject({ op: "session.create", remoteId: "mini", cwd: "/remote/project" });
		expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input) === "/api/settings" && init?.method === "POST")).toBe(false);
	});

	it("retargets device and directory from sidebar groups while already on /new", async () => {
		await mountWizard("/new?cwd=%2Fremote");
		await findId("persona-Thinker");
		const socket = FakeSocket.instances.at(-1)!;
		const sessions = [
			{ name: "local", badges: [], personas: [], cwd: "/remote" },
			{ name: "remote:mini:r1", badges: [], personas: [], cwd: "/remote", remote: { connectionId: "mini", label: "Mac mini", host: "mini", status: "connected" } },
		];
		flush(() => socket.fire("open", {}));
		flush(() => socket.fire("message", { data: JSON.stringify({ type: "hello", sessions, attach: "local" }) }));
		click("project-new-remote-mini-remote");
		await vi.waitFor(() => expect((byId("workspace-host") as HTMLSelectElement).value).toBe("mini"));
		expect((byId("remote-directory-path") as HTMLInputElement).value).toBe("/remote");
		setField("remote-directory-path", "/remote/custom");
		await vi.waitFor(() => expect(byId("cwd-hint").textContent).toContain("/remote/custom"));
		flush(() => socket.fire("message", { data: JSON.stringify({ type: "sessions", sessions }) }));
		expect((byId("remote-directory-path") as HTMLInputElement).value).toBe("/remote/custom");
		click("project-new-remote");
		await vi.waitFor(() => expect((byId("workspace-host") as HTMLSelectElement).value).toBe(""));
		expect((byId("composer-cwd") as HTMLInputElement).value).toBe("/remote");
		expect(queryId("cwd-input")).toBeNull();
		expect(queryId("remote-directory-path")).toBeNull();
	});

	it("lets the remote pick a persona when sending from welcome without a card", async () => {
		preferredPersona = undefined;
		const onCreated = vi.fn();
		render(<Welcome onCreated={onCreated} onNavigateSettings={() => undefined} />);
		await selectRemote();
		await vi.waitFor(() => expect(byId("model-picker").textContent).toContain("Remote 1"));
		setField("composer-input", "Refactor this module");
		keyDown("composer-input", "Enter");
		expect(FakeSocket.last()).toMatchObject({ op: "session.create", remoteId: "mini", cwd: "/remote", prompt: "Refactor this module" });
		expect(FakeSocket.last()).not.toHaveProperty("personaId");
		expect(onCreated).not.toHaveBeenCalled();
		const name = `remote:mini:${FakeSocket.last().name}`;
		flush(() => FakeSocket.instances.at(-1)!.fire("message", { data: JSON.stringify({ type: "created", name }) }));
		expect(onCreated).toHaveBeenCalledWith(name);
		expect(etaStore().snapshot().attach).toBe(name);
	});

	it("lets the remote pick a persona from the new-session first message", async () => {
		preferredPersona = undefined;
		await mountWizard();
		await selectRemote();
		await findId("persona-Thinker");
		setField("composer-input", "Refactor this module");
		click("composer-submit");
		expect(FakeSocket.last()).toMatchObject({ op: "session.create", remoteId: "mini", cwd: "/remote", prompt: "Refactor this module" });
		expect(FakeSocket.last()).not.toHaveProperty("personaId");
		expect(FakeSocket.last()).not.toHaveProperty("modelId");
	});

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
		await findId("persona-Thinker");
		await selectRemote();
		await vi.waitFor(() => expect((byId("create-session") as HTMLButtonElement).disabled).toBe(false));
		click("create-session");
		expect(FakeSocket.last()).toMatchObject({ op: "session.create", remoteId: "mini", cwd: "/remote" });
		expect(FakeSocket.last()).not.toHaveProperty("modelId");
		expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/remote/mini/api/settings")).toBe(true);
	});
});
