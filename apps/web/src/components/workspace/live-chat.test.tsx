import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { conversationView, memberView, productHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { LiveChat } from "./live-chat";

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  document.title = "";
});

const waiting = (id: string) =>
  conversationView({
    id,
    participants: [
      memberView("a1", { sessionId: `s-${id}`, status: "waiting_for_input" }),
    ],
  });
const ask = (questionId: string) => ({
  core: { session: "s", running: true },
  ask: { pending: { questionId, question: "ok?", options: ["y"] } },
});

describe("the tab's title", () => {
  it("counts the questions waiting for the user, wherever they were asked", async () => {
    const host = productHost({
      conversations: [conversationView({ id: "c0" })],
    });
    host.target("sessions.s-c1", ask("q1"));
    host.target("sessions.s-c2", ask("q2"));
    await mount(<LiveChat />);
    await flush();
    expect(document.title).toBe("eta");
    await act(async () =>
      host.set("conversations", { list: [waiting("c1"), waiting("c2")] }),
    );
    await flush();
    expect(document.title).toBe("(2) eta");
  });
});
