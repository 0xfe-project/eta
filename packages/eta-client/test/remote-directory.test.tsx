// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { byId, queryId } from "./dom.ts";
import { fireEvent, render } from "./render.tsx";
import { ThemeProvider } from "../src/app/theme.tsx";
import { WorkspaceTarget } from "../src/features/sessions/workspace-target.tsx";
import type { RemoteView } from "../src/lib/remotes.ts";
import "../src/i18n.ts";

/**
 * The picker in the new-session page: which folder it lands on, and what it says when
 * a request fails. Everything here is driven through the same props the page passes,
 * so the specs cover the race the page actually creates: opening a host asks for a
 * folder while the saved projects are still on their way.
 */

const calls: string[] = [];
const dir = (name: string, path: string) => ({ name, path });
let remotesStatus: RemoteView["status"] = "connected";
let remotesDelay = 0;
let home: { status?: number; delay?: number; directories?: { name: string; path: string }[] } = {};
let pathResponses: Record<string, { status?: number; delay?: number; directories?: { name: string; path: string }[] }> = {};

const PROJECT = "/Users/avaca/dev/eta";

function respond(body: unknown, status: number, delay: number): Promise<Response> {
	const response = {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
	} as Response;
	return delay > 0 ? new Promise((resolve) => setTimeout(() => resolve(response), delay)) : Promise.resolve(response);
}

function stubFetch(): void {
	vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/api/remotes")) {
			return respond(
				[
					{
						id: "abc",
						name: "Mac mini",
						host: "192.168.198.85",
						autoConnect: false,
						projects: [PROJECT, "/Users/avaca/dev/mpfi"],
						forwards: [],
						status: remotesStatus,
						logs: [],
						ports: [],
					},
					{
						id: "laptop",
						name: "Laptop",
						host: "127.0.0.1",
						autoConnect: false,
						projects: ["/Users/avaca/dev/laptop"],
						forwards: [],
						status: "connected",
						logs: [],
						ports: [],
					},
				],
				200,
				remotesDelay,
			);
		}
		if (/\/api\/remote\/[^/]+\/api\/directories/.test(url)) {
			const target = new URL(url, "http://x").searchParams.get("path") ?? "";
			const rule = target === "~" ? home : (pathResponses[target] ?? {});
			return respond(
				rule.status === undefined
					? { path: target === "~" ? "/Users/avaca" : target, parent: "/Users/avaca/dev", directories: rule.directories ?? [] }
					: { error: "unreadable" },
				rule.status ?? 200,
				rule.delay ?? 0,
			);
		}
		return respond(null, 200, 0);
	});
}

function Harness(props: { initialRemote?: string; initialCwd?: string }) {
	const [remoteId, setRemoteId] = createSignal<string | undefined>(props.initialRemote);
	const [cwd, setCwd] = createSignal(props.initialCwd ?? "");
	return <WorkspaceTarget remoteId={remoteId()} cwd={cwd()} onRemoteId={setRemoteId} onCwd={setCwd} browse={false} />;
}

function mount(props: { initialRemote?: string; initialCwd?: string }): void {
	render(
		<ThemeProvider>
			<Harness {...props} />
		</ThemeProvider>,
	);
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const directoryCalls = () => calls.filter((url) => url.includes("/api/directories"));
const pathValue = () => (queryId("remote-directory-path") as HTMLInputElement).value;

describe("remote directory picker", () => {
	beforeEach(() => {
		calls.length = 0;
		remotesStatus = "connected";
		remotesDelay = 0;
		home = {};
		pathResponses = {};
		stubFetch();
	});

	it("selects the initial remote after the device options load and refresh", async () => {
		remotesDelay = 5;
		mount({ initialRemote: "abc", initialCwd: PROJECT });
		await settle();
		const host = byId("workspace-host") as HTMLSelectElement;
		expect(host.value).toBe("abc");
		expect(pathValue()).toBe(PROJECT);
		window.dispatchEvent(new Event("eta:remotes"));
		await settle();
		expect(host.value).toBe("abc");
		fireEvent.change(host, { target: { value: "" } });
		expect(host.value).toBe("");
		expect(queryId("remote-directory-path")).toBeNull();
	});

	it("a late failure from the folder nobody is looking at does not stick under an empty one", async () => {
		// Opening a host with no folder yet asks for the remote home first; the saved
		// project takes over a beat later. The home request fails late — that failure
		// must not paint an error under a project that listed fine, which is how an
		// empty directory came to look like the cause of the error.
		remotesDelay = 5;
		home = { status: 503, delay: 25 };
		mount({ initialRemote: "abc", initialCwd: "" });
		await settle();
		expect(pathValue()).toBe(PROJECT);
		expect(queryId("remote-directory-error")).toBeNull();
		expect(queryId("remote-directory-empty")).not.toBeNull();
	});

	it("a folder that answers late does not drag the choice back and does not storm requests", async () => {
		// The home listing answers after the project one. Without a sequence guard its
		// reply rewrites the chosen path, and every rewrite asks again.
		remotesDelay = 5;
		home = { delay: 25, directories: [dir("avaca-home", "/Users/avaca/x")] };
		pathResponses[PROJECT] = { directories: [dir("src", `${PROJECT}/src`)] };
		mount({ initialRemote: "abc", initialCwd: "" });
		await settle(80);
		expect(pathValue()).toBe(PROJECT);
		expect(queryId("remote-dir-src")).not.toBeNull();
		expect(directoryCalls()).toHaveLength(2);
	});

	it("says the host is down instead of blaming the folder, and reloads on reconnect", async () => {
		remotesStatus = "reconnecting";
		mount({ initialRemote: "abc", initialCwd: PROJECT });
		await settle();
		expect(queryId("remote-directory-offline")).not.toBeNull();
		expect(queryId("remote-directory-error")).toBeNull();
		remotesStatus = "connected";
		pathResponses[PROJECT] = { directories: [dir("src", `${PROJECT}/src`)] };
		window.dispatchEvent(new Event("eta:remotes"));
		await settle();
		expect(queryId("remote-directory-offline")).toBeNull();
		expect(queryId("remote-dir-src")).not.toBeNull();
	});

	it("drops the previous machine's listing when the host changes", async () => {
		pathResponses[PROJECT] = { directories: [dir("src", `${PROJECT}/src`)] };
		mount({ initialRemote: "abc", initialCwd: PROJECT });
		await settle();
		expect(queryId("remote-dir-src")).not.toBeNull();

		// The other machine's answer is slow, and in the meantime nothing of the first
		// machine's filesystem may still be on screen.
		pathResponses["/Users/avaca/dev/laptop"] = { delay: 80, directories: [dir("only-here", "/Users/avaca/dev/laptop/only-here")] };
		fireEvent.change(byId("workspace-host"), { target: { value: "laptop" } });
		expect(queryId("remote-dir-src")).toBeNull();
		await settle(200);
		expect(queryId("remote-dir-only-here")).not.toBeNull();
	});

	it("shows a real failure alone, and clears it when the folder answers", async () => {
		pathResponses[PROJECT] = { status: 400 };
		mount({ initialRemote: "abc", initialCwd: PROJECT });
		await settle();
		expect(queryId("remote-directory-error")).not.toBeNull();
		// "no subdirectories" beside a failure is what made an empty folder look broken.
		expect(queryId("remote-directory-empty")).toBeNull();
		delete pathResponses[PROJECT];
		pathResponses[PROJECT] = { directories: [dir("src", `${PROJECT}/src`)] };
		queryId("remote-directory-path")!.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();
		expect(queryId("remote-directory-error")).toBeNull();
		expect(queryId("remote-dir-src")).not.toBeNull();
	});
});
