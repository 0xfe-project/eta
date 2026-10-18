import { afterEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { agentUsage, surfaceHost, totals } from "@/test-inbox";
import { cleanup, flush, mount } from "@/test-render";
import { UsageLine } from "./usage-line";

describe("an agent's model usage", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
  });

  it("shows its tokens over 5 hours, a day and a week", async () => {
    surfaceHost({
      usage: [
        agentUsage("a1", {
          "5h": totals(800),
          "24h": totals(25_000),
          "7d": totals(1_230_000, 42),
        }),
      ],
    });
    const { container } = await mount(<UsageLine agentId="a1" />);
    await flush();
    expect(container.textContent).toBe(
      "模型用量：5 小时 800 · 24 小时 2.5万 · 7 天 123.0万 tokens（7 天 42 次请求）",
    );
  });

  it("says so when the agent has none this week", async () => {
    surfaceHost({ usage: [agentUsage("a1", { "7d": totals(10, 1) })] });
    const { container } = await mount(<UsageLine agentId="a2" />);
    await flush();
    expect(container.textContent).toBe("模型用量：近 7 天没有");
  });

  it("draws nothing before the host has said anything", async () => {
    surfaceHost();
    const { container } = await mount(<UsageLine agentId="a1" />);
    await flush();
    expect(container.textContent).toBe("");
  });

  it("follows the host as usage moves", async () => {
    const host = surfaceHost({
      usage: [agentUsage("a1", { "7d": totals(10, 1) })],
    });
    const { container } = await mount(<UsageLine agentId="a1" />);
    await flush();
    host.set("usage", {
      agents: [
        agentUsage("a1", { "5h": totals(500, 2), "7d": totals(900, 3) }),
      ],
    });
    await flush();
    expect(container.textContent).toContain("5 小时 500");
    expect(container.textContent).toContain("7 天 3 次请求");
  });
});
