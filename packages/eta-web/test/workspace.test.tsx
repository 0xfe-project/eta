// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byId, findId, queryId } from "./dom.ts";
import { click, render } from "./render.tsx";
import { WorkspacePanel } from "../src/features/sessions/workspace-panel.tsx";

const STATUS = {
	notGit: false,
	branch: "main",
	groups: {
		staged: [{ path: "src/a.ts", status: "M", added: 3, deleted: 1 }],
		changes: [{ path: "src/b.ts", status: "M", added: 1, deleted: 0 }],
		untracked: [{ path: "new.ts", status: "??", added: 5 }],
		conflicted: [],
	},
};
const DIFF = {
	path: "src/a.ts",
	kind: "index",
	text: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,5 @@\n-a\n+a\n+b\n context",
	truncated: false,
};
const EMPTY = { notGit: true, branch: null, groups: { staged: [], changes: [], untracked: [], conflicted: [] } };

let statusFetches = 0;

function stubFetch(body: unknown = STATUS): void {
	statusFetches = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown) => {
			const diff = String(input).includes("/api/git/diff");
			if (!diff) statusFetches += 1;
			return { ok: true, json: async () => (diff ? DIFF : body) };
		}),
	);
}

beforeEach(() => stubFetch());

describe("workspace panel", () => {
	it("lists changed files by group and renders the diff of the picked one", async () => {
		render(<WorkspacePanel session="s1" />);
		await findId("git-file-src/a.ts");
		expect((await findId("git-summary")).textContent).toContain("3 files");
		expect(queryId("git-file-new.ts")).not.toBeNull();
		click("git-file-src/a.ts");
		await findId("git-diff-body");
		expect(document.querySelectorAll(".git-diff-line.add")).toHaveLength(2);
		expect(document.querySelectorAll(".git-diff-line.del")).toHaveLength(1);
	});

	it("says so when the session folder is not a repository", async () => {
		stubFetch(EMPTY);
		render(<WorkspacePanel session="s1" />);
		expect((await findId("git-empty")).textContent).toContain("git");
	});

	it("shows an unreachable-git message instead of throwing, on a bad status or a dead fetch", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
		render(<WorkspacePanel session="bad-status" />);
		expect((await findId("git-empty")).textContent).toMatch(/git/i);

		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("server went away");
		}));
		render(<WorkspacePanel session="fetch-rejects" />);
		expect((await findId("git-empty")).textContent).toMatch(/git/i);
	});

	it("splits file list and diff left/right once the panel is wide enough", async () => {
		class FakeResizeObserver {
			static instances: FakeResizeObserver[] = [];
			private readonly callback: ResizeObserverCallback;

			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
				FakeResizeObserver.instances.push(this);
			}

			observe(target: Element): void {
				this.callback(
					[{ target, contentRect: { width: 900 } } as unknown as ResizeObserverEntry],
					this as unknown as ResizeObserver,
				);
			}

			unobserve(): void {}

			disconnect(): void {}
		}
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		render(<WorkspacePanel session="wide" />);
		await findId("git-file-src/a.ts");
		expect(byId("workspace-panel").getAttribute("data-wide")).toBe("1");
		expect(byId("git-split").className).toContain("flex-row");
	});

	it("coalesces a burst of view frames into one refresh", async () => {
		// A distinct session name: Solid elements built as arguments to the test
		// `render` helper own no root, so earlier panels keep their listeners.
		vi.useFakeTimers();
		try {
			render(<WorkspacePanel session="burst" />);
			await vi.advanceTimersByTimeAsync(0);
			expect(statusFetches).toBe(1);
			for (const session of ["burst", "burst", "other"]) {
				window.dispatchEvent(new CustomEvent("eta:view", { detail: { session } }));
			}
			await vi.advanceTimersByTimeAsync(900);
			expect(statusFetches).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
