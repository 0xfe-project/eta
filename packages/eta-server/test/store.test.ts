/**
 * The session store contract, run against the memory backend (file-store.test.ts runs
 * the same contract against the file backend).
 */
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
