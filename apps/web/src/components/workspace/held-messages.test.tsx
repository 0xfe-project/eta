import type { MessageView } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { agentView, conversationView, productHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { HeldMessages } from "./held-messages";

let host: ReturnType<typeof productHost>;
const pulled: string[] = [];

const held = (text: string, id = "m1"): MessageView =>
  ({ id, text, author: "user", status: "done" }) as MessageView;

function start(messages: readonly MessageView[], recalled = true) {
  const group = conversationView({ id: "g1", name: "装配" });
  host = productHost({ agents: [agentView({ id: "a1", name: "乐子人" })] });
  host.handle("conversations.recall", () => ({
    conversationId: "g1",
    recalled,
  }));
  return mount(
    <HeldMessages
      conversationId={group.id}
      held={messages}
      onPullBack={(text) => pulled.push(text)}
    />,
  );
}
afterEach(async () => {
  await cleanup();
  setWire(undefined);
  pulled.length = 0;
});

describe("送达之前的那条消息", () => {
  it("一条一个 chip，写着它的文本", async () => {
    const { container } = await start([held("再写个摘要")]);
    await flush();
    const chips = [...container.querySelectorAll("[data-slot=held-chip]")];
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toContain("再写个摘要");
  });

  it("拉回：先从对话里召回，召回了才把文本放回输入框", async () => {
    const { container } = await start([held("再写个摘要")]);
    await flush();
    await click(container.querySelector("button[aria-label^='拉回输入框']"));
    await flush();
    const call = host.calls.find((one) => one.action === "recall");
    expect(call?.args).toEqual({ conversationId: "g1", messageId: "m1" });
    expect(pulled).toEqual(["再写个摘要"]);
  });

  it("召回失败就什么都不做：已经有一条 lane 把它拿走了", async () => {
    const { container } = await start([held("再写个摘要")], false);
    await flush();
    await click(container.querySelector("button[aria-label^='拉回输入框']"));
    await flush();
    // The words are already in the conversation; putting them back would say them twice.
    expect(pulled).toEqual([]);
  });

  it("丢掉就是召回，不回输入框", async () => {
    const { container } = await start([held("再写个摘要")]);
    await flush();
    await click(container.querySelector("button[aria-label^='丢掉这条']"));
    await flush();
    expect(host.calls.some((one) => one.action === "recall")).toBe(true);
    expect(pulled).toEqual([]);
  });

  it("没有等待中的消息就什么都不画", async () => {
    const { container } = await start([]);
    await flush();
    expect(container.querySelector("[data-slot=held-lane]")).toBeNull();
  });
});
