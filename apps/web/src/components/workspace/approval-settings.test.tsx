import { afterEach, describe, expect, it } from "@rstest/core";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { setWire } from "@/lib/wire";
import { surfaceHost } from "@/test-inbox";
import { agentView, conversationView, memberView } from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { ApprovalSettings } from "./approval-settings";

const Settings = () => (
  <NuqsTestingAdapter>
    <ApprovalSettings />
  </NuqsTestingAdapter>
);

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the tools that ask first", () => {
  it("lists them and replaces the list when one is added", async () => {
    const host = surfaceHost({ approvals: ["bash"] });
    host.handle("inbox.setApprovals", (args) => ({
      approvals: { tools: (args as { tools: string[] }).tools },
    }));
    const { container } = await mount(<Settings />);
    await flush();
    expect(container.querySelector("ul")?.textContent).toBe("bash");
    const input = container.querySelector("input")!;
    expect(button(container, "添加")?.hasAttribute("disabled")).toBe(true);
    type(input, "write");
    await flush();
    await click(button(container, "添加"));
    await flush();
    expect(host.calls).toEqual([
      {
        target: "inbox",
        action: "setApprovals",
        args: { tools: ["bash", "write"] },
      },
    ]);
  });

  it("removes one", async () => {
    const host = surfaceHost({ approvals: ["bash", "write"] });
    host.handle("inbox.setApprovals", () => ({}));
    const { container } = await mount(<Settings />);
    await flush();
    await click(container.querySelector('[aria-label="移除 bash"]'));
    await flush();
    expect(host.calls[0]?.args).toEqual({ tools: ["write"] });
  });

  it("suggests the tools of the open conversation's session", async () => {
    const host = surfaceHost({
      agents: [agentView({ id: "a1" })],
      conversations: [
        conversationView({
          id: "g1",
          participants: [memberView("a1", { sessionId: "s1" })],
        }),
      ],
      approvals: ["bash"],
    });
    host.target("sessions.s1", {
      core: { session: "s1", running: false },
      tools: [
        { name: "bash", description: "run" },
        { name: "write", description: "write a file" },
      ],
    });
    host.handle("sessions.resync", () => ({}));
    const { container } = await mount(<Settings />);
    await flush(10);
    // Already on the list, so not offered again.
    expect(
      [...container.querySelectorAll("datalist option")].map((o) =>
        o.getAttribute("value"),
      ),
    ).toEqual(["write"]);
  });
});
