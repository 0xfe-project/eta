import type { MessageView } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import {
  conversationSections,
  conversationView,
  messageView,
  productHost,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { useConversation, useConversationList } from "./conversations";

function Reader({ id }: { id: string }) {
  const { messages, hasOlder, loadOlder, loadingOlder, loaded } =
    useConversation(id);
  return (
    <div>
      <output data-testid="rows">
        {loaded ? messages.map((m) => `${m.seq}:${m.text}`).join("|") : "…"}
      </output>
      <output data-testid="older">{hasOlder ? "older" : "oldest"}</output>
      <button type="button" disabled={loadingOlder} onClick={loadOlder}>
        more
      </button>
    </div>
  );
}

function List() {
  const { conversations, loaded } = useConversationList();
  return (
    <output>{loaded ? conversations.map((c) => c.id).join(",") : "…"}</output>
  );
}

// The rows the page has seen outlive a render, so each test has a conversation of its own.
const row = (
  conversationId: string,
  seq: number,
  text: string,
  extra: Partial<MessageView> = {},
) =>
  messageView({
    id: `${conversationId}-r${seq}`,
    conversationId,
    seq,
    text,
    ...extra,
  });

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

const text = (id: string) =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent;

describe("the conversation list", () => {
  it("is live: a patch to the list reaches the page", async () => {
    const host = productHost({
      conversations: [conversationView({ id: "list1" })],
    });
    await mount(<List />);
    expect(document.body.textContent).toBe("list1");
    await act(async () =>
      host.set("conversations", {
        list: [
          conversationView({ id: "list1" }),
          conversationView({ id: "list2" }),
        ],
      }),
    );
    expect(document.body.textContent).toBe("list1,list2");
  });
});

describe("one conversation's timeline", () => {
  it("shows the window the host publishes and follows a reply as it changes in place", async () => {
    const summary = conversationView({ id: "live", lastSeq: 2 });
    const host = productHost({
      conversations: [summary],
      messages: {
        live: [row("live", 1, "hi"), row("live", 2, "", { status: "working" })],
      },
    });
    await mount(<Reader id="live" />);
    expect(text("rows")).toBe("1:hi|2:");

    await act(async () =>
      host.set(
        "conversations.live",
        conversationSections(summary, [
          row("live", 1, "hi"),
          row("live", 2, "hello", { revision: 2, status: "done" }),
        ]),
      ),
    );
    expect(text("rows")).toBe("1:hi|2:hello");
  });

  it("keeps rows the window has moved past", async () => {
    const summary = conversationView({ id: "moved" });
    const host = productHost({
      conversations: [summary],
      messages: { moved: [row("moved", 1, "one"), row("moved", 2, "two")] },
    });
    await mount(<Reader id="moved" />);
    await act(async () =>
      host.set(
        "conversations.moved",
        conversationSections(summary, [
          row("moved", 2, "two"),
          row("moved", 3, "three"),
        ]),
      ),
    );
    expect(text("rows")).toBe("1:one|2:two|3:three");
  });

  it("pages back from the oldest row with conversations.history", async () => {
    const summary = conversationView({ id: "paged" });
    const host = productHost({
      conversations: [summary],
      messages: { paged: [row("paged", 3, "three"), row("paged", 4, "four")] },
    });
    host.handle("conversations.history", () => ({
      conversationId: "paged",
      messages: [row("paged", 1, "one"), row("paged", 2, "two")],
      hasMore: false,
    }));
    const { container } = await mount(<Reader id="paged" />);
    expect(text("older")).toBe("older");

    await click(container.querySelector("button"));
    await flush();
    expect(host.calls.find((c) => c.action === "history")?.args).toEqual({
      conversationId: "paged",
      beforeSeq: 3,
      limit: 50,
    });
    expect(text("rows")).toBe("1:one|2:two|3:three|4:four");
    expect(text("older")).toBe("oldest");
  });
});
