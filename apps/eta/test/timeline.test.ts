import type { Host } from "../src/host";
import type { SseFrame } from "./support/sse";
/**
 * The timeline projection (REFACTOR.md §9, P2.3).
 *
 * Two claims. The first is that the durable timeline holds the answer — a reply is a row, and it
 * is the row a client reads when it was not there to watch. The second is the transport claim the
 * step is named for: two browsers follow the same stream and each of them sees every event once,
 * in the same order, whichever moment they connected at.
 *
 * The two-phase projection is asserted on the events rather than the rows: a reply is published
 * once as `working` and once as `done`, same message id, higher revision, and that pair is what
 * lets a client show "answering…" without guessing.
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

async function start(answers: string[]): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-timeline-"));
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
  });
  hosts.push(host);
  return host;
}

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

/**
 * Connect a "browser" to the event stream.
 *
 * The response is deliberately not awaited here: Bun's `fetch` resolves when the first body byte
 * arrives, and a fresh SSE stream has nothing to send until something happens — so awaiting it
 * before publishing would wait for the very event the test is about to cause.
 */
const connect = (
  host: Host,
  path = "/events",
  headers?: Record<string, string>,
): Promise<Response> =>
  fetch(url(host, path), headers === undefined ? {} : { headers });

/** Wait until the server has this many subscribers, so "two browsers" are actually connected. */
async function connected(host: Host, count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (host.hub.subscriberCount < count && Date.now() < deadline)
    await sleep(10);
  expect(host.hub.subscriberCount).toBe(count);
}

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

interface Message {
  id: string;
  seq: number;
  kind: string;
  status: string;
  revision: number;
  text: string;
}

async function setup(
  host: Host,
  groupName = "release",
): Promise<{ agentId: string; groupId: string }> {
  const agentId = (
    (await (
      await send(host, "POST", "/agents", { name: "reviewer" })
    ).json()) as {
      agent: { id: string };
    }
  ).agent.id;
  const groupId = (
    (await (
      await send(host, "POST", "/groups", {
        name: groupName,
        agentIds: [agentId],
      })
    ).json()) as {
      group: { id: string };
    }
  ).group.id;
  return { agentId, groupId };
}

/** The frames that carry the reply, in the order they arrived. */
const replyFrames = (
  frames: SseFrame[],
  replyId: string | undefined,
): SseFrame[] =>
  frames.filter(
    (frame) =>
      frame.event === "message.updated" &&
      ((frame.data as { message?: Message }).message?.id === replyId ||
        (frame.data as { message?: Message }).message?.kind === "assistant"),
  );

describe("the timeline holds the answer", () => {
  it("writes the user's message and, after the run, the reply", async () => {
    const host = await start(["the answer"]);
    const { agentId, groupId } = await setup(host);

    const posted = (await (
      await send(host, "POST", `/groups/${groupId}/messages`, {
        text: "have a look",
        mentions: [agentId],
      })
    ).json()) as { replies: { replyMessageId?: string }[] };
    const replyId = posted.replies[0]?.replyMessageId;
    expect(replyId).toBeDefined();

    const timeline = (await (
      await send(host, "GET", `/groups/${groupId}/messages`)
    ).json()) as {
      messages: Message[];
    };
    expect(
      timeline.messages.map((message) => [
        message.seq,
        message.kind,
        message.status,
      ]),
    ).toEqual([
      [1, "user", "done"],
      [2, "assistant", "done"],
    ]);
    // The reply keeps the place it started in, and its text arrived with a revision.
    const reply = timeline.messages.find((message) => message.id === replyId);
    expect(reply?.text).toBe("the answer");
    expect(reply?.revision).toBe(2);
  });

  it("shows the failure as the reply, not as a missing message", async () => {
    const host = await start([]);
    const { agentId, groupId } = await setup(host);

    // No scripted answer: the run fails after the reply row was placed.
    const posted = (await (
      await send(host, "POST", `/groups/${groupId}/messages`, {
        text: "hello",
        mentions: [agentId],
      })
    ).json()) as { replies: { status: string; replyMessageId?: string }[] };
    expect(posted.replies[0]?.status).toBe("failed");

    const timeline = (await (
      await send(host, "GET", `/groups/${groupId}/messages`)
    ).json()) as {
      messages: Message[];
    };
    const reply = timeline.messages.find(
      (message) => message.id === posted.replies[0]?.replyMessageId,
    );
    expect(reply?.status).toBe("failed");
    expect(reply?.text.length).toBeGreaterThan(0);
  });
});

describe("two browsers at once", () => {
  it("each sees every event once, in the same order", async () => {
    const host = await start(["first", "second"]);
    const { agentId, groupId } = await setup(host);

    // Both connect before anything happens, the way two open tabs would.
    const firstPending = connect(host);
    const secondPending = connect(host);
    await connected(host, 2);

    await send(host, "POST", `/groups/${groupId}/messages`, {
      text: "go",
      mentions: [agentId],
    });

    const [first, second] = [
      sseReader(await firstPending),
      sseReader(await secondPending),
    ];

    const seen = async (
      reader: ReturnType<typeof sseReader>,
    ): Promise<SseFrame[]> =>
      await reader.until(
        (frames) =>
          frames.some(
            (frame) =>
              frame.event === "message.updated" &&
              (frame.data as { message?: Message }).message?.status ===
                "done" &&
              (frame.data as { message?: Message }).message?.kind ===
                "assistant",
          ),
        2_000,
      );

    const [framesA, framesB] = [await seen(first), await seen(second)];
    await first.cancel();
    await second.cancel();

    // Same events, same order — that is "no lost, no duplicated" in one assertion.
    expect(framesA.map((frame) => [frame.id, frame.event])).toEqual(
      framesB.map((frame) => [frame.id, frame.event]),
    );
    // No id twice.
    expect(new Set(framesA.map((frame) => frame.id)).size).toBe(framesA.length);
    // And each of them saw the reply twice: working, then done.
    const statuses = replyFrames(framesA, undefined).map(
      (frame) => (frame.data as { message: Message }).message.status,
    );
    expect(statuses).toContain("working");
    expect(statuses).toContain("done");
    const done = replyFrames(framesA, undefined).find(
      (frame) => (frame.data as { message: Message }).message.status === "done",
    );
    expect((done?.data as { message: Message }).message.revision).toBe(2);
  });

  it("replays for a client that arrives late, and repeats nothing on a reconnect", async () => {
    const host = await start(["first", "second"]);
    const { agentId, groupId } = await setup(host);

    const livePending = connect(host);
    await connected(host, 1);
    await send(host, "POST", `/groups/${groupId}/messages`, {
      text: "go",
      mentions: [agentId],
    });
    const live = sseReader(await livePending);
    const frames = await live.until(
      (seen) => seen.some((frame) => frame.event === "message.updated"),
      2_000,
    );
    await live.cancel();
    const lastId = frames.at(-1)?.id ?? 0;
    expect(lastId).toBeGreaterThan(0);

    // Late: the ring replays what it still holds, so a fresh client catches up at once.
    const late = sseReader(await connect(host, "/events?cursor=0"));
    const replayed = await late.until(
      (seen) => seen.length >= frames.length,
      2_000,
    );
    await late.cancel();
    expect(replayed.map((frame) => frame.event)).toEqual(
      frames.map((frame) => frame.event),
    );
    // Cursor 0 is nobody's resume point, and the ring is not empty, so this is fine — but the
    // expired-cursor answer is its own thing (tested with the hub in http.test.ts).

    // Reconnect: an EventSource sends the id of the last frame it read, and gets the next one —
    // not that one again.
    const reconnectedPending = connect(host, "/events", {
      "Last-Event-ID": String(lastId),
    });
    await connected(host, 1);
    await send(host, "POST", `/groups/${groupId}/messages`, {
      text: "again",
      mentions: [agentId],
    });
    const reconnected = sseReader(await reconnectedPending);
    const after = await reconnected.until((seen) => seen.length > 0, 2_000);
    await reconnected.cancel();
    expect(after[0]?.id).toBeGreaterThan(lastId);
    expect(after.some((frame) => frame.id === lastId)).toBe(false);
  });
});
