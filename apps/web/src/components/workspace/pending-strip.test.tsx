import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PendingStrip } from "./pending-strip";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
});

const agents = [
  { id: "a1", name: "乐子人" },
  { id: "a2", name: "装配检查" },
];

const interaction = (id: string, agentId: string, status = "pending") => ({
  id,
  agent_id: agentId,
  group_id: "g1",
  message_id: "m1",
  kind: "choice" as const,
  prompt: "跑一下 pwd",
  options: [
    { value: "allow", label: "允许" },
    { value: "deny", label: "拒绝" },
  ],
  status,
  revision: 1,
  created_at: "2026-10-17T00:00:00Z",
  updated_at: "2026-10-17T00:00:00Z",
});

describe("等你处理的那一条", () => {
  it("说清是谁在问、问什么，并能就地回答", async () => {
    const answer = rstest.fn();
    const container = await render(
      <PendingStrip
        interactions={[interaction("i1", "a1")]}
        agents={agents}
        onAnswer={answer}
      />,
    );
    expect(container.textContent).toContain("乐子人");
    expect(container.textContent).toContain("跑一下 pwd");
    const allow = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "允许",
    )!;
    await act(async () => allow.click());
    expect(answer).toHaveBeenCalledWith("i1", "allow");
  });

  it("已经答过的不出现", async () => {
    const container = await render(
      <PendingStrip
        interactions={[interaction("i1", "a1", "resolved")]}
        agents={agents}
        onAnswer={() => {}}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("超过三条时把剩下的数出来，而不是无限往下排", async () => {
    const container = await render(
      <PendingStrip
        interactions={[
          interaction("i1", "a1"),
          interaction("i2", "a1"),
          interaction("i3", "a2"),
          interaction("i4", "a2"),
        ]}
        agents={agents}
        onAnswer={() => {}}
      />,
    );
    expect(container.textContent).toContain("还有 1 条在等你");
  });
});
