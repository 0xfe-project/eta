import type { Host } from "../src/host";
/**
 * Confirmation cards: a question, and the run that waits for it (REFACTOR.md §9, P2.6 — 审批 = ask).
 *
 * The claim is the whole round trip, and each step is checked where a client would see it:
 *
 *   the card appears     `GET /api/v1/chat/interactions`, and the reply row says waiting_for_input
 *   the stream says so   an `interaction.updated` frame with status `pending`
 *   it can be answered   `POST .../interactions/{id}/answer` → `resolved`, with the value
 *   the run continues    the reply row goes back to working and finishes with the model's answer
 *   the model hears it   the tool result in the transcript is the option the user chose
 *
 * The model is scripted to call `ask_user`, which is the same channel a tool approval would use:
 * the product's card *is* the session's ask, and the id is the tool call's.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";
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

interface AxpInteraction {
  id: string;
  status: string;
  prompt: string;
  options: { value: string; label: string }[];
  answer: string | null;
  revision: number;
  message_id: string;
  group_id: string;
  agent_id: string;
}

interface AxpMessage {
  id: string;
  role: string;
  status: string;
  revision: number;
  blocks: { type: string; text: string }[];
}

/** A model that asks, then answers once it has the reply. */
const askingModels = () =>
  fakeModels([
    assistantMessage({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall" as const,
          id: "call-1",
          name: "ask_user",
          arguments: {
            question: "把这次改动推上远端吗？",
            options: [{ title: "推" }, { title: "先不推" }],
          },
        },
      ],
    }),
    assistantMessage({ content: [{ type: "text", text: "好，那就不推。" }] }),
  ]);

async function start(): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-ask-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
    models: askingModels(),
  });
  hosts.push(host);
  return host;
}

async function conversation(host: Host): Promise<{
  agentId: string;
  groupId: string;
  replyId: string;
}> {
  const agent = (await (
    await send(host, "POST", "/agents", { name: "asker" })
  ).json()) as { agent: { id: string } };
  const group = (await (
    await send(host, "POST", "/groups", {
      name: "ask test",
      agentIds: [agent.agent.id],
    })
  ).json()) as { group: { id: string } };
  const sent = (await (
    await send(host, "POST", "/api/v1/chat/messages", {
      group_id: group.group.id,
      mentions: [agent.agent.id],
      parts: [{ type: "text", text: "改完了，接下来呢？" }],
      mode: "queue",
    })
  ).json()) as { replies: AxpMessage[] };
  return {
    agentId: agent.agent.id,
    groupId: group.group.id,
    replyId: sent.replies[0]!.id,
  };
}

/** The pending card, or a failure after the budget runs out. */
async function pendingCard(host: Host): Promise<AxpInteraction> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const list = (await (
      await send(host, "GET", "/api/v1/chat/interactions?limit=100")
    ).json()) as { interactions: AxpInteraction[] };
    const pending = list.interactions.find((card) => card.status === "pending");
    if (pending !== undefined) return pending;
    if (Date.now() > deadline) throw new Error("no card appeared");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Wait until the reply row settles, then read the timeline. */
async function settled(host: Host, groupId: string): Promise<AxpMessage[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const page = (await (
      await send(host, "GET", `/api/v1/groups/${groupId}/messages`)
    ).json()) as { items: AxpMessage[] };
    const busy = page.items.some((item) =>
      ["queued", "responding", "stopping", "waiting_for_input"].includes(
        item.status,
      ),
    );
    if (!busy || Date.now() > deadline) return page.items;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a question an agent asks", () => {
  it("becomes a card, waits, and lets the run continue when answered", async () => {
    const host = await start();
    const pendingConnect = fetch(url(host, "/api/v1/chat/stream?cursor=0"));
    const deadline = Date.now() + 1_000;
    while (host.hub.subscriberCount < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const { agentId, groupId, replyId } = await conversation(host);

    const card = await pendingCard(host);
    // The card is the tool call: same id, the question the model asked, its options.
    expect(card).toMatchObject({
      id: "call-1",
      prompt: "把这次改动推上远端吗？",
      status: "pending",
      answer: null,
      revision: 1,
      group_id: groupId,
      agent_id: agentId,
      message_id: replyId,
    });
    expect(card.options.map((option) => option.value)).toEqual([
      "推",
      "先不推",
    ]);

    // While it waits, the reply row says so — the trail is not finished, it stopped to listen.
    const waiting = (await (
      await send(host, "GET", `/api/v1/groups/${groupId}/messages`)
    ).json()) as { items: AxpMessage[] };
    expect(waiting.items.find((item) => item.id === replyId)?.status).toBe(
      "waiting_for_input",
    );
    // And the snapshot carries the pending card, which is what a page of "待处理" reads.
    const snapshot = (await (
      await send(host, "GET", "/api/v1/chat")
    ).json()) as { interactions: AxpInteraction[] };
    expect(snapshot.interactions.map((entry) => entry.id)).toEqual(["call-1"]);

    const answered = (await (
      await send(host, "POST", `/api/v1/chat/interactions/call-1/answer`, {
        value: "先不推",
      })
    ).json()) as AxpInteraction;
    expect([answered.status, answered.answer, answered.revision]).toEqual([
      "resolved",
      "先不推",
      2,
    ]);
    // Answering again changes nothing and is not an error: the same card comes back.
    const twice = (await (
      await send(host, "POST", "/api/v1/chat/interactions/call-1/answer", {
        value: "推",
      })
    ).json()) as AxpInteraction;
    expect([twice.status, twice.answer, twice.revision]).toEqual([
      "resolved",
      "先不推",
      2,
    ]);

    // The run continues from where it was parked and writes the model's answer.
    const items = await settled(host, groupId);
    const reply = items.find((item) => item.id === replyId);
    expect(reply?.status).toBe("completed");
    expect(reply?.blocks[0]?.text).toBe("好，那就不推。");

    // The model was told what the user chose.
    const managed = await host.sessions.session(
      host.groups
        .participantsOf(groupId)
        .find((entry) => entry.agentId === agentId)?.sessionId ?? "",
    );
    const transcript = managed?.session.journaling.transcript() ?? [];
    const results = transcript
      .filter((entry) => entry.role === "toolResult")
      .map((entry) =>
        typeof entry.content === "string"
          ? entry.content
          : entry.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join(""),
      );
    expect(results.some((text) => text.includes("先不推"))).toBe(true);

    // The stream carried both halves, by id and revision.
    // Read until the reply row itself has settled: the frames after the answer arrive after the
    // answer was taken, and stopping at the first one would miss them.
    const reader = sseReader(await pendingConnect);
    const frames = await reader.until(
      (seen) =>
        seen.some(
          (frame) =>
            frame.event === "interaction.updated" &&
            (frame.data as { interaction: AxpInteraction }).interaction
              .status === "resolved",
        ) &&
        seen.some(
          (frame) =>
            frame.event === "message.updated" &&
            (frame.data as { message: AxpMessage }).message.id === replyId &&
            (frame.data as { message: AxpMessage }).message.status ===
              "completed",
        ),
      2_000,
    );
    await reader.cancel();
    const states = frames
      .filter((frame) => frame.event === "interaction.updated")
      .map(
        (frame) => (frame.data as { interaction: AxpInteraction }).interaction,
      )
      .map((interaction) => [interaction.status, interaction.revision]);
    expect(states).toEqual([
      ["pending", 1],
      ["resolved", 2],
    ]);
    const rowStates = frames
      .filter(
        (frame) =>
          frame.event === "message.updated" &&
          (frame.data as { message: AxpMessage }).message.id === replyId,
      )
      .map((frame) => (frame.data as { message: AxpMessage }).message.status);
    expect(rowStates).toEqual([
      "queued",
      "responding",
      "waiting_for_input",
      "responding",
      "completed",
    ]);
  });

  it("expires the card when the run it belonged to is stopped", async () => {
    const host = await start();
    const { groupId, replyId } = await conversation(host);
    await pendingCard(host);

    // Nobody is going to answer this one: the run is stopped instead.
    const stopped = (await (
      await send(host, "POST", `/api/v1/chat/messages/${replyId}/stop`)
    ).json()) as AxpMessage;
    expect(stopped.status).toBe("stopping");

    const deadline = Date.now() + 3_000;
    let card = (await (
      await send(host, "GET", "/api/v1/chat/interactions?limit=100")
    ).json()) as { interactions: AxpInteraction[] };
    while (
      (card.interactions[0]?.status ?? "pending") === "pending" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      card = (await (
        await send(host, "GET", "/api/v1/chat/interactions?limit=100")
      ).json()) as { interactions: AxpInteraction[] };
    }
    expect(card.interactions[0]?.status).toBe("expired");
    // And answering an expired card is refused rather than pretended.
    const late = await send(
      host,
      "POST",
      "/api/v1/chat/interactions/call-1/answer",
      { value: "推" },
    );
    expect(late.status).toBe(200);
    expect(((await late.json()) as AxpInteraction).status).toBe("expired");
    const none = await send(
      host,
      "POST",
      "/api/v1/chat/interactions/nope/answer",
      { value: "推" },
    );
    expect(none.status).toBe(404);
    expect((await settled(host, groupId)).length).toBeGreaterThan(0);
  });
});
