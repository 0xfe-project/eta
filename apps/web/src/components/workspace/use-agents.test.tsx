import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  memberView,
  productHost,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { useOpenAgent } from "./use-agents";
import { useWorkspaceStore } from "./workspace-store";

const navigation = rstest.hoisted(() => ({ open: rstest.fn() }));
rstest.mock("./use-groups", () => ({
  useOpenGroup: () => navigation.open,
}));

function Open({ agentId }: { agentId: string }) {
  const open = useOpenAgent();
  return (
    <button type="button" onClick={() => open(agentId)}>
      open
    </button>
  );
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  navigation.open.mockClear();
});

describe("opening an agent", () => {
  it("asks the host for its private chat and opens what it answers with", async () => {
    const host = productHost({ agents: [agentView({ id: "a1" })] });
    host.handle("agents.direct", () => ({
      conversation: conversationView({
        id: "dm1",
        kind: "direct",
        participants: [memberView("a1")],
      }),
    }));
    const { container } = await mount(<Open agentId="a1" />);
    // Pressing twice is harmless: the host finds the chat it made.
    await click(container.querySelector("button"));
    await click(container.querySelector("button"));
    await flush();
    expect(host.calls.map((call) => [call.action, call.args])).toEqual([
      ["direct", { agentId: "a1" }],
      ["direct", { agentId: "a1" }],
    ]);
    expect(navigation.open).toHaveBeenCalledWith("dm1");
    expect(useWorkspaceStore.getState().workspace.selectedAgentId).toBe("a1");
  });
});
