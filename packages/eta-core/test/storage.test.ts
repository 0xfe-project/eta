import type { MessageEntry } from "@eta/core/session";
import {
  InMemoryStorageState,
  MemoryStorage,
  setValue,
  value,
} from "@eta/core/storage";
import { storageContract } from "@eta/core/testing";
import { describe, expect, it } from "vitest";

// The shared behavioural suite: every backend runs the same checks.
storageContract("memory", async () => {
  const storage = new MemoryStorage();
  return { storage, dispose: async () => void (await storage.close()) };
});

describe("memoryStorage specifics", () => {
  it("hands out copies, so a caller cannot edit stored state in place", async () => {
    const storage = new MemoryStorage();
    await storage.commit([
      setValue(value<{ list: number[] }>("meta"), { list: [1] }),
    ]);
    const stored = (await storage.getValue(value<{ list: number[] }>("meta")))!;
    stored.value.list.push(2);
    expect(
      (await storage.getValue(value<{ list: number[] }>("meta")))!.value.list,
    ).toEqual([1]);
    await storage.close();
  });

  it("repeated entry ids overwrite and are counted, like a replayed journal", () => {
    // The shared state behind every backend; jsonl warns with this count.
    const storage = new InMemoryStorageState();
    const entry: Omit<MessageEntry, "seq" | "timestamp"> = {
      id: "e1",
      parentId: null,
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "first" }],
        timestamp: 0,
      },
    };
    storage.commit([{ kind: "entry", entry }]);
    storage.commit([
      {
        kind: "entry",
        entry: { ...entry, message: { ...entry.message, timestamp: 1 } },
      },
    ]);
    expect(storage.repeated).toBe(1);
    const found = storage.getEntries(["e1"]);
    const stored = found.get("e1")!;
    expect(stored.type).toBe("message");
    if (stored.type !== "message") throw new Error("unreachable");
    expect(stored.message.timestamp).toBe(1);
    // A repeated id does not double-count the message.
    expect(storage.getStats().messageCount).toBe(1);
  });
});
