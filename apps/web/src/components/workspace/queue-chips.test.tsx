import { afterEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { agentView, memberView, productHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { QueueChips } from "./queue-chips";

let host: ReturnType<typeof productHost>;

const members = [memberView("a1", { sessionId: "s1" })];
const agents = [agentView({ id: "a1", name: "乐子人" })];

function start(queue: { entryId: string; kind: string; text: string }[]) {
  host = productHost({ agents });
  host.target("sessions.s1", {
    core: { session: "s1", running: true },
    queue: { items: queue },
  });
  host.handle("sessions.resync", () => ({}));
  host.handle("sessions.queueRemove", (args) => ({
    entryId: (args as { entryId: string }).entryId,
    outcome: "cancelled",
  }));
  return mount(<QueueChips members={members} />);
}
afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("输入框上方的排队条", () => {
  it("排队中的和已经插话的分开写，一条一个 chip", async () => {
    const { container } = await start([
      { entryId: "q1", kind: "followUp", text: "跑一遍测试" },
      { entryId: "q2", kind: "steer", text: "顺便看下日志" },
    ]);
    await flush();
    const chips = [...container.querySelectorAll("[data-slot=queue-chip]")];
    expect(chips).toHaveLength(2);
    // The kind decides what can still be done with the entry, so it is on the chip.
    expect(chips[0]?.textContent).toContain("排队");
    expect(chips[1]?.textContent).toContain("插话");
    expect(chips[0]?.textContent).toContain("跑一遍测试");
  });

  it("× 走 queueRemove，带上这条的 entryId", async () => {
    const { container } = await start([
      { entryId: "q1", kind: "followUp", text: "跑一遍测试" },
    ]);
    await flush();
    await click(container.querySelector("button[aria-label^='丢掉这条']"));
    await flush();
    const call = host.calls.find((one) => one.action === "queueRemove");
    expect(call?.args).toEqual({ session: "s1", entryId: "q1" });
  });

  it("没有排队就什么都不画", async () => {
    const { container } = await start([]);
    await flush();
    expect(container.querySelector("[data-slot=queue-lane]")).toBeNull();
  });
});
