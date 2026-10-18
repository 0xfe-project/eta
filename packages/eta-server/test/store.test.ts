/**
 * The session store contract, run against the memory backend — plus the seeding
 * behaviour that makes the reason path reachable without a file to corrupt.
 */
import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/memory-store";
import { sessionStoreContract } from "../src/testing";

sessionStoreContract("memory", async () => {
  const store = new MemorySessionStore();
  return {
    store,
    // A memory store is told a session is unreadable; the file store finds a
    // corrupt meta file. Either way the row stays and carries the reason.
    makeUnreadable: (id: string, reason: string) => {
      store.markUnreadable(id, reason);
    },
    dispose: async () => store.close(),
  };
});

describe("seeding", () => {
  it("starts with what a restart would have found, good and broken alike", async () => {
    const store = new MemorySessionStore({
      sessions: [
        {
          meta: {
            id: "kept",
            createdAt: 1_000,
            cwd: "/work",
            title: "from last time",
          },
        },
        { id: "torn", broken: "journal.jsonl has a torn tail" },
      ],
    });
    const listings = await store.list();
    expect(listings.map((listing) => listing.id).sort()).toEqual([
      "kept",
      "torn",
    ]);
    expect((await store.open("kept"))?.meta.title).toBe("from last time");
    // The broken row is still there, and says what was wrong with it.
    const torn = listings.find((listing) => listing.id === "torn");
    expect(torn?.ok).toBe(false);
    expect(torn?.ok === false ? torn.reason : "").toContain("torn tail");
    // And a seeded id is taken, exactly as if it had been created.
    await expect(
      store.create({ id: "kept", createdAt: 2_000, cwd: "/work" }),
    ).rejects.toThrow(/already exists/);
  });
});
