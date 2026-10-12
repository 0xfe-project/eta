/**
 * The file-backed store: the same contract as the memory one, plus the parts that
 * only exist on disk — a restart finding sessions, a bad session keeping its row,
 * and nothing being lost between close and reopen.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLog } from "@eta/core/session";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore, JOURNAL_FILE, META_FILE } from "../src/file-store";
import { sessionStoreContract } from "../src/testing";

const roots: string[] = [];
const stores: FileSessionStore[] = [];

/** A store the test file will close afterwards: an open journal is a leak the runtime reports later. */
function fileStore(options: ConstructorParameters<typeof FileSessionStore>[0]): FileSessionStore {
	const store = new FileSessionStore(options);
	stores.push(store);
	return store;
}

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "eta-sessions-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

sessionStoreContract("FileSessionStore", async () => {
	const root = await tempRoot();
	const store = fileStore({ root });
	return {
		store,
		// The one backend-specific hook: a session whose metadata cannot be read.
		makeUnreadable: async (id: string, _reason: string) => {
			await writeFile(join(root, id, META_FILE), "{ this is not json", "utf8");
		},
		dispose: async () => {
			await store.close();
		},
	};
});

describe("what only a real directory tree gives", () => {
	it("lays a session out as a directory with metadata beside its journal", async () => {
		const root = await tempRoot();
		const store = fileStore({ root });
		const meta = { id: "eta-abc", createdAt: 1_700_000_000_000, cwd: "/work", title: "layout" };
		const created = await store.create(meta);
		// (This store is closed at the end of the test: a journal left open is a
		// handle the runtime reports as an error, far from here.)

		expect(await readdir(root)).toEqual(["eta-abc"]);
		// Metadata is written when the session is created; the journal appears on the
		// first commit, so an untouched session costs one small file.
		expect(await readdir(join(root, "eta-abc"))).toEqual([META_FILE]);
		// The metadata is readable without opening anything.
		expect(await store.list()).toEqual([{ ok: true, id: "eta-abc", meta }]);

		await created.storage.commit([
			{
				kind: "entry",
				entry: {
					id: "e1",
					parentId: null,
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "on disk" }], timestamp: 0 },
				},
			},
		]);
		expect((await readdir(join(root, "eta-abc"))).sort()).toEqual([JOURNAL_FILE, META_FILE]);
		const reopened = fileStore({ root });
		const opened = await reopened.open("eta-abc");
		expect((await opened!.storage.getStats()).messageCount).toBe(1);
		// Opening the same session twice is the same journal, not a second handle.
		expect((await reopened.open("eta-abc"))!.storage).toBe(opened!.storage);
	});

	it("survives a restart: a new store over the same root finds the same sessions", async () => {
		const root = await tempRoot();
		const first = fileStore({ root });
		const created = await first.create({ id: "eta-one", createdAt: 10, cwd: "/work/one", persona: "Executor" });
		expect(created.meta.persona).toBe("Executor");
		await first.close();

		// A different process would do exactly this.
		const restarted = fileStore({ root });
		const listed = await restarted.list();
		expect(listed).toHaveLength(1);
		const opened = await restarted.open("eta-one");
		expect(opened?.meta).toEqual({ id: "eta-one", createdAt: 10, cwd: "/work/one", persona: "Executor" });

		// Write through the reopened journal, then reopen once more and read it back.
		const log = await SessionLog.load(opened!.storage);
		log.recordMessage({
			role: "user",
			content: [{ type: "text", text: "written before the restart" }],
			timestamp: 0,
		});
		await log.commit();
		await restarted.close();

		const third = fileStore({ root });
		const again = await third.open("eta-one");
		const replayed = await SessionLog.load(again!.storage);
		expect(replayed.transcript()).toHaveLength(1);
		expect(JSON.stringify(replayed.transcript())).toContain("written before the restart");
		await third.close();
	});

	it("keeps a session whose metadata is damaged, with a reason instead of a disappearance", async () => {
		const root = await tempRoot();
		const store = fileStore({ root });
		await store.create({ id: "eta-good", createdAt: 20, cwd: "/work" });
		await mkdir(join(root, "eta-broken"));
		await writeFile(join(root, "eta-broken", META_FILE), '{"id": "eta-broken"', "utf8");

		const warnings: string[] = [];
		const watching = new FileSessionStore({ root, warn: (message) => warnings.push(message) });
		const listed = await watching.list();
		expect(listed.map((listing) => listing.id).sort()).toEqual(["eta-broken", "eta-good"]);
		const broken = listed.find((listing) => listing.id === "eta-broken");
		expect(broken?.ok).toBe(false);
		expect(broken?.ok === false ? broken.reason : "").toContain("JSON");
		expect(warnings.join(" ")).toContain("eta-broken");

		// Opening what cannot be read is an error, and says so.
		await expect(watching.open("eta-broken")).rejects.toThrow(/meta\.json/);
		// Listing a directory that holds no metadata still names the reason.
		await mkdir(join(root, "eta-empty"));
		const withEmpty = await watching.list();
		const empty = withEmpty.find((listing) => listing.id === "eta-empty");
		expect(empty?.ok === false ? empty.reason : "").toBe("meta.json is missing");
	});

	it("refuses an id that would leave the session directory, and a duplicate", async () => {
		const root = await tempRoot();
		const store = fileStore({ root });
		await expect(store.create({ id: "../escape", createdAt: 0, cwd: "/" })).rejects.toThrow(/invalid session id/);
		await store.create({ id: "eta-dup", createdAt: 0, cwd: "/work" });
		await expect(store.create({ id: "eta-dup", createdAt: 1, cwd: "/work" })).rejects.toThrow();
		expect((await readdir(root)).sort()).toEqual(["eta-dup"]);
	});

	it("removes a session's whole directory, and forgets it", async () => {
		const root = await tempRoot();
		const store = fileStore({ root });
		await store.create({ id: "eta-gone", createdAt: 0, cwd: "/work" });
		expect(await store.remove("eta-gone")).toBe(true);
		expect(await store.remove("eta-gone")).toBe(false);
		expect(await store.list()).toEqual([]);
		expect(await readdir(root)).toEqual([]);
	});
});
