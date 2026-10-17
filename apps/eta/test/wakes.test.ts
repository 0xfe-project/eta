import type { Host } from "../src/host";
/**
 * A wake becomes a run (REFACTOR.md §9, P2.2).
 *
 * The claim is "one session per (agent × group), and it is the same one next time — including
 * after the process dies". So the tests post twice into one group and compare session ids, then
 * restart the host and post a third time: a mapping that lives in memory would pass the first
 * check and fail the third, which is the whole reason this step writes it to disk.
 *
 * The other half is who *does not* get a session: an agent that was not woken has no conversation
 * in that group, and the session that does exist belongs to the agent that was named — under that
 * agent's own model, and counted under that agent's name in the usage ledger.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const CONFIG = {
  providers: [
    {
      id: "local",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [{ id: "m1" }, { id: "m2" }],
    },
  ],
  defaultModel: "local:m1",
};

const answer = (text: string) =>
  assistantMessage({
    content: [{ type: "text", text }],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-wakes-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  return root;
}

async function start(dataDir: string, script: string[]): Promise<Host> {
  const host = await assembleHost({
    dataDir,
    port: 0,
    warn: () => undefined,
    models: fakeModels(script.map(answer)),
  });
  hosts.push(host);
  return host;
}

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

const send = (
  host: Host,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  fetch(url(host, path), {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

interface Reply {
  agentId: string;
  sessionId: string;
  status: string;
  text: string;
}

interface Posted {
  message: { id: string; seq: number };
  woke: string[];
  replies: Reply[];
}

const say = async (
  host: Host,
  groupId: string,
  body: unknown,
): Promise<Posted> => {
  const response = await send(
    host,
    "POST",
    `/groups/${groupId}/messages`,
    body,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as Posted;
};

async function newAgent(
  host: Host,
  name: string,
  model?: string,
): Promise<string> {
  const response = await send(host, "POST", "/agents", {
    name,
    ...(model === undefined ? {} : { model }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { agent: { id: string } }).agent.id;
}

async function newGroup(
  host: Host,
  name: string,
  agentIds: string[],
): Promise<string> {
  const response = await send(host, "POST", "/groups", {
    name,
    agentIds,
  });
  return ((await response.json()) as { group: { id: string } }).group.id;
}

const cwdOf = async (
  host: Host,
  sessionId: string,
): Promise<string | undefined> => {
  const body = (await (await send(host, "GET", "/sessions")).json()) as {
    sessions: {
      ok: boolean;
      id: string;
      meta?: { cwd: string };
    }[];
  };
  return body.sessions.find((session) => session.id === sessionId)?.meta?.cwd;
};

const sessionOf = async (
  host: Host,
  groupId: string,
  agentId: string,
): Promise<string | undefined> => {
  const group = (await (
    await send(host, "GET", `/groups/${groupId}`)
  ).json()) as {
    participants: { agentId: string; sessionId?: string }[];
  };
  return group.participants.find(
    (participant) => participant.agentId === agentId,
  )?.sessionId;
};

describe("memory follows the group's directory", () => {
  it("reads the project's notes from the group's folder, not from wherever the host started", async () => {
    const dataDir = await scratch();
    const project = await scratch();
    const models = fakeModels([answer("read them")]);
    const host = await assembleHost({
      dataDir,
      port: 0,
      warn: () => undefined,
      models,
    });
    hosts.push(host);

    // A note kept by this project, in the place the harness looks for it.
    await mkdir(join(project, ".eta"), { recursive: true });
    await writeFile(
      join(project, ".eta", "MEMORY.md"),
      "# eta memory (untrusted)\n\n## decision\n\n- [notes#1] the build runs from the project root\n",
      "utf8",
    );

    const agent = await newAgent(host, "builder");
    const created = (await (
      await send(host, "POST", "/groups", {
        name: "app",
        cwd: project,
        agentIds: [agent],
      })
    ).json()) as { group: { id: string } };
    await say(host, created.group.id, {
      text: "what do we know",
      mentions: [agent],
    });

    // What the model was actually told: the project's note, and the file it came from.
    const system = models.calls.at(-1)?.context.systemPrompt ?? "";
    expect(system).toContain("untrusted notes collected earlier");
    expect(system).toContain("the build runs from the project root");
  });
});

describe("the directory a group's sessions run in", () => {
  it("is the group's own, and the host's only when the group has none", async () => {
    const dataDir = await scratch();
    const project = await scratch();
    const host = await start(dataDir, ["bound", "unbound"]);
    const agent = await newAgent(host, "builder");

    const bound = (await (
      await send(host, "POST", "/groups", {
        name: "app",
        cwd: project,
        agentIds: [agent],
      })
    ).json()) as { group: { id: string } };

    const said = await say(host, bound.group.id, {
      text: "where are we",
      mentions: [agent],
    });
    const sessionId = said.replies[0]?.sessionId as string;
    expect(await cwdOf(host, sessionId)).toBe(project);

    // A group nobody bound keeps working, in the host's directory: the fallback is real, and it
    // is what every session did before groups had a folder of their own.
    const unbound = await newGroup(host, "loose", [agent]);
    const loose = await say(host, unbound, {
      text: "and here",
      mentions: [agent],
    });
    const looseId = loose.replies[0]?.sessionId as string;
    expect(await cwdOf(host, looseId)).toBe(process.cwd());
  });
});

describe("one session per (agent × group)", () => {
  it("reuses the agent's session for its next message in the same group", async () => {
    const dataDir = await scratch();
    const host = await start(dataDir, ["first answer", "second answer"]);
    const named = await newAgent(host, "reviewer");
    const other = await newAgent(host, "writer");
    const groupId = await newGroup(host, "release", [named, other]);

    const first = await say(host, groupId, {
      text: "have a look",
      mentions: [named],
    });
    expect(first.replies).toHaveLength(1);
    const [reply] = first.replies;
    expect(reply?.agentId).toBe(named);
    expect(reply?.text).toBe("first answer");
    expect(await sessionOf(host, groupId, named)).toBe(reply?.sessionId);

    const second = await say(host, groupId, {
      text: "and again",
      mentions: [named],
    });
    expect(second.replies[0]?.sessionId).toBe(reply?.sessionId);

    // Both messages are in that one session's own transcript.
    const transcript = (await (
      await send(host, "GET", `/sessions/${reply?.sessionId}/messages`)
    ).json()) as { messages: { role: string; text: string }[] };
    const said = transcript.messages.filter(
      (message) => message.role === "user",
    );
    expect(said).toHaveLength(2);
    expect(said[0]?.text).toContain("have a look");
    expect(said[1]?.text).toContain("and again");

    // The agent that was never named has no conversation here.
    expect(await sessionOf(host, groupId, other)).toBeUndefined();
    // And the wake it never got is not waiting for it.
    expect(host.groups.wakes(groupId, other)).toEqual([]);
  });

  it("keeps the mapping across a restart: a new process reads the same rows", async () => {
    const dataDir = await scratch();
    const first = await start(dataDir, ["before the restart"]);
    const agent = await newAgent(first, "keeper");
    const groupId = await newGroup(first, "long runner", [agent]);
    const before = await say(first, groupId, { text: "one" });
    const sessionId = before.replies[0]?.sessionId;
    expect(sessionId).toBeDefined();
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    // Nothing was carried over: this is a new process with the same data directory.
    const second = await start(dataDir, ["after the restart"]);
    const after = await say(second, groupId, { text: "two" });
    expect(after.replies[0]?.sessionId).toBe(sessionId);

    // And the session it reused still holds what was said before the restart.
    const transcript = (await (
      await send(second, "GET", `/sessions/${sessionId}/messages`)
    ).json()) as { messages: { role: string; text: string }[] };
    expect(
      transcript.messages.some((message) => message.text.includes("one")),
    ).toBe(true);
    expect(
      transcript.messages.some((message) => message.text.includes("two")),
    ).toBe(true);
  });

  it("runs the agent's own model, and counts the tokens under the agent", async () => {
    const dataDir = await scratch();
    const host = await start(dataDir, ["sure"]);
    const agent = await newAgent(host, "specific", "local:m2");
    const groupId = await newGroup(host, "solo", [agent]);

    const posted = await say(host, groupId, { text: "hello" });
    const sessionId = posted.replies[0]?.sessionId;
    const meta = (await (
      await send(host, "GET", `/sessions/${sessionId}/messages`)
    ).json()) as {
      meta: { agentId?: string; groupId?: string; model?: string };
    };
    // The session says what it belongs to, and which model it runs.
    expect(meta.meta.agentId).toBe(agent);
    expect(meta.meta.groupId).toBe(groupId);
    expect(meta.meta.model).toBe("local:m2");

    // The usage ledger names the agent, not the session — which is what `agentId` is for.
    const usage = (await (await send(host, "GET", "/usage/agents")).json()) as {
      agents: {
        subject: string;
        windows: { hours: number; requests: number }[];
      }[];
    };
    expect(usage.agents.map((entry) => entry.subject)).toEqual([agent]);
    expect(
      usage.agents[0]?.windows.find((window) => window.hours === 5)?.requests,
    ).toBe(1);
  });

  it("marks the wake taken, so the same message is not delivered twice", async () => {
    const dataDir = await scratch();
    const host = await start(dataDir, ["once"]);
    const agent = await newAgent(host, "once-only");
    const groupId = await newGroup(host, "solo", [agent]);

    const posted = await say(host, groupId, { text: "hello" });
    expect(host.groups.wakes(groupId, agent).map((wake) => wake.state)).toEqual(
      ["taken"],
    );
    // Delivering again finds nothing queued: no second run, no second answer.
    expect(
      await host.groups
        .wakes(groupId)
        .filter((wake) => wake.state === "queued"),
    ).toEqual([]);
    expect(posted.replies[0]?.text).toBe("once");
  });
});
