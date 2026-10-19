import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { agentView, productHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { MemberRing } from "./member-ring";

let host: ReturnType<typeof productHost>;

const chars = (n: number, letter: string) => letter.repeat(n);

/**
 * A session with about 2,354 tokens in the window: 100,000 characters of it sit before the last
 * compaction and are not in it. Four characters to the token is the estimate the ring draws by, so
 * the numbers below are the ones a reader would work out by hand.
 */
function session(overrides: Record<string, unknown> = {}) {
  return {
    core: { session: "s1", running: false },
    model: { id: "p:m1", thinkingLevel: "off" },
    transcript: {
      messages: [
        {
          entryId: "old",
          seq: 1,
          at: 0,
          message: { role: "user", content: chars(100_000, "o") },
        },
        {
          entryId: "sum",
          seq: 2,
          at: 0,
          message: { role: "compactionSummary", summary: chars(400, "s") },
        },
        {
          entryId: "u",
          seq: 3,
          at: 0,
          message: { role: "user", content: chars(4000, "a") },
        },
        {
          entryId: "a",
          seq: 4,
          at: 0,
          message: { role: "assistant", content: chars(2000, "b") },
        },
        {
          entryId: "t",
          seq: 5,
          at: 0,
          message: { role: "toolResult", content: chars(1000, "c") },
        },
      ],
    },
    prompt: { stableChars: 800, adaptiveChars: 2000, sections: [] },
    // Long enough to be a slice: the ring drops anything thinner than its gap.
    tools: [{ name: "bash", description: chars(400, "d") }],
    ...overrides,
  };
}

/** The providers page as the ring reads it: one model, and the window it has. */
function providers(contextWindow: number) {
  return {
    config: {
      revision: "r1",
      providers: [
        {
          id: "p",
          name: "P",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:1/v1",
          hasApiKey: true,
          models: [{ id: "m1", name: "M1", contextWindow }],
        },
      ],
    },
  };
}

beforeEach(() => {
  host = productHost({ agents: [agentView({ id: "a1", name: "乐子人" })] });
  host.target("providers", providers(4000), { eager: true });
  host.target("sessions.s1", session());
  host.handle("sessions.resync", () => ({}));
});
afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

const ring = async () => {
  const { container } = await mount(
    <MemberRing sessionId="s1">
      <span>头像</span>
    </MemberRing>,
  );
  await flush();
  const svg = container.querySelector("svg")!;
  return {
    container,
    title: container.querySelector("span")!.getAttribute("title") ?? "",
    slices: [...svg.querySelectorAll("circle")].slice(1),
  };
};

describe("成员头像上的上下文环", () => {
  it("量的是窗口有多满，不是这个成员花了多少钱", async () => {
    const { title, slices } = await ring();
    // 2,451 tokens of a 4,000-token window: the ring is over half full because the window is.
    expect(title).toContain("61%");
    expect(title).toContain("4k");
    expect(slices).toHaveLength(6);
  });

  it("只算最后一次压缩之后的那部分", async () => {
    const { title } = await ring();
    // The 100,000 characters before the summary are on disk, not in the window. Counting them
    // would read 27,354 used, not 2,354.
    expect(title).toContain("2,451");
    expect(title).not.toContain("27,451");
  });

  it("每一段说得出自己的来源和大约多少 token", async () => {
    const { slices } = await ring();
    const labels = slices.map(
      (slice) => slice.querySelector("title")?.textContent ?? "",
    );
    expect(labels).toEqual([
      expect.stringMatching(/^系统提示: ~200 tokens$/),
      expect.stringMatching(/^对话: ~300 tokens$/),
      expect.stringMatching(/^用户: ~1,?000 tokens$/),
      expect.stringMatching(/^助手: ~600 tokens$/),
      expect.stringMatching(/^工具定义: ~101 tokens$/),
      expect.stringMatching(/^工具结果: ~250 tokens$/),
    ]);
  });

  it("模型不在目录里时按 128k 算，不画成一个满环", async () => {
    host.target(
      "sessions.s1",
      session({ model: { id: "gone:away", thinkingLevel: "off" } }),
    );
    const { title } = await ring();
    expect(title).toContain("128k");
    expect(title).toContain("2%");
  });

  it("窗口比已经装进去的还小时，环满但不溢出，比例照实说", async () => {
    host.target("providers", providers(1000), { eager: true });
    const { title, slices } = await ring();
    // 2,451 into a 1,000-token window: 245%, and the ring is simply full.
    expect(title).toContain("245%");
    for (const slice of slices) {
      const drawn = Number(
        (slice.getAttribute("stroke-dasharray") ?? "").split(" ")[0],
      );
      expect(drawn).toBeGreaterThan(0);
      expect(drawn).toBeLessThanOrEqual(2 * Math.PI * 20);
    }
  });

  it("窗口几乎是空的时候不画碎屑", async () => {
    host.target("sessions.s1", session({ transcript: { messages: [] } }));
    const { slices } = await ring();
    // Nothing but the prompt: the tool results and the conversation are gone with the transcript,
    // and what is left of a 4,000-token window is too thin to be a slice.
    expect(slices.length).toBeLessThan(6);
  });
});
