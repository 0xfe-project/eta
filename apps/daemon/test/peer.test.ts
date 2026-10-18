/** The link's rules, between two peers wired back to back: no socket, no host. */
import { describe, expect, it } from "vitest";
import { LinkError, Peer } from "../src/link/peer";

/** Two peers whose sends arrive at each other (on the next tick, like a socket). */
function pair(options: { maxFrameBytes?: number; maxInFlight?: number } = {}) {
  const closed: { code: number; reason: string }[] = [];
  const pipes: unknown[] = [];
  let b!: Peer;
  const deliver = (to: () => Peer) => (text: string) =>
    void queueMicrotask(() => to().receive(text));
  const a: Peer = new Peer({
    send: deliver(() => b),
    close: (code, reason) => closed.push({ code, reason }),
    onPipe: (frame) => pipes.push(frame),
    ...options,
  });
  b = new Peer({
    send: deliver(() => a),
    close: (code, reason) => closed.push({ code, reason }),
    onPipe: (frame) => pipes.push(frame),
    ...options,
  });
  return { a, b, closed, pipes };
}

describe("calls", () => {
  it("answers with the handler's result, and with its message when it throws", async () => {
    const { a, b } = pair();
    b.handle("add", (params) => (params as { x: number }).x + 1);
    b.handle("boom", () => {
      throw new Error("no good");
    });
    expect(await a.call("add", { x: 1 })).toBe(2);
    await expect(a.call("boom", {})).rejects.toMatchObject({
      kind: "remote",
      message: "no good",
    });
    await expect(a.call("missing", {})).rejects.toThrow(/unknown method/);
  });

  it("streams events to the caller while the handler works", async () => {
    const { a, b } = pair();
    b.handle("count", (_params, { emit }) => {
      emit(1);
      emit(2);
      return "done";
    });
    const seen: unknown[] = [];
    expect(await a.call("count", {}, { onEvent: (e) => seen.push(e) })).toBe(
      "done",
    );
    expect(seen).toEqual([1, 2]);
  });

  it("cancelling tells the handler, and the caller fails as aborted", async () => {
    const { a, b } = pair();
    let stopped = false;
    b.handle(
      "wait",
      (_params, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            stopped = true;
            resolve(undefined);
          });
        }),
    );
    const controller = new AbortController();
    const call = a.call("wait", {}, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ kind: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(true);
  });

  it("a call that takes too long fails as an unknown outcome", async () => {
    const { a, b } = pair();
    b.handle("slow", () => new Promise(() => undefined));
    await expect(a.call("slow", {}, { timeoutMs: 20 })).rejects.toMatchObject({
      kind: "timeout",
      message: expect.stringContaining("outcome is unknown"),
    });
  });

  it("notifications are heard and answer nothing", async () => {
    const { a, b } = pair();
    const heard: unknown[] = [];
    b.onNotify("ping", (params) => heard.push(params));
    a.notify("ping", { n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(heard).toEqual([{ n: 1 }]);
  });
});

describe("limits", () => {
  it("refuses a call over the in-flight limit with a reason, instead of queueing it", async () => {
    const { a, b } = pair({ maxInFlight: 2 });
    b.handle("hold", () => new Promise(() => undefined));
    void a.call("hold", {}, { timeoutMs: 1_000 }).catch(() => undefined);
    void a.call("hold", {}, { timeoutMs: 1_000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(a.call("hold", {})).rejects.toThrow(/busy/);
  });

  it("will not send, and breaks the link on receiving, a frame over the size limit", async () => {
    const { a, closed } = pair({ maxFrameBytes: 100 });
    expect(() => a.sendPipe("x".repeat(200))).toThrow(/too big/);
    a.receive(JSON.stringify({ ch: "pipe", frame: "y".repeat(200) }));
    expect(closed).toEqual([{ code: 1009, reason: "frame too big" }]);
  });

  it("garbage breaks the link", () => {
    const { a, closed } = pair();
    a.receive("not json");
    expect(closed[0]?.code).toBe(4005);
  });
});

describe("a lost link", () => {
  it("fails what it was waiting on as unknown, stops what it was running, and sends nothing more", async () => {
    const { a, b } = pair();
    let stopped = false;
    b.handle(
      "work",
      (_params, { signal }) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            stopped = true;
          });
        }),
    );
    const call = a.call("work", {}).catch((error: LinkError) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    a.markLost("cable pulled");
    b.markLost("cable pulled");
    const error = await call;
    expect(error).toBeInstanceOf(LinkError);
    expect((error as LinkError).kind).toBe("lost");
    expect((error as LinkError).message).toMatch(/outcome is unknown/);
    expect(stopped).toBe(true);
    await expect(a.call("work", {})).rejects.toMatchObject({ kind: "lost" });
  });

  it("silence past the limit closes the socket", async () => {
    const { a, closed } = pair();
    a.watch({ silenceMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    a.markLost("done");
    expect(closed[0]?.code).toBe(4004);
  });
});
