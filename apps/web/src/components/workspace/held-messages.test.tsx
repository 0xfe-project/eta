import type { MessageView, SteerHeldResult } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { toast } from "sonner";
import { setWire } from "@/lib/wire";
import { agentView, productHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { HeldMessages } from "./held-messages";

let host: ReturnType<typeof productHost>;
const pulled: string[] = [];
const agents = [
  agentView({ id: "a1", name: "Ada" }),
  agentView({ id: "a2", name: "Bo" }),
  agentView({ id: "a3", name: "Cy" }),
  agentView({ id: "a4", name: "Di" }),
];

const held = (text: string, id = "m1", woke: string[] = ["a1"]): MessageView =>
  ({
    id,
    text,
    author: "user",
    status: "done",
    data: { held: true, woke, joined: [] },
  }) as unknown as MessageView;

const steered = (fields: Partial<SteerHeldResult>): SteerHeldResult => ({
  conversationId: "g1",
  steered: true,
  joined: ["a1"],
  replies: [],
  dropped: [],
  ...fields,
});

function start(
  messages: readonly MessageView[],
  {
    recalled = true,
    steer = () => steered({}),
  }: { recalled?: boolean; steer?: () => unknown } = {},
) {
  host = productHost({ agents });
  host.handle("conversations.recall", () => ({
    conversationId: "g1",
    recalled,
  }));
  host.handle("conversations.steerHeld", steer);
  return mount(
    <HeldMessages
      conversationId="g1"
      held={messages}
      agents={agents}
      onPullBack={(text) => pulled.push(text)}
    />,
  );
}

const blocks = (root: ParentNode) => [
  ...root.querySelectorAll<HTMLElement>("[data-slot=held-message]"),
];
const heads = (root: ParentNode) =>
  blocks(root).map(
    (block) => block.querySelector("[data-slot=held-head]")?.textContent,
  );

async function press(
  element: Element | undefined,
  key: string,
  modifiers: KeyboardEventInit = {},
) {
  if (!element) throw new Error("nothing to press on");
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }),
    );
  });
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  pulled.length = 0;
  rstest.restoreAllMocks();
});

describe("排队中的消息", () => {
  it("一条一块，全文进正文和悬停提示，正文最多两行", async () => {
    const long =
      "顺便把 twitter:image 也换掉，尺寸按 1200×630 出一张。旧的那张先别删，等我确认新的没问题再删。还有发版说明里提一句 OG 图换了。";
    const { container } = await start([held(long)]);
    await flush();
    expect(blocks(container)).toHaveLength(1);
    const text = container.querySelector("[data-slot=held-text]")!;
    expect(text.textContent).toBe(long);
    expect(text.getAttribute("title")).toBe(long);
    // Cut at two lines, by the clamp; nothing to expand.
    expect(text.className).toContain("line-clamp-2");
    expect(text.className).toContain("text-[14px]");
    expect(text.className).not.toContain("font-mono");
    expect(container.textContent).not.toContain("展开");
  });

  it("顶部一行：单条写谁这一轮结束后发出，不写序号", async () => {
    const { container } = await start([held("再写个摘要")]);
    await flush();
    expect(heads(container)).toEqual(["排队中 · Ada 这一轮结束后发出"]);
  });

  it("顶部一行：多条时第二条接在上一条后面，右侧写 1 / 2", async () => {
    const { container } = await start([
      held("第一条", "m1"),
      held("第二条", "m2"),
    ]);
    await flush();
    expect(heads(container)).toEqual([
      "排队中 · Ada 这一轮结束后发出1 / 2",
      "排队中 · 接在上一条后面2 / 2",
    ]);
  });

  it("顶部一行：多个智能体在回复时写全部名字，太多就写它们；按钮写插入当前回复", async () => {
    const { container } = await start([
      held("两个人", "m1", ["a1", "a2"]),
      held("四个人", "m2", ["a1", "a2", "a3", "a4"]),
    ]);
    await flush();
    expect(heads(container)[0]).toContain("Ada、Bo 这一轮结束后发出");
    const four = await start([held("四个人", "m2", ["a1", "a2", "a3", "a4"])]);
    await flush();
    expect(heads(four.container)[0]).toContain("它们 这一轮结束后发出");
    expect(container.querySelector("[data-slot=held-steer]")?.textContent).toBe(
      "插入当前回复",
    );
  });

  it("插入：调用 steerHeld，插入中这一块写正在插入、按钮全部禁用", async () => {
    let answer!: (result: SteerHeldResult) => void;
    const { container } = await start([held("另外 Safari 也测一下")], {
      steer: () =>
        new Promise<SteerHeldResult>((resolve) => {
          answer = resolve;
        }),
    });
    await flush();
    await click(container.querySelector("[data-slot=held-steer]"));
    await flush();
    expect(host.calls.find((one) => one.action === "steerHeld")?.args).toEqual({
      conversationId: "g1",
      messageId: "m1",
    });
    // One step on the host: no recall, no send from here.
    expect(host.calls.some((one) => one.action === "recall")).toBe(false);
    expect(host.calls.some((one) => one.action === "send")).toBe(false);
    expect(blocks(container)[0]?.dataset.state).toBe("steering");
    expect(heads(container)[0]).toBe("正在插入 Ada 这一轮…");
    const buttons = [...blocks(container)[0]!.querySelectorAll("button")];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((one) => one.disabled)).toBe(true);
    answer(steered({}));
    await flush();
    expect(blocks(container)[0]?.dataset.state).toBeUndefined();
  });

  it("已经被读走：不再发送，只提示已经读到这条了", async () => {
    const said = rstest.spyOn(toast, "message").mockImplementation(() => 0);
    const { container } = await start([held("再写个摘要")], {
      steer: () => steered({ steered: false, reason: "taken", joined: [] }),
    });
    await flush();
    await click(container.querySelector("[data-slot=held-steer]"));
    await flush();
    // Asked once; the host said a lane had it, so nothing else goes out from here.
    expect(host.calls.filter((one) => one.action === "steerHeld")).toHaveLength(
      1,
    );
    expect(host.calls.some((one) => one.action === "send")).toBe(false);
    expect(host.calls.some((one) => one.action === "recall")).toBe(false);
    expect(said).toHaveBeenCalledWith("Ada 已经读到这条了");
    expect(pulled).toEqual([]);
  });

  it("拉回编辑：先召回，召回了才把文本放回输入框", async () => {
    const { container } = await start([held("再写个摘要")]);
    await flush();
    await click(container.querySelector("[data-slot=held-pull]"));
    await flush();
    const call = host.calls.find((one) => one.action === "recall");
    expect(call?.args).toEqual({ conversationId: "g1", messageId: "m1" });
    expect(pulled).toEqual(["再写个摘要"]);
  });

  it("召回失败就什么都不做：已经有一条 lane 把它拿走了", async () => {
    const { container } = await start([held("再写个摘要")], {
      recalled: false,
    });
    await flush();
    await click(container.querySelector("[data-slot=held-pull]"));
    await flush();
    // The words are already in the conversation; putting them back would say them twice.
    expect(pulled).toEqual([]);
  });

  it("删除就是召回，不回输入框", async () => {
    const { container } = await start([held("再写个摘要")]);
    await flush();
    await click(container.querySelector("[data-slot=held-drop]"));
    await flush();
    expect(host.calls.some((one) => one.action === "recall")).toBe(true);
    expect(pulled).toEqual([]);
  });

  it("键盘：⌘/Ctrl+Enter 插入，E 拉回编辑，Delete 删除", async () => {
    const { container } = await start([held("再写个摘要")]);
    await flush();
    const block = blocks(container)[0];
    await press(block, "Enter");
    await flush();
    // Enter alone is not an insert.
    expect(host.calls.some((one) => one.action === "steerHeld")).toBe(false);
    await press(block, "Enter", { ctrlKey: true });
    await flush();
    await press(block, "Enter", { metaKey: true });
    await flush();
    expect(host.calls.filter((one) => one.action === "steerHeld")).toHaveLength(
      2,
    );

    await press(block, "e");
    await flush();
    expect(pulled).toEqual(["再写个摘要"]);

    await press(block, "Delete");
    await flush();
    expect(host.calls.filter((one) => one.action === "recall")).toHaveLength(2);
    expect(pulled).toEqual(["再写个摘要"]);
  });

  it("没有排队中的消息就什么都不画", async () => {
    const { container } = await start([]);
    await flush();
    expect(container.querySelector("[data-slot=held-lane]")).toBeNull();
  });
});
