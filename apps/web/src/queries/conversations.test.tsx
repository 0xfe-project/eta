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
import {
  forgetRows,
  rememberRows,
  useConversation,
  useConversationList,
} from "./conversations";

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

describe("rows the host stopped sending", () => {
  it("drops a row the window covers and no longer has: a message waiting for a lane", async () => {
    // The second message is held: written, but not in the window. The page learned of it when it
    // was sent, and the union of "what I remember" with "what the host sends" used to put it back
    // in the transcript — the same words as a message and as a chip.
    const summary = conversationView({ id: "held-one", lastSeq: 3 });
    rememberRows("held-one", [
      row("held-one", 1, "hi"),
      row("held-one", 3, "and the summary"),
    ]);
    const host = productHost({
      conversations: [summary],
      messages: {
        "held-one": [row("held-one", 1, "hi"), row("held-one", 2, "on it")],
      },
    });
    await mount(<Reader id="held-one" />);
    // It was remembered — the page saw it when it was sent — so it shows until the host answers.
    expect(text("rows")).toBe("1:hi|2:on it|3:and the summary");

    // A window whose span covers seq 3 and does not contain it: not a message. Only the rows
    // outside that span (older pages, newer sends) are the page's to keep.
    await act(async () =>
      host.set(
        "conversations.held-one",
        conversationSections(summary, [
          row("held-one", 2, "on it"),
          row("held-one", 4, "later"),
        ]),
      ),
    );
    // 3 is inside the span and gone; 1 is below it, which is what paging leaves behind.
    expect(text("rows")).toBe("1:hi|2:on it|4:later");
  });

  it("keeps the reply a recall removed out of the transcript", async () => {
    const summary = conversationView({ id: "recalled", lastSeq: 2 });
    productHost({
      conversations: [summary],
      messages: { recalled: [row("recalled", 1, "hi")] },
    });
    await mount(<Reader id="recalled" />);
    // What a held message left behind: its reply, waiting, empty.
    rememberRows("recalled", [
      row("recalled", 2, "", {
        rootMessageId: "recalled-m2",
        replyToId: "recalled-m2",
      }),
    ]);
    await act(async () => forgetRows("recalled", ["recalled-m2"]));
    expect(text("rows")).toBe("1:hi");
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
