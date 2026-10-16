import type { Host } from "../src/host";
/**
 * Stopping a reply (REFACTOR.md §9, P2.6).
 *
 * What "stop" has to mean, and what is checked here:
 *
 *   the route      `POST /api/v1/chat/messages/{id}/stop` answers with the row
 *   the row        `stopping` while the run winds down, `stopped` once it has
 *   the stream     a `message.updated` frame for each of those two states
 *   the run        the reply the posting call returns says `stopped`, not `done` or `failed`
 *
 * The model layer is the reason this test can exist at all: with a model that answers immediately
 * there is never a run in flight to stop. `hanging` waits for the abort and then ends, so the stop
 * lands mid-run without the test guessing at timing.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";
import { hangingModels } from "./support/hanging";
import { sseReader } from "./support/sse";

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

const connect = (host: Host, path: string): Promise<Response> =>
  fetch(url(host, path));

async function start(
  models: ReturnType<typeof hangingModels>["models"],
): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-stop-"));
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

interface Message {
  id: string;
  status: string;
  revision: number;
  role: string;
}

/**
 * An agent and a group to talk in.
 *
 * Two members matter for the case where nobody is named: a group of one wakes its member whether
 * it was named or not, and with a hanging model that posting call would never return.
 */
async function conversation(
  host: Host,
  members = 1,
): Promise<{ agentId: string; groupId: string }> {
  const agent = (await (
    await send(host, "POST", "/agents", { name: "talker" })
  ).json()) as { agent: { id: string } };
  const agentIds = [agent.agent.id];
  if (members > 1) {
    const second = (await (
      await send(host, "POST", "/agents", { name: "other" })
    ).json()) as { agent: { id: string } };
    agentIds.push(second.agent.id);
  }
  const group = (await (
    await send(host, "POST", "/groups", { name: "stop test", agentIds })
  ).json()) as { group: { id: string } };
  return { agentId: agent.agent.id, groupId: group.group.id };
}

const replyOf = async (
  host: Host,
  groupId: string,
  messageId: string,
): Promise<Message | undefined> => {
  const page = (await (
    await send(host, "GET", `/api/v1/groups/${groupId}/messages`)
  ).json()) as { items: Message[] };
  return page.items.find((item) => item.id === messageId);
};

describe("stopping a reply", () => {
  it("marks the row stopping, then stopped, and says both on the stream", async () => {
    const hanging = hangingModels();
    const host = await start(hanging.models);
    const { agentId, groupId } = await conversation(host);

    // Subscribe before anything happens: a fresh stream sends nothing, so this is not awaited
    // until there is a frame to read.
    const pending = connect(host, "/api/v1/chat/stream?cursor=0");
    const deadline = Date.now() + 1_000;
    while (host.hub.subscriberCount < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(host.hub.subscriberCount).toBe(1);

    // The posting call is not awaited: this run does not end by itself.
    const posting = send(host, "POST", `/groups/${groupId}/messages`, {
      text: "think about this for a while",
      mentions: [agentId],
    });
    await hanging.requested;

    // While it runs, the product's snapshot calls it an active reply that is responding.
    const running = (await (
      await send(host, "GET", "/api/v1/chat")
    ).json()) as {
      active_replies: Message[];
    };
    const reply = running.active_replies.find(
      (entry) => entry.role === "assistant",
    );
    expect(reply?.status).toBe("responding");
    expect(reply?.revision).toBe(1);

    // The stop is answered with the row as it stands now: winding down, not yet stopped.
    const stopping = await send(
      host,
      "POST",
      `/api/v1/chat/messages/${reply!.id}/stop`,
    );
    expect(stopping.status).toBe(200);
    const during = (await stopping.json()) as Message;
    expect([during.status, during.revision]).toEqual(["stopping", 2]);

    // The run ends because it was asked to, and the same row becomes the record of it.
    const posted = (await (await posting).json()) as {
      replies: { status: string; replyMessageId: string }[];
    };
    expect(posted.replies[0]?.status).toBe("stopped");
    expect(posted.replies[0]?.replyMessageId).toBe(reply!.id);
    const after = await replyOf(host, groupId, reply!.id);
    expect([after?.status, after?.revision]).toEqual(["stopped", 3]);

    // And a client that was watching heard both states, by id and revision.
    const reader = sseReader(await pending);
    const frames = await reader.until(
      (seen) =>
        seen.some(
          (frame) =>
            frame.event === "message.updated" &&
            (frame.data as { message?: Message }).message?.id === reply!.id &&
            (frame.data as { message?: Message }).message?.status === "stopped",
        ),
      2_000,
    );
    await reader.cancel();
    const states = frames
      .filter(
        (frame) =>
          frame.event === "message.updated" &&
          (frame.data as { message?: Message }).message?.id === reply!.id,
      )
      .map((frame) => (frame.data as { message: Message }).message.status);
    expect(states).toEqual(["responding", "stopping", "stopped"]);
  });

  it("answers for a reply that already ended without pretending it changed", async () => {
    const hanging = hangingModels();
    const host = await start(hanging.models);
    // Two members, so a message that names nobody wakes nobody and this posting call returns.
    const { groupId } = await conversation(host, 2);
    // A user's message is written straight to `done`, so it is a row that never ran.
    const posted = (await (
      await send(host, "POST", `/groups/${groupId}/messages`, {
        text: "just a note",
        mentions: [],
      })
    ).json()) as { message: { id: string; status: string } };
    expect(posted.message.status).toBe("done");

    const stopped = await send(
      host,
      "POST",
      `/api/v1/chat/messages/${posted.message.id}/stop`,
    );
    expect(stopped.status).toBe(200);
    const row = (await stopped.json()) as Message;
    // Unchanged: no new revision, because nothing changed. `completed` is the product's word
    // for what the row stores as `done`.
    expect([row.status, row.revision]).toEqual(["completed", 1]);

    const missing = await send(
      host,
      "POST",
      `/api/v1/chat/messages/${crypto.randomUUID()}/stop`,
    );
    expect(missing.status).toBe(404);
  });
});
