import type { Host } from "../src/host";
/**
 * The product API (REFACTOR.md §9, P2.4).
 *
 * The claim is "the existing web's queries get data", and the way to test that is to assert the
 * shapes the web's code actually reads: `snapshot.groups[].participants[].member`,
 * `snapshot.agents[].description`, `message.blocks[].text`, `message.status` in the product's
 * vocabulary, and an `event_cursor` a stream accepts. Our own rows look nothing like that, which
 * is the point of the layer.
 *
 * The lines the web's list view cannot do without are here too: an agent edit reaches a connected
 * client as `agent.updated`, a reply reaches it as `message.updated` twice (working, then the
 * answer), and a cursor older than what the server keeps answers 410 — the one answer that tells a
 * client to read the snapshot again instead of silently missing events.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";
import { sleep, sseReader } from "./support/sse";

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
      models: [{ id: "m1" }],
    },
  ],
  defaultModel: "local:m1",
};

async function startWithoutModels(): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-compat-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
  });
  hosts.push(host);
  return host;
}

async function start(
  answers: string[] = ["the answer"],
  hubCapacity?: number,
): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-compat-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
    models: fakeModels(
      answers.map((text) =>
        assistantMessage({ content: [{ type: "text", text }] }),
      ),
    ),
    ...(hubCapacity === undefined ? {} : { hubCapacity }),
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

const connect = (
  host: Host,
  path = "/api/v1/chat/stream",
  headers?: Record<string, string>,
): Promise<Response> =>
  fetch(url(host, path), headers === undefined ? {} : { headers });

async function connected(host: Host, count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (host.hub.subscriberCount < count && Date.now() < deadline)
    await sleep(10);
  expect(host.hub.subscriberCount).toBe(count);
}

interface Snapshot {
  groups: {
    id: string;
    name: string;
    kind: string;
    goal: string;
    /** The directory this conversation works in; "" when nobody has set one. */
    cwd: string;
    archived: boolean;
    last_seq: number;
    preview: string;
    revision: number;
    participants: {
      agent_id: string;
      member: boolean;
      name: string;
      status: string;
      session_id: string | null;
    }[];
  }[];
  agents: {
    id: string;
    name: string;
    description: string;
    model: string | null;
    bundles: string[];
    status: string;
    build_error: string | null;
    revision: number;
  }[];
  active_replies: {
    id: string;
    status: string;
    role: string;
    blocks: { type: string; text: string }[];
  }[];
  interactions: unknown[];
  event_cursor: string;
}

describe("the snapshot", () => {
  it("hands the web the shapes it reads", async () => {
    const host = await start();
    // Created through the product API, the way the web's editor does it.
    const created = await send(host, "POST", "/api/v1/agents", {
      name: "reviewer",
      description: "Review diffs.",
      bundles: ["git"],
    });
    expect(created.status).toBe(201);
    const agent = (await created.json()) as Snapshot["agents"][number];
    expect(agent).toMatchObject({
      name: "reviewer",
      // `description` is AXP's word for an agent's instructions.
      description: "Review diffs.",
      model: null,
      bundles: ["git"],
      // No card chosen: the project's default persona, said as an empty name rather than "none".
      persona: "",
      status: "idle",
      build_error: null,
      revision: 1,
    });

    const group = (
      (await (
        await send(host, "POST", "/groups", {
          name: "release",
          agentIds: [agent.id],
        })
      ).json()) as {
        group: { id: string };
      }
    ).group.id;
    await send(host, "POST", `/groups/${group}/messages`, {
      text: "look at this",
      mentions: [agent.id],
    });

    const snapshot = (await (
      await send(host, "GET", "/api/v1/chat")
    ).json()) as Snapshot;
    expect(snapshot.agents.map((entry) => entry.id)).toEqual([agent.id]);
    expect(snapshot.interactions).toEqual([]);
    expect(Number(snapshot.event_cursor)).toBeGreaterThan(0);

    const own = snapshot.groups.find((entry) => entry.id === group);
    expect(own?.kind).toBe("group");
    // A group made without a folder says so rather than borrowing one: the sidebar groups by
    // this value and the interface marks those groups "unbound", so "" has to survive the trip.
    expect(own?.cwd).toBe("");
    expect(own?.participants).toEqual([
      {
        agent_id: agent.id,
        member: true,
        name: "reviewer",
        status: "idle",
        // The member's side of the conversation: the panel reads that session's numbers.
        session_id: expect.any(String),
      },
    ]);
    // The web's dialog creates and renames groups through the product API; both routes exist and
    // the folder travels with them.
    const made = await send(host, "POST", "/api/v1/groups", {
      name: "  app  ",
      members: [agent.id],
      cwd: "/tmp/app",
    });
    expect(made.status).toBe(201);
    const madeGroup = (await made.json()) as {
      id: string;
      name: string;
      cwd: string;
      participants: { agent_id: string }[];
    };
    expect(madeGroup.name).toBe("app");
    expect(madeGroup.cwd).toBe("/tmp/app");
    expect(madeGroup.participants.map((p) => p.agent_id)).toEqual([agent.id]);

    const retargeted = await send(
      host,
      "PATCH",
      `/api/v1/groups/${madeGroup.id}`,
      { cwd: "/tmp/moved" },
    );
    expect(retargeted.status).toBe(200);
    expect(((await retargeted.json()) as { cwd: string }).cwd).toBe(
      "/tmp/moved",
    );

    // The conversation an agent has for itself: the sidebar's member rows and its agent library
    // both open this, and pressing twice must not make a second one.
    const first = (await (
      await send(host, "POST", `/api/v1/agents/${agent.id}/direct`)
    ).json()) as { id: string; kind: string };
    expect(first.kind).toBe("direct");
    const again = (await (
      await send(host, "POST", `/api/v1/agents/${agent.id}/direct`)
    ).json()) as { id: string; cwd: string };
    expect(again.id).toBe(first.id);
    expect(again.cwd).toBe("");

    // A conversation belongs to a (agent, folder) pair. The same folder finds the same one;
    // a different folder is a different conversation, because that is where the work happens.
    const inFolder = (await (
      await send(host, "POST", `/api/v1/agents/${agent.id}/direct`, {
        cwd: "/tmp/app",
      })
    ).json()) as { id: string; cwd: string };
    expect(inFolder.cwd).toBe("/tmp/app");
    const againInFolder = (await (
      await send(host, "POST", `/api/v1/agents/${agent.id}/direct`, {
        cwd: "/tmp/app",
      })
    ).json()) as { id: string };
    expect(againInFolder.id).toBe(inFolder.id);

    const elsewhere = (await (
      await send(host, "POST", `/api/v1/agents/${agent.id}/direct`, {
        cwd: "/tmp/other",
      })
    ).json()) as { id: string; cwd: string };
    expect(elsewhere.cwd).toBe("/tmp/other");
    expect(elsewhere.id).not.toBe(inFolder.id);

    // A body with no folder creates a group with no folder; nothing is inferred.
    const bare = (await (
      await send(host, "POST", "/api/v1/groups", {
        name: "bare",
        members: [agent.id],
      })
    ).json()) as { cwd: string };
    expect(bare.cwd).toBe("");

    // Archiving is a real flag on the group: the timeline and its work stay, and the sidebar is
    // the thing that stops listing it.
    const archived = await send(
      host,
      "PATCH",
      `/api/v1/groups/${madeGroup.id}`,
      {
        archived: true,
      },
    );
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as { archived: boolean }).archived).toBe(
      true,
    );
    const afterArchive = (await (
      await send(host, "GET", "/api/v1/chat")
    ).json()) as Snapshot;
    expect(
      afterArchive.groups.find((entry) => entry.id === madeGroup.id)?.archived,
    ).toBe(true);
    const unarchived = (await (
      await send(host, "PATCH", `/api/v1/groups/${madeGroup.id}`, {
        archived: false,
      })
    ).json()) as { archived: boolean };
    expect(unarchived.archived).toBe(false);

    // The same snapshot carries a folder when the group has one.
    const bound = (await (
      await send(host, "POST", "/groups", {
        name: "app",
        cwd: "/tmp/app",
        agentIds: [agent.id],
      })
    ).json()) as { group: { id: string } };
    const withCwd = (await (
      await send(host, "GET", "/api/v1/chat")
    ).json()) as Snapshot;
    expect(
      withCwd.groups.find((entry) => entry.id === bound.group.id)?.cwd,
    ).toBe("/tmp/app");

    // The timeline advanced, and the sidebar has a preview to show.
    expect(own?.last_seq).toBe(2);
    expect(own?.preview).toBe("the answer");
    expect(own?.revision).toBe(2);

    // The rows read the way the web's do: the user's message has no parent, and the reply points
    // back at it — which is how the panel offers to resend a failed reply.
    const page = (await (
      await send(host, "GET", `/api/v1/groups/${group}/messages`)
    ).json()) as {
      items: { id: string; role: string; reply_to_id: string | null }[];
    };
    expect(page.items.map((item) => [item.role, item.reply_to_id])).toEqual([
      ["user", null],
      ["assistant", page.items[0]!.id],
    ]);

    // A finished reply is not "active"; a running one is, and it reads as `responding`.
    expect(snapshot.active_replies).toEqual([]);
    host.groups.startReply(group, agent.id, "some-message");
    const during = (await (
      await send(host, "GET", "/api/v1/chat")
    ).json()) as Snapshot;
    expect(
      during.active_replies.map((reply) => [reply.role, reply.status]),
    ).toEqual([["assistant", "responding"]]);
  });

  it("lets an agent be given a persona card, and taken back to the default", async () => {
    const host = await start();
    const created = (await (
      await send(host, "POST", "/api/v1/agents", { name: "reviewer" })
    ).json()) as { id: string; persona: string };
    expect(created.persona).toBe("");

    const given = await send(
      host,
      "PUT",
      `/api/v1/agents/${created.id}/persona`,
      { persona: "critic" },
    );
    expect(given.status).toBe(200);
    expect(await given.json()).toEqual({
      persona: "critic",
      uses_project_default: false,
    });

    const read = (await (
      await send(host, "GET", `/api/v1/agents/${created.id}/persona`)
    ).json()) as { persona: string; uses_project_default: boolean };
    expect(read).toEqual({ persona: "critic", uses_project_default: false });

    // Back to the default is a real state, not an error: "" is what the harness reads as "use
    // whichever card the project's default names".
    const cleared = (await (
      await send(host, "PUT", `/api/v1/agents/${created.id}/persona`, {
        persona: "",
      })
    ).json()) as { persona: string; uses_project_default: boolean };
    expect(cleared).toEqual({ persona: "", uses_project_default: true });
  });

  it("answers the routes the web's editor calls, and the one it cannot", async () => {
    // No scripted model here on purpose: a fake answers yes to every model id, which would make
    // the write-time check look green while doing nothing. This host's layer comes from the
    // config file, so "local:nope" really is unreachable.
    const host = await startWithoutModels();
    const agent = (await (
      await send(host, "POST", "/api/v1/agents", {
        name: "editor",
        model: "local:m1",
      })
    ).json()) as Snapshot["agents"][number];
    expect(agent.model).toBe("local:m1");

    // A model this host cannot serve is refused at the write, exactly as the internal route does.
    const bad = await send(host, "PATCH", `/api/v1/agents/${agent.id}`, {
      model: "local:nope",
    });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      "MODEL_UNKNOWN",
    );

    const patched = (await (
      await send(host, "PATCH", `/api/v1/agents/${agent.id}`, {
        description: "Edit prose.",
      })
    ).json()) as Snapshot["agents"][number];
    expect(patched.description).toBe("Edit prose.");

    // Nothing runs in a container here, so restarting is refused rather than pretended.
    const restarted = await send(
      host,
      "POST",
      `/api/v1/agents/${agent.id}/restart`,
    );
    expect(restarted.status).toBe(501);
    expect(
      ((await restarted.json()) as { error: { code: string } }).error.code,
    ).toBe("NOT_IMPLEMENTED");

    expect(
      (await send(host, "DELETE", `/api/v1/agents/${agent.id}`)).status,
    ).toBe(204);
    expect((await send(host, "GET", "/api/v1/agents")).status).toBe(200);
  });
});

describe("history pages", () => {
  it("pages back through a timeline without a gap or a repeat", async () => {
    const host = await start();
    const agent = (await (
      await send(host, "POST", "/api/v1/agents", { name: "historian" })
    ).json()) as Snapshot["agents"][number];
    const group = (
      (await (
        await send(host, "POST", "/groups", {
          name: "long",
          agentIds: [agent.id],
        })
      ).json()) as {
        group: { id: string };
      }
    ).group.id;
    // More rows than one page holds, so there is something to page through.
    for (let index = 0; index < 120; index++) {
      host.groups.postUserMessage(group, {
        text: `line ${index}`,
        mentions: [],
      });
    }

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const query: string = cursor === null ? "" : `?before=${cursor}`;
      const body = (await (
        await send(host, "GET", `/api/v1/groups/${group}/messages${query}`)
      ).json()) as {
        items: { seq: number; blocks: { text: string }[] }[];
        next_cursor: string | null;
      };
      seen.push(...body.items.map((item) => item.seq));
      cursor = body.next_cursor;
      if (cursor === null) break;
    }
    // Every row exactly once, newest first, and the last page ends the timeline. The count comes
    // from the store rather than from the loop above: what is being tested is the paging, not how
    // many rows a post happens to write.
    const total = host.groups.messages(group).length;
    expect(total).toBe(120);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // The union of the pages is the whole timeline, in order — and the paging reached the very
    // first row rather than stopping a page short of it.
    expect([...seen].sort((a, b) => a - b)).toEqual(
      host.groups.messages(group).map((message) => message.seq),
    );
    expect(Math.min(...seen)).toBe(1);
    // Asking before the first row is the end of the timeline, not a repeat of the last page.
    const oldest = await send(
      host,
      "GET",
      `/api/v1/groups/${group}/messages?before=${String(Math.min(...seen))}`,
    );
    expect(
      (await oldest.json()) as { items: unknown[]; next_cursor: string | null },
    ).toEqual({
      items: [],
      next_cursor: null,
    });

    // The web's interaction history page asks for the list; empty is the honest answer until the
    // ask channel exists (P2.6).
    const interactions = (await (
      await send(host, "GET", "/api/v1/chat/interactions?limit=100")
    ).json()) as {
      interactions: unknown[];
    };
    expect(interactions.interactions).toEqual([]);
  });
});

describe("the stream", () => {
  it("carries the product's events, and only those", async () => {
    const host = await start(["answered"]);
    const agent = (await (
      await send(host, "POST", "/api/v1/agents", { name: "talker" })
    ).json()) as Snapshot["agents"][number];

    const pending = connect(host);
    await connected(host, 1);
    // An edit while the client watches: that is what the sidebar updates on.
    await send(host, "POST", "/api/v1/agents", { name: "second" });
    const group = (
      (await (
        await send(host, "POST", "/groups", {
          name: "chat",
          agentIds: [agent.id],
        })
      ).json()) as {
        group: { id: string };
      }
    ).group.id;
    await send(host, "POST", `/groups/${group}/messages`, {
      text: "go",
      mentions: [agent.id],
    });

    const reader = sseReader(await pending);
    const frames = await reader.until(
      (seen) =>
        seen.some(
          (frame) =>
            frame.event === "message.updated" &&
            (frame.data as { message?: { status?: string; role?: string } })
              .message?.status === "completed" &&
            (frame.data as { message?: { status?: string; role?: string } })
              .message?.role === "assistant",
        ),
      2_000,
    );
    await reader.cancel();

    const names = new Set(frames.map((frame) => frame.event));
    expect(names).toContain("agent.updated");
    expect(names).toContain("group.updated");
    expect(names).toContain("message.updated");
    // Our internal vocabulary never reaches the product's stream.
    for (const internal of ["session.created", "session.turn", "group.reply"]) {
      expect(names.has(internal)).toBe(false);
    }

    // The reply arrives twice under the same id: working (the product's `responding`), then done.
    const replies = frames.filter(
      (frame) =>
        frame.event === "message.updated" &&
        (frame.data as { message?: { role?: string } }).message?.role ===
          "assistant",
    );
    expect(
      replies.map(
        (frame) =>
          (frame.data as { message: { status: string } }).message.status,
      ),
    ).toEqual(["responding", "completed"]);
    const done = replies.at(-1);
    const message = (
      done?.data as {
        message: {
          blocks: { type: string; text: string }[];
          revision: number;
          kind: string;
        };
      }
    ).message;
    // Text is a block, the revision went up, and the kind is the product's word for it.
    expect(message.blocks).toEqual([{ type: "text", text: "answered" }]);
    expect(message.revision).toBe(2);
    expect(message.kind).toBe("message");

    // And the agent frame carries the product's agent shape. It is the second agent — the one
    // created while this client watched — since the first was made before it connected.
    const agentFrame = frames.find((frame) => frame.event === "agent.updated");
    expect(
      (agentFrame?.data as { agent: { name: string; description: string } })
        .agent,
    ).toMatchObject({
      name: "second",
      description: "",
    });
  });

  it("answers 410 for a cursor older than the events it keeps", async () => {
    const host = await start(["one", "two"], 1);
    const agent = (await (
      await send(host, "POST", "/api/v1/agents", { name: "chatty" })
    ).json()) as Snapshot["agents"][number];
    const group = (
      (await (
        await send(host, "POST", "/groups", {
          name: "chat",
          agentIds: [agent.id],
        })
      ).json()) as {
        group: { id: string };
      }
    ).group.id;
    // Two replies, so the ring of one has dropped the events before them.
    await send(host, "POST", `/groups/${group}/messages`, {
      text: "go",
      mentions: [agent.id],
    });
    await send(host, "POST", `/groups/${group}/messages`, {
      text: "again",
      mentions: [agent.id],
    });

    const response = await connect(host, "/api/v1/chat/stream?cursor=1");
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CURSOR_EXPIRED");

    // The cursor the snapshot hands out is one the server can still replay — checked without
    // opening a stream, because fetching a stream that has nothing to send never resolves.
    const snapshot = (await (
      await send(host, "GET", "/api/v1/chat")
    ).json()) as Snapshot;
    expect(host.hub.canReplay(Number(snapshot.event_cursor))).toBe(true);
  });
});
