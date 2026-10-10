import type { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import { expect, test } from "bun:test";
import { AppServer, RpcError } from "./appserver.ts";

/** The app-server's side of the pipes: what the client wrote, and a way to answer. */
function pipes() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  let exit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => (exit = resolve));
  const client = new AppServer(toServer, fromServer, exited);
  const written: Record<string, unknown>[] = [];
  toServer.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      written.push(JSON.parse(line));
    }
  });
  const say = (message: object) =>
    fromServer.write(`${JSON.stringify(message)}\n`);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { client, written, say, tick, exit };
}

test("requests are answered by id; errors reject", async () => {
  const { client, written, say, tick } = pipes();
  const first = client.request("turn/interrupt", {
    threadId: "t",
    turnId: "u",
  });
  const second = client.request("thread/compact/start", { threadId: "t" });
  await tick();
  expect(written).toEqual([
    { id: 1, method: "turn/interrupt", params: { threadId: "t", turnId: "u" } },
    { id: 2, method: "thread/compact/start", params: { threadId: "t" } },
  ]);
  say({ id: 2, result: {} });
  say({ id: 1, error: { code: -32600, message: "no active turn" } });
  expect(await second).toEqual({});
  const error = await first.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RpcError);
  expect((error as RpcError).code).toBe(-32600);
});

test("notifications arrive in order; requests are answered with the handler's result", async () => {
  const { client, written, say, tick } = pipes();
  const seen: string[] = [];
  client.onNotification((n) => seen.push(n.method));
  client.onRequest(async (r) => ({
    decision:
      r.method === "item/fileChange/requestApproval" ? "accept" : "decline",
  }));
  say({ method: "turn/started", params: { threadId: "t", turn: { id: "u" } } });
  say({ id: "srv-1", method: "item/fileChange/requestApproval", params: {} });
  say({
    method: "turn/completed",
    params: { threadId: "t", turn: { id: "u" } },
  });
  await tick();
  expect(seen).toEqual(["turn/started", "turn/completed"]);
  expect(written).toEqual([{ id: "srv-1", result: { decision: "accept" } }]);
});

test("what is still waiting fails when the app-server exits", async () => {
  const { client, exit } = pipes();
  const waiting = client.request("thread/compact/start", { threadId: "t" });
  exit(1);
  await expect(waiting).rejects.toThrow("exited");
  expect(await client.exited).toBe(1);
});
