import type { RemoteSessions } from "../src/bundled/sessions";
/**
 * The seams a host uses to put sessions on other machines.
 *
 * The server learns three small things and no feature: a WebSocket route besides `/ws` (the
 * transport only knows "this path upgrades, and these are its handlers"), a router that is handed
 * the `sessions.*` actions for session ids that live elsewhere, and the model layer and session
 * defaults of an assembled server (what a host proxies for a machine that has none).
 */
import type { DispatchOutcome } from "../src/registry";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { sessionsPlugin } from "../src/bundled/sessions";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";
import { assembleServer } from "../src/server";
import { serveWire } from "../src/transport";
import { WireService } from "../src/wire-service";

const roots: string[] = [];
const stops: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-seams-"));
  roots.push(root);
  return root;
}

describe("a router for sessions that live elsewhere", () => {
  async function load(remote: RemoteSessions | undefined) {
    const ctx = new Context();
    const wire = new WireService(ctx);
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () =>
        fakeModels([
          assistantMessage({ content: [{ type: "text", text: "local" }] }),
        ]),
    });
    const fiber = ctx.plugin(
      sessionsPlugin({ manager, remote }) as never,
      undefined as never,
    );
    await fiber;
    stops.push(async () => {
      await (fiber as unknown as { dispose: () => Promise<void> }).dispose();
      await manager.closeAll();
    });
    const call = async (action: string, args?: unknown) =>
      (
        await wire.registry.dispatch(
          { op: "call", target: "sessions", action, args },
          { reply: () => undefined },
        )
      ).result as Record<string, unknown>;
    return { wire, manager, call };
  }

  it("hands every action for an id it owns to the router, with the call as it came", async () => {
    const seen: { action: string; args: unknown }[] = [];
    const remote: RemoteSessions = {
      owns: (id) => id === "far-1",
      call: async (action, call): Promise<DispatchOutcome> => {
        seen.push({ action, args: call.args });
        return { result: { from: "router", action } };
      },
    };
    const { call } = await load(remote);
    expect(await call("prompt", { session: "far-1", text: "hi" })).toEqual({
      from: "router",
      action: "prompt",
    });
    expect(await call("abort", { session: "far-1" })).toEqual({
      from: "router",
      action: "abort",
    });
    expect(await call("history", { session: "far-1" })).toMatchObject({
      from: "router",
    });
    expect(
      await call("image", { session: "far-1", entryId: "e1", index: 1 }),
    ).toMatchObject({ from: "router", action: "image" });
    expect(seen.map((entry) => entry.action)).toEqual([
      "prompt",
      "abort",
      "history",
      "image",
    ]);
    expect(seen[3]?.args).toEqual({
      session: "far-1",
      entryId: "e1",
      index: 1,
    });
    expect(seen[0]?.args).toEqual({ session: "far-1", text: "hi" });
  });

  it("leaves every other session to the manager, and creates and searches locally", async () => {
    const owned: string[] = [];
    const remote: RemoteSessions = {
      owns: (id) => {
        owned.push(id);
        return false;
      },
      call: async () => {
        throw new Error("nothing is remote here");
      },
    };
    const { call, manager } = await load(remote);
    const created = (await call("create", { cwd: "/tmp" })) as {
      session: string;
    };
    expect(await manager.session(created.session)).toBeDefined();
    // The id was asked about; it is local, so the local handler ran.
    await call("focus", { session: created.session });
    expect(owned).toContain(created.session);
    await expect(call("focus", { session: "missing" })).rejects.toThrow(
      /no such session/,
    );
    expect(await call("search", { query: "x" })).toMatchObject({ query: "x" });
  });

  it("works with no router at all", async () => {
    const { call } = await load(undefined);
    await expect(call("focus", { session: "far-1" })).rejects.toThrow(
      /no such session/,
    );
  });
});

describe("a WebSocket route besides /ws", () => {
  async function serve(options: {
    authorize?: (request: Request) => Response | undefined;
  }) {
    const ctx = new Context();
    const wire = new WireService(ctx);
    const opened: { context: unknown; sent: string[]; closed: boolean }[] = [];
    const server = serveWire(
      { wire, mounted: () => [] },
      {
        port: 0,
        authorize: options.authorize,
        endpoints: [
          {
            path: "/peer",
            accept: (request) =>
              request.headers.get("authorization") === "Bearer yes"
                ? { context: { who: "ada" } }
                : new Response("no", { status: 401 }),
            open: (socket, context) => {
              const record = { context, sent: [] as string[], closed: false };
              opened.push(record);
              socket.send("welcome");
              return {
                message: (text) => {
                  record.sent.push(text);
                  socket.send(`echo ${text}`);
                },
                close: () => {
                  record.closed = true;
                },
              };
            },
          },
        ],
      },
    );
    stops.push(() => server.stop());
    return { server, opened };
  }

  function dial(port: number, headers: Record<string, string>) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/peer`, {
      headers,
    } as never);
    const received: string[] = [];
    socket.addEventListener("message", (event) =>
      received.push(String(event.data)),
    );
    return {
      socket,
      received,
      opened: new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("refused")));
      }),
    };
  }

  const until = async (predicate: () => boolean) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > 3_000) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it("hands an accepted peer to the endpoint, with what accept decided, and tells it when the peer is gone", async () => {
    const { server, opened } = await serve({});
    const peer = dial(server.port, { authorization: "Bearer yes" });
    await peer.opened;
    await until(() => peer.received.includes("welcome"));
    peer.socket.send("hello");
    await until(() => peer.received.includes("echo hello"));
    expect(opened[0]).toMatchObject({
      context: { who: "ada" },
      sent: ["hello"],
    });
    peer.socket.close();
    await until(() => opened[0]?.closed === true);
  });

  it("refuses a peer the endpoint does not accept, and `authorize` is asked first", async () => {
    const { server, opened } = await serve({
      authorize: (request) =>
        request.headers.get("x-gate") === null
          ? new Response("gated", { status: 403 })
          : undefined,
    });
    await expect(
      dial(server.port, { authorization: "Bearer yes" }).opened,
    ).rejects.toThrow(/refused/);
    await expect(
      dial(server.port, { "x-gate": "1", authorization: "Bearer no" }).opened,
    ).rejects.toThrow(/refused/);
    expect(opened).toHaveLength(0);
    const peer = dial(server.port, {
      "x-gate": "1",
      authorization: "Bearer yes",
    });
    await peer.opened;
    peer.socket.close();
  });

  it("stopping the server closes the peers it holds", async () => {
    const { server, opened } = await serve({});
    const peer = dial(server.port, { authorization: "Bearer yes" });
    await peer.opened;
    await until(() => opened.length === 1);
    server.stop();
    await until(() => opened[0]?.closed === true);
  });
});

describe("an assembled server", () => {
  it("offers the model layer it generates with and what a new session starts as", async () => {
    const dataDir = await directory();
    const models = fakeModels([]);
    const server = await assembleServer({
      dataDir,
      configPath: join(dataDir, "config.json"),
      port: 0,
      models,
      network: false,
      plugins: ["sessions"],
    });
    stops.push(() => server.close());
    expect(server.models).toBe(models);
    expect(await server.defaults()).toEqual({});
  });

  it("routes sessions it does not hold to the router it is given", async () => {
    const dataDir = await directory();
    const calls: string[] = [];
    const server = await assembleServer({
      dataDir,
      configPath: join(dataDir, "config.json"),
      port: 0,
      models: fakeModels([]),
      network: false,
      plugins: ["sessions"],
      remoteSessions: {
        owns: (id) => id === "far-1",
        call: async (action) => {
          calls.push(action);
          return { result: { ok: true } };
        },
      },
    });
    stops.push(() => server.close());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const outcome = await server.wire.dispatch(
      {
        op: "call",
        target: "sessions",
        action: "abort",
        args: { session: "far-1" },
      },
      { reply: () => undefined },
    );
    expect(outcome.result).toEqual({ ok: true });
    expect(calls).toEqual(["abort"]);
  });
});
