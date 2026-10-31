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
  carrier: "header",
  signaturePresent: false,
  signatureValid: null,
  decodeError: null,
  payload: {
    protocol: "eta-mp/1",
    v: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    from: {
      agentId: "agent-1",
      agentName: "Executor",
      sessionId: "session-1",
      conversationId: "task:t1",
      taskId: "t1",
      cwd: "/work/repo",
      mailThreadId: "thread-1",
    },
    work: {
      doing: "重做 mail 载荷",
      repo: "eta",
      branch: "feat/email-payload",
      paths: ["apps/eta/src/email"],
    },
    ask: { question: "这个设计好不好", needed: "看一眼 schema", by: null },
    decided: [{ text: "payload 是正文的超集", source: "message 12" }],
    human: { note: null, edited: false },
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
    expect(text).toContain("header");
    expect(text).not.toContain('"protocol"');
    await click(
      [...view.container.querySelectorAll("button")].find((element) =>
        element.textContent?.includes("展开完整上下文"),
      ),
    );
    expect(view.container.textContent).toContain("payload 是正文的超集");
    expect(view.container.textContent).toContain("/work/repo");
  });

  it("shows decoded routing context when the sender has no extra data", async () => {
    const view = await mount(
      <EmailMetaPanel meta={{ ...meta, payload: null }} />,
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
