/**
 * Questions that belong to no conversation, and one whose agent is unknown too. The host makes
 * these only for sessions outside conversations, which the product has no way to start from a
 * test, so the wire's state is set by hand here: what is under test is how the interface names
 * such an item and that it has nowhere to go.
 */
import type { InteractionView } from "@eta/client-contracts";
import type { WireState } from "../../src/connection/types";
import { describe, expect, it } from "vitest";
import { renderApp } from "../ui-support/app";
import { fakeWire } from "../ui-support/fake-wire";
import { flush, KEYS, plain } from "../ui-support/render";
import { PENDING_KEYS } from "./world";

function bareQuestion(
  id: string,
  agentId: string | null,
  prompt: string,
  createdAt: number,
): InteractionView {
  return {
    id,
    sessionId: `${id}-session-0123456789`,
    questionId: `q-${id}`,
    agentId,
    conversationId: null,
    replyId: null,
    prompt,
    options: [],
    multi: false,
    status: "pending",
    answer: null,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

const target = (list: unknown) => ({
  sections: { list },
  revisions: {},
  version: 1,
});

async function show(questions: InteractionView[]) {
  const targets: WireState["targets"] = {
    inbox: target(questions),
    agents: target([{ id: "a1", name: "Ada" }]),
    conversations: target([]),
    tasks: target([]),
  };
  const wire = fakeWire({ ops: ["inbox.answer"], targets });
  const r = await renderApp({ patch: { wire }, rows: 40 });
  await r.press(KEYS.left);
  await flush();
  return { r, wire };
}

describe("a question outside any conversation", () => {
  it("has nowhere to go: the conversation key does nothing and the footer leaves it out", async () => {
    const long = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`).join(
      "\n",
    );
    const { r, wire } = await show([bareQuestion("one", "a1", long, 1)]);
    await r.press(KEYS.enter);
    await flush();
    expect(plain(r)).toContain("Line 12");
    expect(plain(r)).not.toContain("Line 13");
    expect(plain(r)).not.toContain("press");
    expect(plain(r)).toMatch(/^[^\w\u2026]*\u2026\W*$/m);
    expect(plain(r)).not.toContain("alt+o");
    await r.press(PENDING_KEYS.openConversation);
    await flush();
    expect(plain(r)).toContain("Decline");
    expect(plain(r)).toContain("Line 1");
    expect(wire.calls).toEqual([]);
    r.unmount();
  });
});
