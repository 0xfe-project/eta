/**
 * The SessionStore contract suite (REFACTOR.md §5b).
 *
 * Every backend — memory first, files later — must pass the same behavioural
 * checks. The one that matters most is the last: a session that cannot be read
 * is *listed with a reason*. A store that drops what it cannot parse turns a bug
 * into a disappearance, and a user cannot ask about work that is not there.
 */
import { describe, expect, it } from "vitest";
import type { SessionListing, SessionMeta, SessionStore } from "../store";

export interface SessionStoreContractHandle {
	store: SessionStore;
	/**
	 * Make one session unreadable the way a real backend does — a corrupt meta
	 * file, a missing directory. Absent when a backend cannot be broken (then the
	 * reason path is covered by that backend's own tests).
	 */
	makeUnreadable?: (id: string, reason: string) => Promise<void> | void;
	dispose: () => Promise<void>;
}

export type SessionStoreFactory = () => Promise<SessionStoreContractHandle> | SessionStoreContractHandle;

const metaOf = (id: string, createdAt: number, cwd = "/work"): SessionMeta => ({ id, createdAt, cwd });

/** The ids a listing holds, in order. */
const idsOf = (listings: SessionListing[]): string[] => listings.map((listing) => listing.id);

/** Run the shared checks against a backend. */
export function sessionStoreContract(name: string, factory: SessionStoreFactory): void {
	describe(`SessionStore contract — ${name}`, () => {
		it("creates a session, opens it again, and keeps its metadata whole", async () => {
			const { store, dispose } = await factory();
			const created = await store.create({
				...metaOf("s1", 1_000, "/work/eta"),
				title: "porting the harness",
				persona: "Executor",
				model: "pro6000:qwen",
			});
			expect(created.meta.title).toBe("porting the harness");
			const opened = await store.open("s1");
			expect(opened?.meta).toEqual(created.meta);
			// Opening something that was never created is an answer, not a throw.
			expect(await store.open("nope")).toBeUndefined();
			await dispose();
		});

		it("refuses a second session under the same id", async () => {
			const { store, dispose } = await factory();
			await store.create(metaOf("s1", 1_000));
			await expect(store.create(metaOf("s1", 2_000))).rejects.toThrow(/already exists/);
			await dispose();
		});

		it("gives every session its own storage", async () => {
			const { store, dispose } = await factory();
			const first = await store.create(metaOf("s1", 1_000));
			const second = await store.create(metaOf("s2", 2_000));
			expect(first.storage).not.toBe(second.storage);
			// What one session writes, the other cannot see: this is the isolation the
			// server exists to provide.
			await first.storage.commit([
				{
					kind: "entry",
					entry: {
						id: "e1",
						parentId: null,
						type: "message",
						message: { role: "user", content: [{ type: "text", text: "mine" }], timestamp: 0 },
					},
				},
			]);
			const secondStats = await second.storage.getStats();
			expect(secondStats.messageCount).toBe(0);
			const firstStats = await first.storage.getStats();
			expect(firstStats.messageCount).toBe(1);
			await dispose();
		});

		it("lists every session, newest first", async () => {
			const { store, dispose } = await factory();
			await store.create(metaOf("old", 1_000));
			await store.create(metaOf("newest", 3_000));
			await store.create(metaOf("middle", 2_000));
			expect(idsOf(await store.list())).toEqual(["newest", "middle", "old"]);
			await dispose();
		});

		it("removes a session, and forgets it for good", async () => {
			const { store, dispose } = await factory();
			await store.create(metaOf("s1", 1_000));
			expect(await store.remove("s1")).toBe(true);
			expect(await store.open("s1")).toBeUndefined();
			expect(idsOf(await store.list())).toEqual([]);
			expect(await store.remove("s1")).toBe(false);
			await dispose();
		});

		it("keeps a session it cannot read, and says why", async () => {
			const handle = await factory();
			const { store, dispose } = handle;
			if (handle.makeUnreadable === undefined) {
				await dispose();
				return;
			}
			await store.create(metaOf("readable", 1_000));
			await store.create(metaOf("unreadable", 2_000));
			await handle.makeUnreadable("unreadable", "meta.json is not valid JSON");
			const listings = await store.list();
			// Both rows are there: the unreadable one is a row with a reason, not a gap.
			expect(idsOf(listings).sort()).toEqual(["readable", "unreadable"]);
			const broken = listings.find((listing) => listing.id === "unreadable");
			expect(broken?.ok).toBe(false);
			expect(broken?.ok === false ? broken.reason : "").toContain("meta.json is not valid JSON");
			await dispose();
		});

		it("closes without leaving anything behind", async () => {
			const { store, dispose } = await factory();
			await store.create(metaOf("s1", 1_000));
			await store.close();
			// A closed store says so rather than pretending to work.
			await expect(store.list()).rejects.toThrow(/closed/);
			await expect(store.create(metaOf("s2", 2_000))).rejects.toThrow(/closed/);
			await dispose();
		});
	});
}
