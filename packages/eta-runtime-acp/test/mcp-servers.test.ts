/**
 * What eta hands an ACP agent as MCP servers, and when: a session closed and opened again in the
 * same conversation (what a changed plugin list does) sends the agent the list as it is then, in
 * the request the agent's capabilities choose (`session/resume`, `session/load`, or a new
 * session). The fake agent writes down every request it takes, so this is what the agent got.
 *
 * What the fake cannot say: whether a real agent keeps the servers of the native session it picks
 * up, or takes the ones that came with the pick-up. It only shows what was sent.
 */
import type { SessionMcpServer } from "@eta/client-contracts";
import type { ManagedSession } from "@eta/server";
import { MemorySessionStore, SessionManager } from "@eta/server";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpRuntimes } from "../src/index";
import { configFile, fakeAgent, until } from "./support";

const managers: SessionManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
});

const A: SessionMcpServer = {
  name: "alpha-search",
  type: "http",
  url: "https://alpha.example/mcp",
};
const B: SessionMcpServer = {
  name: "beta-docs",
  type: "http",
  url: "https://beta.example/mcp",
  headers: { "X-Beta": "b" },
};

function setup(env: Record<string, string>, first: SessionMcpServer[]) {
  const agent = fakeAgent("fake", { env });
  const warnings: string[] = [];
  const extras = { servers: first };
  const manager = new SessionManager({
    store: new MemorySessionStore(),
    modelsFor: () => {
      throw new Error("an eta model was asked for");
    },
    runtimes: createAcpRuntimes({
      configPath: configFile([agent.config]),
      warn: (message) => warnings.push(message),
    }),
    // What the plugins give now: read again at every open, as the host's `runtimeExtrasFor` is.
    runtimeExtrasFor: () => Promise.resolve({ mcpServers: extras.servers }),
  });
  managers.push(manager);
  return { manager, agent, warnings, extras };
}

async function run(managed: ManagedSession, prompt: string) {
  managed.session.kernel.nextRun(prompt);
  return await managed.session.runner.run();
}

const opens = (agent: ReturnType<typeof fakeAgent>) =>
  agent
    .log()
    .filter((entry) => /^session\/(?:new|resume|load)$/.test(entry.method))
    .map((entry) => ({
      method: entry.method,
      servers: (entry.mcpServers as { name: string }[]).map((s) => s.name),
      raw: entry.mcpServers as Record<string, unknown>[],
    }));

/** The same conversation: closed, then opened again, as a changed stamp does. */
async function reopen(
  manager: SessionManager,
  agent: ReturnType<typeof fakeAgent>,
  id: string,
): Promise<ManagedSession> {
  await manager.close(id);
  await until(
    () => agent.log().some((entry) => entry.method === "session/close"),
    "the close",
  );
  return (await manager.session(id))!;
}

describe("the MCP servers a reopened session sends", () => {
  it.each([
    ["session/resume", "resume"],
    ["session/load", "load"],
  ])(
    "reach an agent that picks the session up with %s, as the list is at the reopen",
    async (method, caps) => {
      const { manager, agent, extras } = setup({ FAKE_ACP_CAPS: caps }, [A]);
      const created = await manager.create({
        cwd: "/tmp",
        runtime: "acp.fake",
      });
      await run(created, "one");
      extras.servers = [A, B];
      const reopened = await reopen(manager, agent, created.meta.id);
      await run(reopened, "state");
      expect(
        opens(agent).map(({ method, servers }) => [method, servers]),
      ).toEqual([
        ["session/new", ["alpha-search"]],
        [method, ["alpha-search", "beta-docs"]],
      ]);
      // The new server went in whole: its address and its headers.
      expect(opens(agent)[1]!.raw[1]).toMatchObject({
        type: "http",
        url: "https://beta.example/mcp",
        headers: [{ name: "X-Beta", value: "b" }],
      });
    },
    20_000,
  );

  it("reach an agent that can neither resume nor load in a new session, with the new list", async () => {
    const { manager, agent, extras, warnings } = setup(
      { FAKE_ACP_CAPS: "none" },
      [A],
    );
    const created = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(created, "one");
    extras.servers = [A, B];
    const reopened = await reopen(manager, agent, created.meta.id);
    await run(reopened, "state");
    expect(
      opens(agent).map(({ method, servers }) => [method, servers]),
    ).toEqual([
      ["session/new", ["alpha-search"]],
      ["session/new", ["alpha-search", "beta-docs"]],
    ]);
    expect(warnings.join("\n")).toContain("cannot pick a session up again");
  }, 20_000);

  it("leaves an HTTP server out for an agent that takes none, and the warning names it", async () => {
    const { manager, agent, extras, warnings } = setup({ FAKE_ACP_HTTP: "0" }, [
      A,
    ]);
    const stdio: SessionMcpServer = {
      name: "gamma-local",
      command: "/bin/sh",
      args: ["-c", "true"],
    };
    extras.servers = [A, stdio];
    const created = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(created, "one");
    expect(opens(agent).map(({ servers }) => servers)).toEqual([
      ["gamma-local"],
    ]);
    expect(warnings.join("\n")).toContain(
      "the MCP server alpha-search is HTTP, which this agent does not take; left out",
    );
  }, 20_000);
});

describe("the line at the open of a runtime session", () => {
  const line = (warnings: string[]) =>
    warnings.filter((message) =>
      message.includes("opened the agent's session"),
    );

  it("tells the runtime, how the session opened and the names sent and left out", async () => {
    const { manager, agent, extras, warnings } = setup(
      { FAKE_ACP_HTTP: "0", FAKE_ACP_CAPS: "resume" },
      [A],
    );
    const stdio: SessionMcpServer = { name: "gamma-local", command: "/bin/sh" };
    extras.servers = [A, stdio];
    const created = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(created, "one");
    const reopened = await reopen(manager, agent, created.meta.id);
    await run(reopened, "state");
    expect(line(warnings)).toEqual([
      "[eta-runtime-acp] acp.fake: opened the agent's session (new); MCP servers sent: gamma-local; left out: alpha-search",
      "[eta-runtime-acp] acp.fake: opened the agent's session (resume); MCP servers sent: gamma-local; left out: alpha-search",
    ]);
  }, 20_000);

  it("says load for a session picked up with load, and none where there are no servers", async () => {
    const { manager, agent, extras, warnings } = setup(
      { FAKE_ACP_CAPS: "load" },
      [],
    );
    extras.servers = [];
    const created = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(created, "one");
    const reopened = await reopen(manager, agent, created.meta.id);
    await run(reopened, "state");
    expect(line(warnings)).toEqual([
      "[eta-runtime-acp] acp.fake: opened the agent's session (new); MCP servers sent: none; left out: none",
      "[eta-runtime-acp] acp.fake: opened the agent's session (load); MCP servers sent: none; left out: none",
    ]);
  }, 20_000);

  it("holds no address, header or environment value, only names", async () => {
    const { manager, agent, extras, warnings } = setup({}, []);
    extras.servers = [
      {
        name: "keyed-http",
        type: "http",
        url: "https://keyed.example/mcp?key=SECRET-URL-KEY",
        headers: { Authorization: "Bearer SECRET-HEADER-TOKEN" },
      },
      {
        name: "keyed-stdio",
        command: "/bin/sh",
        args: ["-c", "echo SECRET-ARG"],
        env: { API_KEY: "SECRET-ENV-VALUE" },
      },
    ];
    const created = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(created, "one");
    await reopen(manager, agent, created.meta.id);
    const all = line(warnings).join("\n");
    expect(all).toContain("sent: keyed-http, keyed-stdio");
    for (const secret of [
      "SECRET",
      "keyed.example",
      "https://",
      "Bearer",
      "Authorization",
      "API_KEY",
      "echo",
    ])
      expect(all).not.toContain(secret);
    // Nothing else the runtime says carries them either.
    expect(warnings.join("\n")).not.toContain("SECRET");
  }, 20_000);
});
