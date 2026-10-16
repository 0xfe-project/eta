import type { Host } from "../src/host";
/**
 * Sending a message, and what its mode means (REFACTOR.md §9, P2.6).
 *
 * The product's send is not the internal one. It answers *before* the agents answer, with the
 * message and the reply rows it started, because the web follows the answers over the stream
 * rather than waiting on the response. And its `mode` says how it joins a conversation that is
 * already running:
 *
 *   steer   joins the turn in flight
 *   queue   waits for the reply in flight to end
 *
 * What "joins" means is checked where it can be seen: the reply row that was already there holds
 * the answer to both messages, and the session's transcript has the second message in it. A second
 * reply row would mean the message had started a run of its own, which is exactly what steering
 * is for avoiding.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";
import { delayedModels } from "./support/hanging";

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

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

const send = (
  host: Host,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> =>
  fetch(url(host, path), {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
  });

interface AxpMessage {
  id: string;
  seq: number;
  role: string;
  status: string;
  revision: number;
  blocks: { type: string; text: string }[];
}

interface Sent {
  message: AxpMessage;
  replies: AxpMessage[];
}

async function start(
  models: ReturnType<typeof delayedModels>["models"],
): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-send-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
    models,
  });
  hosts.push(host);
  return host;
}

async function conversation(host: Host): Promise<{
  agentId: string;
  groupId: string;
  sessionId: string;
}> {
  const agent = (await (
    await send(host, "POST", "/agents", { name: "talker" })
  ).json()) as { agent: { id: string } };
  const group = (await (
    await send(host, "POST", "/groups", {
      name: "send test",
      agentIds: [agent.agent.id],
    })
  ).json()) as { group: { id: string } };
  return { agentId: agent.agent.id, groupId: group.group.id, sessionId: "" };
}

const timeline = async (host: Host, groupId: string): Promise<AxpMessage[]> => {
  const page = (await (
    await send(host, "GET", `/api/v1/groups/${groupId}/messages`)
  ).json()) as { items: AxpMessage[] };
  return page.items;
};

const settle = async (host: Host, groupId: string): Promise<AxpMessage[]> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const items = await timeline(host, groupId);
    const busy = items.some((item) =>
      ["queued", "responding", "stopping"].includes(item.status),
    );
    if (!busy || Date.now() > deadline) return items;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("the product's send", () => {
  it("joins the run in flight when steered, instead of starting a second one", async () => {
    const delayed = delayedModels(
      [
        assistantMessage({ content: [{ type: "text", text: "first answer" }] }),
        assistantMessage({ content: [{ type: "text", text: "中文回答" }] }),
      ],
      120,
    );
    const host = await start(delayed.models);
    const { agentId, groupId } = await conversation(host);

    const first = (await (
      await send(host, "POST", "/api/v1/chat/messages", {
        group_id: groupId,
        mentions: [agentId],
        parts: [{ type: "text", text: "say something" }],
        mode: "steer",
      })
    ).json()) as Sent;
    // Answered before the agent does: one reply row, waiting its turn.
    expect(first.message.role).toBe("user");
    expect(first.replies.map((reply) => reply.status)).toEqual(["queued"]);

    // While that turn is in flight, the user says something else.
    await delayed.requested();
    const second = (await (
      await send(host, "POST", "/api/v1/chat/messages", {
        group_id: groupId,
        mentions: [agentId],
        parts: [{ type: "text", text: "不对，用中文" }],
        mode: "steer",
      })
    ).json()) as Sent;
    // Nothing new to run: the words went into the reply that is already answering.
    expect(second.replies).toEqual([]);

    const items = await settle(host, groupId);
    // One user message, one steer, and *one* reply — the answer to both.
    expect(items.map((item) => [item.role, item.status])).toEqual([
      ["user", "completed"],
      ["assistant", "completed"],
      ["user", "completed"],
    ]);
    const reply = items.find((item) => item.role === "assistant");
    expect(reply?.id).toBe(first.replies[0]?.id);
    expect(reply?.blocks[0]?.text).toBe("中文回答");

    // And the steer is in the session that ran: the same run, in order.
    const participant = host.groups
      .participantsOf(groupId)
      .find((entry) => entry.agentId === agentId);
    const managed = await host.sessions.session(participant?.sessionId ?? "");
    const transcript = managed?.session.journaling.transcript() ?? [];
    const words = transcript
      .filter((entry) => entry.role === "user")
      .map((entry) =>
        typeof entry.content === "string"
          ? entry.content
          : entry.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join(""),
      );
    expect(words.some((text) => text.includes("不对，用中文"))).toBe(true);
  });

  it("answers a message nobody is answering with a row that is queued, then working", async () => {
    const delayed = delayedModels(
      [assistantMessage({ content: [{ type: "text", text: "here" }] })],
      100,
    );
    const host = await start(delayed.models);
    const { agentId, groupId } = await conversation(host);

    const sent = (await (
      await send(host, "POST", "/api/v1/chat/messages", {
        group_id: groupId,
        mentions: [agentId],
        parts: [{ type: "text", text: "hello" }],
        mode: "queue",
      })
    ).json()) as Sent;
    expect(sent.replies.map((reply) => reply.status)).toEqual(["queued"]);

    const items = await settle(host, groupId);
    const reply = items.find((item) => item.role === "assistant");
    expect(reply).toMatchObject({ status: "completed", revision: 3 });
    expect(reply?.blocks[0]?.text).toBe("here");
  });

  it("writes one message when the same id arrives twice", async () => {
    const delayed = delayedModels(
      [
        assistantMessage({ content: [{ type: "text", text: "once" }] }),
        assistantMessage({ content: [{ type: "text", text: "twice" }] }),
      ],
      60,
    );
    const host = await start(delayed.models);
    const { agentId, groupId } = await conversation(host);
    const body = {
      id: crypto.randomUUID(),
      group_id: groupId,
      mentions: [agentId],
      parts: [{ type: "text", text: "only once, please" }],
      mode: "queue",
    };
    const first = (await (
      await send(host, "POST", "/api/v1/chat/messages", body, {
        // Different key on purpose: the middleware is not what is being tested here — the
        // message's own id is what makes the write idempotent.
        "Idempotency-Key": crypto.randomUUID(),
      })
    ).json()) as Sent;
    const again = (await (
      await send(host, "POST", "/api/v1/chat/messages", body, {
        "Idempotency-Key": crypto.randomUUID(),
      })
    ).json()) as Sent;
    expect(again.message.id).toBe(first.message.id);

    await settle(host, groupId);
    const items = await timeline(host, groupId);
    const mine = items.filter((item) => item.id === first.message.id);
    expect(mine).toHaveLength(1);
    // One reply, not two: the second post found the wake the first one had already recorded.
    expect(items.filter((item) => item.role === "assistant")).toHaveLength(1);
  });

  it("refuses what it cannot carry, and says which is which", async () => {
    const delayed = delayedModels([], 10);
    const host = await start(delayed.models);
    const { groupId } = await conversation(host);

    const attachment = await send(host, "POST", "/api/v1/chat/messages", {
      group_id: groupId,
      parts: [{ type: "attachment", attachment_id: crypto.randomUUID() }],
    });
    expect(attachment.status).toBe(501);
    expect(
      ((await attachment.json()) as { error: { code: string } }).error.code,
    ).toBe("NOT_IMPLEMENTED");

    const empty = await send(host, "POST", "/api/v1/chat/messages", {
      group_id: groupId,
      parts: [{ type: "text", text: "" }],
    });
    expect(empty.status).toBe(400);

    const nowhere = await send(host, "POST", "/api/v1/chat/messages", {
      group_id: crypto.randomUUID(),
      parts: [{ type: "text", text: "hello?" }],
    });
    expect(nowhere.status).toBe(404);
  });
});
