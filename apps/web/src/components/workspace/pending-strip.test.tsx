import type { Question } from "@/queries/questions";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { cleanup, click, mount } from "@/test-render";
import { PendingStrip } from "./pending-strip";

afterEach(cleanup);

const agents = [
  { id: "a1", name: "乐子人" },
  { id: "a2", name: "装配检查" },
];

const question = (
  id: string,
  agentId: string,
  extra: Partial<Question> = {},
): Question => ({
  id,
  conversationId: "g1",
  agentId,
  prompt: "跑一下 pwd",
  options: ["允许", "拒绝"],
  multi: false,
  ...extra,
});

describe("等你处理的那一条", () => {
  it("说清是谁在问、问什么，并能就地回答", async () => {
    const choose = rstest.fn();
    const { container } = await mount(
      <PendingStrip
        questions={[question("q1", "a1")]}
        agents={agents}
        onChoose={choose}
      />,
    );
    expect(container.textContent).toContain("乐子人");
    expect(container.textContent).toContain("跑一下 pwd");
    const allow = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "允许",
    );
    await click(allow);
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ id: "q1" }), [
      "允许",
    ]);
  });

  it("要多选或要写字的问题在卡片里答，条上不放按钮", async () => {
    const { container } = await mount(
      <PendingStrip
        questions={[question("q1", "a1", { multi: true })]}
        agents={agents}
        onChoose={() => {}}
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("没有问题时什么都不画", async () => {
    const { container } = await mount(
      <PendingStrip questions={[]} agents={agents} onChoose={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("超过三条时把剩下的数出来，而不是无限往下排", async () => {
    const { container } = await mount(
      <PendingStrip
        questions={[
          question("q1", "a1"),
          question("q2", "a1"),
          question("q3", "a2"),
          question("q4", "a2"),
        ]}
        agents={agents}
        onChoose={() => {}}
      />,
    );
    expect(container.textContent).toContain("还有 1 条在等你");
  });
});
