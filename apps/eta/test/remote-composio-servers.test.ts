import type { SessionMcpServer } from "@eta/client-contracts";
import type { OarRuntimes } from "@eta/runtime-oar";
import type { AgentRecord } from "../src/agents/store";
/**
 * A Composio toolkit reaches a daemon's external runtime: the primary names the servers in the open
 * (`OpenSessionArgs.mcpServers`), the daemon attaches them after the agent's plugins' and keeps an
 * installed plugin's server of the same name. Fake servers and fake keys only; nothing reaches a
 * network.
 */
import type { MachineLink } from "../src/machines/hub";
import type { MachineRecord } from "../src/machines/store";
import type { Plugins } from "../src/plugins/service";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { createOarRuntimes } from "@eta/runtime-oar";
import { describe, expect, it } from "vitest";
import { RemotePlace } from "../src/machines/remote-place";
import { tempDir } from "./support/host";
import { remoteWorld } from "./support/remote";

const KEY = "ck_test_SECRET_fake_0123456789";
const TOOLKIT: SessionMcpServer = {
  name: "composio-gmail",
  type: "http",
  url: "http://composio.fake.test/tool_router/sess-1/mcp",
  headers: { "x-api-key": KEY },
};

/** What `machine.open` was called with, from a place whose plugins give these servers. */
async function opened(runtime: "eta" | "codex", servers: SessionMcpServer[]) {
  const calls: Record<string, unknown>[] = [];
  const link = {
    machineId: "m1",
    machine: async (action: string, args: Record<string, unknown>) => {
      if (action === "open") calls.push(args);
      return { session: "s1" };
    },
  } as unknown as MachineLink;
  const place = new RemotePlace({
    hub: { link: () => link, onReady: () => () => undefined } as never,
    mirrors: { register: () => undefined } as never,
    models: () => undefined,
    defaults: async () => ({}),
    hooks: () => undefined,
    plugins: {
      openOn: async () => [],
      redactionsFor: () => [{ value: KEY, label: "[secret composio api key]" }],
      toolkitServersFor: () => servers,
    } as unknown as Plugins,
    home: await tempDir("eta-place-home-"),
    forward: async () => undefined,
    warn: () => undefined,
  });
  await place.ensure({
    conversation: { id: "c1", name: "Group" },
    agent: {
      id: "ada",
      name: "Ada",
      runtime,
      model: null,
      thinkingLevel: null,
      persona: "",
    } as unknown as AgentRecord,
    machine: { id: "m1", name: "laptop", status: "online" } as MachineRecord,
    cwd: "/work",
    existing: null,
    prompt: "",
    stamp: "s",
    created: () => undefined,
  });
  return calls[0]!;
}

describe("what the primary opens a daemon's session with", () => {
  it("names the agent's toolkit servers on an external runtime, and still sends the redactions", async () => {
    const open = await opened("codex", [TOOLKIT]);
    expect(open.mcpServers).toEqual([TOOLKIT]);
    expect(open.redactions).toContainEqual({
      value: KEY,
      label: expect.stringContaining("composio"),
    });
  });

  it("leaves the field out when there is nothing to name, and on eta's own loop", async () => {
    expect(await opened("codex", [])).not.toHaveProperty("mcpServers");
    expect(await opened("eta", [TOOLKIT])).not.toHaveProperty("mcpServers");
  });
});

describe("what a daemon's external runtime is given", () => {
  /** A daemon whose codex is a script, and every `open` its runtimes were asked for. */
  async function daemon() {
    const inner = createOarRuntimes({
      registry: createRuntimeRegistry([
        scriptedRuntime({ id: "codex", turn: (turn) => turn.say("ok") }),
      ]),
    });
    const seen: { mcpServers?: readonly SessionMcpServer[] }[] = [];
    const runtimes = Object.assign(Object.create(inner), {
      open: (input: { mcpServers?: readonly SessionMcpServer[] }) => {
        seen.push(input);
        return inner.open(input as never);
      },
    }) as OarRuntimes;
    const r = await remoteWorld({}, { node: { runtimes } });
    const link = r.host.product.hub.link(r.daemon.machineId)!;
    const open = async (extra: Record<string, unknown>) =>
      await link.machine("open", {
        cwd: r.dir,
        title: "t",
        agentId: "ada",
        conversationId: "c1",
        runtime: "codex",
        agentPrompt: "",
        stamp: "s",
        tools: [],
        ...extra,
      });
    return { seen, open };
  }

  it("attaches the servers the primary named", async () => {
    const { seen, open } = await daemon();
    await open({ mcpServers: [TOOLKIT] });
    expect(seen.at(-1)?.mcpServers).toEqual([TOOLKIT]);
  });

  it("attaches none, and fails nothing, when an older primary names none", async () => {
    const { seen, open } = await daemon();
    await open({});
    expect(seen.at(-1)?.mcpServers ?? []).toEqual([]);
  });

  it("gives no two servers of one name", async () => {
    const { seen, open } = await daemon();
    await open({
      mcpServers: [TOOLKIT, { ...TOOLKIT, url: "http://other.fake.test/mcp" }],
    });
    expect(seen.at(-1)?.mcpServers).toEqual([TOOLKIT]);
  });
});
