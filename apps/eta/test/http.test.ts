import type { Host } from "../src/host";
/**
 * The HTTP face (REFACTOR.md §9, P0.5): idempotency keys, and the event stream.
 *
 * The two things a client depends on and cannot check for itself: "my retry did not send the
 * message twice", and "after my connection dropped I got everything I missed, exactly once".
 * Both are tested here in the shapes the front end uses — a POST carrying a key, and an SSE
 * stream resumed by `Last-Event-ID`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";
import { EventHub } from "../src/http/events";
import { sseReader } from "./support/sse";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-http-"));
  roots.push(root);
  return root;
}

async function start(): Promise<Host> {
  const host = await assembleHost({
    dataDir: await scratch(),
    port: 0,
    warn: () => undefined,
  });
  hosts.push(host);
  return host;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("idempotency keys", () => {
  it("runs a POST once, and replays the first answer for the same key", async () => {
    const host = await start();
    let ran = 0;
    host.routes.register("POST", "/thing", () => {
      ran += 1;
      return Response.json({ n: ran });
    });

    const post = (key?: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${host.port}/thing`, {
        method: "POST",
        body: "{}",
        headers: key === undefined ? {} : { "Idempotency-Key": key },
      });

    const first = await post("key-1");
    expect(await first.json()).toEqual({ n: 1 });
    expect(first.headers.get("x-idempotent-replay")).toBeNull();

    const retry = await post("key-1");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ n: 1 });
    expect(retry.headers.get("x-idempotent-replay")).toBe("true");
    expect(ran).toBe(1);

    // A second key is a second request: the client asked for a new thing.
    expect(await (await post("key-2")).json()).toEqual({ n: 2 });
    // No key at all means no promise of "once": every call runs.
    expect(await (await post()).json()).toEqual({ n: 3 });
    expect(ran).toBe(3);

    expect(
      host.db.handle.query("SELECT COUNT(*) AS n FROM http_idempotency").get(),
    ).toEqual({
      n: 2,
    });
  });

  it("does not remember a 500: the server said 'ask again'", async () => {
    const host = await start();
    let ran = 0;
    host.routes.register("POST", "/flaky", () => {
      ran += 1;
      return ran === 1
        ? Response.json({ error: { code: "BOOM" } }, { status: 500 })
        : Response.json({ n: ran });
    });

    const post = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${host.port}/flaky`, {
        method: "POST",
        headers: { "Idempotency-Key": "key-flaky" },
      });

    expect((await post()).status).toBe(500);
    // The retry runs the handler again — which is the point of not storing a 500.
    const second = await post();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ n: 2 });
  });
});

describe("the event stream", () => {
  it("replays only what a cursor has not seen", async () => {
    const hub = new EventHub();
    hub.publish("a", { n: 1 });
    hub.publish("b", { n: 2 });
    hub.publish("c", { n: 3 });

    const response = hub.handle(new Request("http://eta/events?cursor=1"));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = sseReader(response);
    const first = await reader.next();
    const second = await reader.next();
    await reader.cancel();

    expect(first?.id).toBe(2);
    expect(first?.event).toBe("b");
    expect(second?.id).toBe(3);
  });

  it("does not replay at a client that sent no cursor, and follows it live", async () => {
    const hub = new EventHub();
    hub.publish("a", { n: 1 });

    const reader = sseReader(hub.handle(new Request("http://eta/events")));
    // No cursor: nothing to catch up on, so nothing arrives until something happens.
    expect(await reader.next(150)).toBeUndefined();

    hub.publish("live", { n: 2 });
    const frame = await reader.next();
    await reader.cancel();
    expect(frame?.id).toBe(2);
    expect(frame?.event).toBe("live");
  });

  it("resumes from Last-Event-ID without repeating the event it names", async () => {
    const hub = new EventHub();
    hub.publish("a", { n: 1 });
    hub.publish("b", { n: 2 });

    // What an EventSource sends when it reconnects: the id of the last frame it read.
    const reader = sseReader(
      hub.handle(
        new Request("http://eta/events", { headers: { "Last-Event-ID": "2" } }),
      ),
    );
    hub.publish("c", { n: 3 });
    const frame = await reader.next();
    await reader.cancel();

    expect(frame?.id).toBe(3);
    expect(frame?.event).toBe("c");
  });

  it("says CURSOR_EXPIRED rather than leaving a silent gap", async () => {
    const hub = new EventHub({ capacity: 2 });
    for (let n = 1; n <= 4; n += 1) hub.publish("e", { n });

    // 1 is older than the two events still held (3 and 4), so catching up is impossible.
    const expired = hub.handle(new Request("http://eta/events?cursor=1"));
    expect(expired.status).toBe(410);
    const body = (await expired.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CURSOR_EXPIRED");

    // One behind the oldest held event is still replayable.
    const ok = hub.handle(new Request("http://eta/events?cursor=2"));
    expect(ok.status).toBe(200);
    await sseReader(ok).cancel();
  });

  it("rejects a cursor that is not one", async () => {
    const hub = new EventHub();
    const response = hub.handle(new Request("http://eta/events?cursor=later"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("drops the subscriber when the client goes away", async () => {
    const hub = new EventHub();
    const controller = new AbortController();
    const reader = sseReader(
      hub.handle(
        new Request("http://eta/events", { signal: controller.signal }),
      ),
    );
    await sleep(20);
    expect(hub.subscriberCount).toBe(1);
    controller.abort();
    await reader.cancel();
    await sleep(20);
    expect(hub.subscriberCount).toBe(0);
  });
});
