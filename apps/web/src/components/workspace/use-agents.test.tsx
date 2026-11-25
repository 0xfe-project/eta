import type { FakeHost } from "@/test-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const navigation = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./use-groups", () => ({
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

/** What the page asked the host to do, in order: `target.action`. */
const ops = (host: FakeHost) =>
  host.calls.map((call) => `${call.target}.${call.action}`);

/** An agent's own chat as the host makes one: a group of one, in the agent's home project. */
const ownChat = (id: string, agentId: string) =>
  conversationView({
    id,
    projectId: `home-${agentId}`,
    stewardId: agentId,
    participants: [memberView(agentId)],
  });

/** A host whose `conversations.create` answers with a chat of the agent alone, as the host's does. */
const hostOf = (seed: Parameters<typeof productHost>[0]) => {
  const host = productHost(seed);
  host.handle("conversations.create", () => {
    const conversation = ownChat("own-a1", "a1");
    // The host publishes the row as part of making it, before the call answers.
    host.set("conversations", { list: [conversation] });
    return { conversation };
  });
  return host;
};

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  navigation.open.mockClear();
});

describe("opening an agent", () => {
  it("makes its chat once, and opens that one however often it is pressed", async () => {
    const host = hostOf({ agents: [agentView({ id: "a1" })] });
    const { container } = await mount(<Open agentId="a1" />);
    // Pressing twice is one conversation: the first press makes it, the second finds it.
    await click(container.querySelector("button"));
    await click(container.querySelector("button"));
    await flush();
    expect(ops(host)).toEqual(["conversations.create"]);
    expect(host.calls[0]?.args).toEqual({
      projectId: "home-a1",
      agentIds: ["a1"],
      stewardId: "a1",
    });
    // The host has no `agents.direct`: nothing asks for one.
    expect(ops(host)).not.toContain("agents.direct");
    expect(navigation.open.mock.calls).toEqual([["own-a1"], ["own-a1"]]);
    expect(useWorkspaceStore.getState().workspace.selectedAgentId).toBe("a1");
  });

  it("opens the chat an agent already has, and makes nothing", async () => {
    const host = hostOf({
      agents: [agentView({ id: "a1" })],
      conversations: [ownChat("own-a1", "a1")],
    });
    const { container } = await mount(<Open agentId="a1" />);
    await click(container.querySelector("button"));
    await flush();
    expect(ops(host)).toEqual([]);
    expect(navigation.open).toHaveBeenCalledWith("own-a1");
  });

  it("leaves an agent's group of one in another project alone, and makes its own", async () => {
    // A group of one in somebody else's project is that project's row, not this agent's chat.
    const host = hostOf({
      agents: [agentView({ id: "a1" })],
      conversations: [
        conversationView({ id: "elsewhere", participants: [memberView("a1")] }),
      ],
    });
    const { container } = await mount(<Open agentId="a1" />);
    await click(container.querySelector("button"));
    await flush();
    expect(ops(host)).toEqual(["conversations.create"]);
    expect(navigation.open).toHaveBeenCalledWith("own-a1");
  });

  it("makes a new chat when the one it had is put away", async () => {
    const host = hostOf({
      agents: [agentView({ id: "a1" })],
      conversations: [{ ...ownChat("own-a1", "a1"), archived: true }],
    });
    const { container } = await mount(<Open agentId="a1" />);
    await click(container.querySelector("button"));
    await flush();
    expect(ops(host)).toEqual(["conversations.create"]);
    expect(navigation.open).toHaveBeenCalledWith("own-a1");
  });
});
