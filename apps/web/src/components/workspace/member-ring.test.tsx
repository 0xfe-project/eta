import type { Replay } from "../../../../../test/fixtures/member-context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setWire } from "@/lib/wire";
import { productHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { memberSnapshot } from "../../../../../test/fixtures/member-context";
import { MemberRing } from "./member-ring";
import { MemberStats } from "./member-stats";

let host: ReturnType<typeof productHost>;
beforeEach(() => {
  host = productHost({});
  host.handle("sessions.resync", () => ({}));
});
afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("member context", () => {
  for (const [scenario, detail, arcs] of [
    ["acp", "50% · 64,000 / 128,000 tokens", 1],
    ["codex", "25% · 32,000 / 128,000 tokens", 1],
    ["missing", "N/A · 尚未上报上下文读数", 0],
    ["legacy", "N/A · 缺少可靠的最近调用读数或窗口", 0],
    ["noWindow", "N/A · 缺少有效的上下文窗口", 0],
    ["compacted", "N/A · 等待压缩后的新读数", 0],
    ["overflow", "N/A · 上下文读数超出有效范围", 0],
    ["empty", "0% · 0 / 128,000 tokens", 0],
    ["full", "100% · 128,000 / 128,000 tokens", 1],
    ["switched", "N/A · 等待新模型的读数", 0],
    ["estimated", "约 13% · 16,000 / 128,000 tokens", 1],
  ] satisfies [Replay, string, number][]) {
    it(scenario, async () => {
      host.target("sessions.a", memberSnapshot("a", scenario));
      const { container } = await mount(
        <>
          <MemberRing sessionId="a">A</MemberRing>
          <MemberStats sessionId="a" inline />
        </>,
      );
      await flush();
      expect(container.querySelector("span")!.title).toContain(detail);
      expect(
        container.querySelectorAll("circle[stroke-dasharray]"),
      ).toHaveLength(arcs);
      if (scenario === "acp")
        expect(container.textContent).toContain("in — · out — · cache —");
      if (scenario === "codex")
        expect(container.textContent).toContain(
          "in 240.0k · out 0 · cache 1.0k (部分)",
        );
    });
  }

  it("an older Host with only the 608,324-character transcript has no reading", async () => {
    host.target("sessions.a", {
      transcript: {
        messages: [{ message: { role: "user", content: "x".repeat(608324) } }],
      },
      tools: [],
    });
    const { container } = await mount(<MemberRing sessionId="a">A</MemberRing>);
    await flush();
    expect(container.querySelector("span")!.title).toContain(
      "N/A · 尚未上报上下文读数",
    );
  });
});
