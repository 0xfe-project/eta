/** The link's rules, between two peers wired back to back: no socket, no host. */
import { Buffer } from "node:buffer";
import { LINK_CLOSE } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { LinkError, Peer } from "../src/link/peer";

/** Two peers whose sends arrive at each other (on the next tick, like a socket). */
function pair(
  options: {
    maxFrameBytes?: number;
    chunkBytes?: number;
    maxMessageBytes?: number;
    maxInFlightChunks?: number;
    chunked?: boolean;
    maxInFlight?: number;
  } = {},
) {
  const closed: { code: number; reason: string }[] = [];
  const pipes: unknown[] = [];
  const frames: { from: "a" | "b"; text: string }[] = [];
  let b!: Peer;
  const deliver = (from: "a" | "b", to: () => Peer) => (text: string) => {
    frames.push({ from, text });
    void queueMicrotask(() => to().receive(text));
  };
  const a: Peer = new Peer({
    send: deliver("a", () => b),
    close: (code, reason) => closed.push({ code, reason }),
    onPipe: (frame) => pipes.push(frame),
    ...options,
  });
  b = new Peer({
    send: deliver("b", () => a),
    close: (code, reason) => closed.push({ code, reason }),
    onPipe: (frame) => pipes.push(frame),
    ...options,
  });
  return { a, b, closed, pipes, frames };
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

  it("counts a frame's size in bytes, not in UTF-16 code units", () => {
    const { a, closed } = pair({ maxFrameBytes: 100 });
    const payload = "字".repeat(30);
    const frame = JSON.stringify({ ch: "pipe", frame: payload });
    // Short in UTF-16 units, over the limit once written out as UTF-8.
    expect(frame.length).toBeLessThanOrEqual(100);
    const bytes = Buffer.byteLength(frame, "utf8");
    expect(bytes).toBeGreaterThan(100);
    expect(() => a.sendPipe(payload)).toThrow(
      new RegExp(`${bytes} bytes, the limit is 100`),
    );
    a.receive(frame);
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

describe("chunking", () => {
  it("chunks and reassembles oversized svc calls, svc replies, and pipe frames within maxFrameBytes", async () => {
    const { a, b, closed, pipes, frames } = pair({
      maxFrameBytes: 400,
      chunkBytes: 150,
      chunked: true,
    });
    const payload = 'a"\\🎉😀'.repeat(120);
    b.handle("echo", (params) => params);

    const echoed = await a.call("echo", { text: payload });
    expect(echoed).toEqual({ text: payload });

    a.sendPipe({ type: "state", data: payload });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pipes).toEqual([{ type: "state", data: payload }]);

    expect(closed).toEqual([]);
    expect(
      frames.some((f) => f.from === "a" && f.text.includes('"ch":"chunk"')),
    ).toBe(true);
    expect(
      frames.some((f) => f.from === "b" && f.text.includes('"ch":"chunk"')),
    ).toBe(true);
    for (const frame of frames) {
      expect(Buffer.byteLength(frame.text, "utf8")).toBeLessThanOrEqual(400);
    }
  });

  it("enforces maxMessageBytes on outbound sends and respects remote cap from enableChunking", async () => {
    const { a, b, frames } = pair({
      maxFrameBytes: 300,
      chunkBytes: 100,
      maxMessageBytes: 2_000,
    });
    b.handle("echo", (params) => params);
    a.enableChunking({ maxMessageBytes: 800 });
    expect(a.chunked).toBe(true);

    await expect(a.call("echo", "x".repeat(900))).rejects.toMatchObject({
      kind: "remote",
      message: expect.stringMatching(/too big/),
    });
    expect(() => a.sendPipe("x".repeat(900))).toThrow(/too big/);
    expect(frames).toHaveLength(0);
  });

  it("closes with 1009 when inbound chunked message exceeds maxMessageBytes", () => {
    const { a, closed } = pair({ maxFrameBytes: 300, maxMessageBytes: 500 });
    for (let index = 0; index < 3; index += 1) {
      a.receive(
        JSON.stringify({
          ch: "chunk",
          id: "big",
          index,
          total: 3,
          data: "x".repeat(200),
        }),
      );
    }
    expect(closed).toEqual([
      { code: LINK_CLOSE.tooBig, reason: "message too big" },
    ]);
    expect(a.reassemblingCount).toBe(0);
  });

  it("rejects invalid chunks, malformed payloads, nested chunks, and concurrent overflow", () => {
    const cases: unknown[][] = [
      [{ ch: "chunk", id: "a", index: -1, total: 2, data: "x" }],
      [{ ch: "chunk", id: "a", index: 0, total: 0, data: "x" }],
      [{ ch: "chunk", id: "a", index: 2, total: 2, data: "x" }],
      [{ ch: "chunk", id: "a", index: 0, total: 2, data: "" }],
      [{ ch: "chunk", id: "a", index: 1, total: 2, data: "x" }],
      [
        { ch: "chunk", id: "a", index: 0, total: 3, data: "x" },
        { ch: "chunk", id: "a", index: 2, total: 3, data: "y" },
      ],
      [
        { ch: "chunk", id: "a", index: 0, total: 2, data: "x" },
        { ch: "chunk", id: "a", index: 1, total: 3, data: "y" },
      ],
      [{ ch: "chunk", id: "a", index: 0, total: 1, data: "not-json" }],
      [
        {
          ch: "chunk",
          id: "a",
          index: 0,
          total: 1,
          data: JSON.stringify({
            ch: "chunk",
            id: "nested",
            index: 0,
            total: 1,
            data: "{}",
          }),
        },
      ],
      [
        { ch: "chunk", id: "c1", index: 0, total: 2, data: "a" },
        { ch: "chunk", id: "c2", index: 0, total: 2, data: "b" },
        { ch: "chunk", id: "c3", index: 0, total: 2, data: "c" },
      ],
    ];

    for (const seq of cases) {
      const { a, closed } = pair({ maxFrameBytes: 400, maxInFlightChunks: 2 });
      for (const envelope of seq) a.receive(JSON.stringify(envelope));
      expect(closed[0]?.code).toBe(LINK_CLOSE.protocol);
      expect(a.reassemblingCount).toBe(0);
    }
  });

  it("reassembles interleaved concurrent chunked messages", () => {
    const { a, closed, pipes } = pair({
      maxFrameBytes: 400,
      maxMessageBytes: 5_000,
      maxInFlightChunks: 4,
    });
    const m1 = JSON.stringify({ ch: "pipe", frame: `one-${"a".repeat(250)}` });
    const m2 = JSON.stringify({ ch: "pipe", frame: `two-${"b".repeat(250)}` });
    const half1 = Math.floor(m1.length / 2);
    const half2 = Math.floor(m2.length / 2);

    a.receive(
      JSON.stringify({
        ch: "chunk",
        id: "m1",
        index: 0,
        total: 2,
        data: m1.slice(0, half1),
      }),
    );
    a.receive(
      JSON.stringify({
        ch: "chunk",
        id: "m2",
        index: 0,
        total: 2,
        data: m2.slice(0, half2),
      }),
    );
    expect(a.reassemblingCount).toBe(2);
    a.receive(
      JSON.stringify({
        ch: "chunk",
        id: "m1",
        index: 1,
        total: 2,
        data: m1.slice(half1),
      }),
    );
    a.receive(
      JSON.stringify({
        ch: "chunk",
        id: "m2",
        index: 1,
        total: 2,
        data: m2.slice(half2),
      }),
    );

    expect(closed).toEqual([]);
    expect(a.reassemblingCount).toBe(0);
    expect(pipes).toEqual([`one-${"a".repeat(250)}`, `two-${"b".repeat(250)}`]);
  });

  it("clears buffered chunk reassemblies on markLost", () => {
    const { a, pipes } = pair({ maxFrameBytes: 400 });
    a.receive(
      JSON.stringify({
        ch: "chunk",
        id: "partial",
        index: 0,
        total: 2,
        data: '{"ch":"pipe",',
      }),
    );
    expect(a.reassemblingCount).toBe(1);
    a.markLost("dropped");
    expect(a.reassemblingCount).toBe(0);
    a.receive(
      JSON.stringify({
        ch: "chunk",
        id: "partial",
        index: 1,
        total: 2,
        data: '"frame":"late"}',
      }),
    );
    expect(pipes).toEqual([]);
    expect(a.reassemblingCount).toBe(0);
  });

  it("preserves legacy behavior when chunking is not negotiated", async () => {
    const { a, pipes, frames } = pair({ maxFrameBytes: 200 });
    expect(a.chunked).toBe(false);
    expect(() => a.sendPipe("x".repeat(300))).toThrow(/too big/);
    await expect(a.call("echo", "x".repeat(300))).rejects.toMatchObject({
      kind: "remote",
      message: expect.stringMatching(/too big/),
    });
    expect(frames).toHaveLength(0);

    const payload = JSON.stringify({ ch: "pipe", frame: "ok" });
    a.receive(
      JSON.stringify({
        ch: "chunk",
        id: "legacy-in",
        index: 0,
        total: 1,
        data: payload,
      }),
    );
    expect(pipes).toEqual(["ok"]);
  });
});
