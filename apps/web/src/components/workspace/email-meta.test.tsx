import type { EmailMetaView } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, click, mount } from "@/test-render";
import { EmailMetaPanel } from "./email-meta";

const meta: EmailMetaView = {
  protocol: "eta-mp/1",
  agentId: "agent-1",
  agentName: "Executor",
  sessionId: "session-1",
  logicalSessionId: "thread-1",
  mailThreadId: "thread-1",
  taskId: null,
  packetCount: 7,
  signaturePresent: false,
  signatureValid: null,
  decodeError: null,
  context: {
    from: "alice",
    steps: ["send", "handoff", "reply"],
    nested: { purpose: "demo" },
  },
};

afterEach(cleanup);

describe("email metadata", () => {
  it("shows readable fields instead of raw JSON", async () => {
    const view = await mount(<EmailMetaPanel meta={meta} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("智能体通信上下文");
    expect(text).toContain("7 个数据点");
    expect(text).toContain("Executor");
    expect(text).toContain("session-1");
    expect(text).toContain("send · handoff · reply");
    expect(text).toContain("purpose");
    expect(text).not.toContain('"protocol"');
    await click(
      [...view.container.querySelectorAll("button")].find((element) =>
        element.textContent?.includes("展开完整上下文"),
      ),
    );
    expect(view.container.textContent).toContain("demo");
  });

  it("shows decoded routing context when the sender has no extra data", async () => {
    const view = await mount(
      <EmailMetaPanel meta={{ ...meta, context: {} }} />,
    );
    const text = view.container.textContent ?? "";
    expect(text).toContain("Executor");
    expect(text).toContain("通信链路");
    expect(text).toContain("无额外业务上下文");
    expect(text).toContain("Agent、Session 和邮件线程信息");
    expect(text).toContain("查看技术详情");
    expect(text).toContain("agent-1");
  });
});
