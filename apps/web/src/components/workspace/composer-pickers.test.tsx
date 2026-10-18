import { afterEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { cleanup, click, flush, mount } from "@/test-render";
import { providersHost } from "@/test-wire";
import { ModelChip, ThinkingChip } from "./composer-pickers";

function host() {
  const fake = providersHost({
    revision: "r1",
    providers: [
      {
        id: "local",
        name: "Local",
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:1/v1",
        hasApiKey: true,
        models: [
          { id: "m1", name: "Model One" },
          { id: "m2", name: "Model Two" },
        ],
      },
    ],
  });
  fake.target("sessions.s1", {
    core: { session: "s1", running: false },
    model: { id: "local:m1", thinkingLevel: "off" },
  });
  fake.handle("sessions.resync", () => ({}));
  fake.handle("sessions.modelSet", () => ({}));
  fake.handle("sessions.thinkingLevel", () => ({}));
  return fake;
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("单聊的两个 chip", () => {
  it("说的是这个会话真正在跑的模型，不是设置里的默认", async () => {
    host();
    const { container } = await mount(<ModelChip sessionId="s1" />);
    await flush();
    expect(container.textContent).toContain("local:m1");
  });

  it("思考档显示当前值", async () => {
    host();
    const { container } = await mount(<ThinkingChip sessionId="s1" />);
    await flush();
    expect(container.textContent).toContain("think:off");
  });

  it("换思考档走会话的 thinkingLevel", async () => {
    const fake = host();
    const { container } = await mount(<ThinkingChip sessionId="s1" />);
    await flush();
    const trigger = container.querySelector("button");
    // Radix opens its menu on pointer down.
    trigger?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    await flush();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) =>
      i.textContent?.includes("high"),
    );
    await click(item);
    await flush();
    expect(
      fake.calls.find((call) => call.action === "thinkingLevel")?.args,
    ).toEqual({ session: "s1", level: "high" });
  });

  it("没有会话时不画", async () => {
    host();
    const model = await mount(<ModelChip sessionId={undefined} />);
    expect(model.container.textContent).toBe("");
    const thinking = await mount(<ThinkingChip sessionId={undefined} />);
    expect(thinking.container.textContent).toBe("");
  });
});
