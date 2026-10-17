import type { Host } from "../src/host";
/**
 * Groups (REFACTOR.md §9, P2.1).
 *
 * The claims that matter here are about *who gets woken*, because that is the rule the whole step
 * exists for: naming an agent wakes it, not naming one leaves it a reader, a group of one wakes
 * its member anyway, and agents naming each other spend a budget of five under the user message
 * the branch came from. Everything else (private groups, invitations, the timeline) is bookkeeping
 * around that rule.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WAKE_BUDGET } from "../src/groups/store";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function start(): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-groups-"));
  roots.push(root);
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
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

interface Agent {
  id: string;
  name: string;
}

interface Group {
  group: { id: string; name: string; private: boolean; cwd: string };
  participants: { agentId: string; sessionId?: string }[];
}

interface Posted {
  message: {
    id: string;
    seq: number;
    kind: string;
    text: string;
    mentions: string[];
  };
  woke: string[];
  capped: boolean;
  reminder?: { kind: string; text: string };
}

async function newAgent(host: Host, name: string): Promise<string> {
  const response = await send(host, "POST", "/agents", { name });
  expect(response.status).toBe(201);
  return ((await response.json()) as { agent: Agent }).agent.id;
}

async function newGroup(
  host: Host,
  name: string,
  agentIds: string[],
): Promise<string> {
  const response = await send(host, "POST", "/groups", { name, agentIds });
  expect(response.status).toBe(201);
  return ((await response.json()) as Group).group.id;
}

const post = async (host: Host, id: string, body: unknown): Promise<Posted> => {
  const response = await send(host, "POST", `/groups/${id}/messages`, body);
  expect(response.status).toBe(201);
  return (await response.json()) as Posted;
};

describe("groups and members", () => {
  it("records the directory a group works in, and can be given one later", async () => {
    const host = await start();
    const agent = await newAgent(host, "builder");

    const response = await send(host, "POST", "/groups", {
      name: "app",
      cwd: "/tmp/app",
      agentIds: [agent],
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as Group;
    expect(created.group.cwd).toBe("/tmp/app");

    // A folder can change; the change is a fact about the group, not a new group.
    const patched = await send(host, "PATCH", `/groups/${created.group.id}`, {
      cwd: "/tmp/elsewhere",
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as Group).group.cwd).toBe("/tmp/elsewhere");

    // Omitting it leaves it alone: a PATCH that says nothing about the folder is not a request
    // to clear it.
    const renamed = await send(host, "PATCH", `/groups/${created.group.id}`, {
      name: "app2",
    });
    expect(((await renamed.json()) as Group).group.cwd).toBe("/tmp/elsewhere");

    // A group made without a folder says so, rather than borrowing one.
    const bare = (await (
      await send(host, "POST", "/groups", {
        name: "unbound",
        agentIds: [agent],
      })
    ).json()) as Group;
    expect(bare.group.cwd).toBe("");
  });

  it("creates a group, invites and removes members", async () => {
    const host = await start();
    const first = await newAgent(host, "reviewer");
    const second = await newAgent(host, "writer");
    const third = await newAgent(host, "late");

    const id = await newGroup(host, "release", [first, second]);
    const group = (await (
      await send(host, "GET", `/groups/${id}`)
    ).json()) as Group;
    expect(
      group.participants.map((participant) => participant.agentId),
    ).toEqual([first, second]);

    expect(
      (
        await send(host, "POST", `/groups/${id}/participants`, {
          agentId: third,
        })
      ).status,
    ).toBe(201);
    const after = (await (
      await send(host, "GET", `/groups/${id}`)
    ).json()) as Group;
    expect(after.participants).toHaveLength(3);

    expect(
      (await send(host, "DELETE", `/groups/${id}/participants/${third}`))
        .status,
    ).toBe(204);
    expect(
      (await send(host, "DELETE", `/groups/${id}/participants/${third}`))
        .status,
    ).toBe(404);

    // Inviting someone twice is a conflict, not a second row.
    expect(
      (
        await send(host, "POST", `/groups/${id}/participants`, {
          agentId: first,
        })
      ).status,
    ).toBe(409);
    // And an agent that does not exist cannot be invited.
    expect(
      (
        await send(host, "POST", `/groups/${id}/participants`, {
          agentId: "nope",
        })
      ).status,
    ).toBe(404);
  });

  it("gives a new agent a private group, and refuses to change its members", async () => {
    const host = await start();
    const agent = await newAgent(host, "solo");

    const listed = (await (await send(host, "GET", "/groups")).json()) as {
      groups: Group[];
    };
    const own = listed.groups.find((group) => group.group.private);
    expect(own?.participants.map((participant) => participant.agentId)).toEqual(
      [agent],
    );

    // The only group an agent starts with is its own, and it has exactly one member.
    const other = await newAgent(host, "other");
    expect(
      (
        await send(host, "POST", `/groups/${own?.group.id}/participants`, {
          agentId: other,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await send(
          host,
          "DELETE",
          `/groups/${own?.group.id}/participants/${agent}`,
        )
      ).status,
    ).toBe(409);

    // Deleting the agent takes its private group with it.
    expect((await send(host, "DELETE", `/agents/${agent}`)).status).toBe(204);
    const after = (await (await send(host, "GET", "/groups")).json()) as {
      groups: Group[];
    };
    expect(
      after.groups.find((group) => group.group.id === own?.group.id),
    ).toBeUndefined();
  });
});

describe("who a message wakes", () => {
  it("wakes the named agents, and leaves the others as readers", async () => {
    const host = await start();
    const named = await newAgent(host, "named");
    const other = await newAgent(host, "other");
    const id = await newGroup(host, "release", [named, other]);

    const silent = await post(host, id, { text: "just thinking out loud" });
    expect(silent.woke).toEqual([]);
    expect(silent.message.mentions).toEqual([]);

    const asking = await post(host, id, {
      text: "have a look",
      mentions: [named],
    });
    expect(asking.woke).toEqual([named]);
    expect(asking.message.mentions).toEqual([named]);

    // What was decided is recorded, which is what P2.2 will take.
    const wakes = host.groups.wakes(id);
    expect(wakes.map((wake) => wake.agentId)).toEqual([named]);
    expect(wakes[0]?.state).toBe("queued");
    // The other agent is a reader: nothing is waiting for it.
    expect(host.groups.wakes(id, other)).toEqual([]);
  });

  it("wakes a group of one without being named", async () => {
    const host = await start();
    const only = await newAgent(host, "only");
    const id = await newGroup(host, "solo chat", [only]);

    const posted = await post(host, id, { text: "hello" });
    expect(posted.woke).toEqual([only]);
  });

  it("keeps a mention of a non-member as text only", async () => {
    const host = await start();
    const inside = await newAgent(host, "inside");
    const outside = await newAgent(host, "outside");
    const id = await newGroup(host, "release", [inside]);

    const posted = await post(host, id, {
      text: "asking inside",
      mentions: [outside],
    });
    // The only member is woken (a group of one), and the outsider is nobody's business.
    expect(posted.woke).toEqual([inside]);
    expect(host.groups.wakes(id, outside)).toEqual([]);
  });
});

describe("the wake budget", () => {
  it("lets agents hand work to each other five times, then the message is context", async () => {
    const host = await start();
    const first = await newAgent(host, "first");
    const second = await newAgent(host, "second");
    const id = await newGroup(host, "loop", [first, second]);

    const root = await post(host, id, { text: "start", mentions: [first] });
    const rootId = root.message.id;

    // An agent naming the other is a `mention` message, and the budget counts those.
    for (let round = 1; round <= WAKE_BUDGET; round += 1) {
      const turn = host.groups.postAgentMessage(id, {
        agentId: round % 2 === 1 ? first : second,
        text: `round ${round}`,
        mentions: [round % 2 === 1 ? second : first],
        rootMessageId: rootId,
      });
      expect(turn?.capped).toBe(false);
      expect(turn?.woke).toHaveLength(1);
      if (round === WAKE_BUDGET) {
        // The fifth one lands, with a reminder that the budget is spent.
        expect(turn?.reminder?.kind).toBe("system");
        expect(turn?.reminder?.text).toContain(String(WAKE_BUDGET));
      }
    }

    const over = host.groups.postAgentMessage(id, {
      agentId: first,
      text: "round six",
      mentions: [second],
      rootMessageId: rootId,
    });
    expect(over?.capped).toBe(true);
    expect(over?.woke).toEqual([]);
    // The message itself is still there — it is context now, not work.
    expect(over?.message.kind).toBe("mention");
    expect(
      host.groups
        .wakes(id, first)
        .filter((wake) => wake.messageId === over?.message.id),
    ).toEqual([]);

    // A new user message starts a new budget.
    const fresh = await post(host, id, {
      text: "start again",
      mentions: [first],
    });
    const again = host.groups.postAgentMessage(id, {
      agentId: first,
      text: "back to work",
      mentions: [second],
      rootMessageId: fresh.message.id,
    });
    expect(again?.capped).toBe(false);
    expect(again?.woke).toEqual([second]);
  });
});

describe("the timeline", () => {
  it("is ordered by seq, and answers since a cursor", async () => {
    const host = await start();
    const agent = await newAgent(host, "talker");
    const id = await newGroup(host, "chat", [agent]);

    await post(host, id, { text: "one" });
    await post(host, id, { text: "two" });
    await post(host, id, { text: "three" });

    const all = (await (
      await send(host, "GET", `/groups/${id}/messages`)
    ).json()) as {
      messages: { seq: number; text: string }[];
    };
    expect(all.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(all.messages.map((message) => message.text)).toEqual([
      "one",
      "two",
      "three",
    ]);

    const after = (await (
      await send(host, "GET", `/groups/${id}/messages?since=1`)
    ).json()) as {
      messages: { text: string }[];
    };
    expect(after.messages.map((message) => message.text)).toEqual([
      "two",
      "three",
    ]);
  });
});
