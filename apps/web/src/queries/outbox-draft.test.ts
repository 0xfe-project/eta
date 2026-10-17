import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { useOutbox } from "./outbox";

// The draft is the thing a person loses when a chat switches away and back, so what is being
// asserted is the storage, not the store: it has to be on its way to localStorage the moment the
// draft changes, and it has to come back when the store hydrates.

const KEY = "axp.groups.v1";

function saved(): { drafts: Record<string, unknown> } {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}") as {
    drafts: Record<string, unknown>;
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("草稿按会话保存", () => {
  it("is written as soon as it changes, under the conversation it belongs to", async () => {
    useOutbox.getState().setDraft("g1", [{ type: "text", text: "写到一半" }]);
    await Promise.resolve();
    expect(saved().drafts.g1).toEqual([{ type: "text", text: "写到一半" }]);
  });

  it("keeps one draft per conversation, and forgets an emptied one", async () => {
    const store = useOutbox.getState();
    store.setDraft("g1", [{ type: "text", text: "first" }]);
    store.setDraft("g2", [{ type: "text", text: "second" }]);
    await Promise.resolve();
    expect(Object.keys(saved().drafts).sort()).toEqual(["g1", "g2"]);

    // Sending clears the draft; a stored empty draft would come back as an empty box that thinks
    // it has content.
    store.setDraft("g1", []);
    await Promise.resolve();
    expect(Object.keys(saved().drafts)).toEqual(["g2"]);
  });

  it("hydrates what was there before a reload", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        drafts: { g1: [{ type: "text", text: "还在" }] },
        uploads: {},
        outgoing: [],
      }),
    );
    await useOutbox.persist.rehydrate();
    expect(useOutbox.getState().drafts.g1).toEqual([
      { type: "text", text: "还在" },
    ]);
  });
});
