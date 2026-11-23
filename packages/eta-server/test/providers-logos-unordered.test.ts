/**
 * `providers.logos` asks models.dev and may wait on it; it reads no saved configuration, so it
 * runs out of order (OpMeta.unordered) and a slow one does not hold up the calls behind it.
 */
import type { ServerFrame } from "@eta/client-wire-proto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import { afterEach, expect, it } from "vitest";
import { providersPlugin } from "../src/bundled/providers";
import { ProviderConfigStore } from "../src/providers/store";
import { createConnection } from "../src/transport";
import { WireService } from "../src/wire-service";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("does not hold up the calls behind a slow logos lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-providers-logos-"));
  roots.push(root);
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const send = (async () => {
    await opened;
    return new Response("none", { status: 404 });
  }) as unknown as typeof fetch;
  const ctx = new Context();
  const wire = new WireService(ctx);
  const store = new ProviderConfigStore({
    path: join(root, "config.json"),
    watchIntervalMs: 0,
  });
  const fiber = ctx.plugin(
    providersPlugin({ store, fetch: send }) as never,
    undefined as never,
  );
  await fiber;
  wire.handle("sessions", "prompt", () => ({ result: "now" }));
  const frames: ServerFrame[] = [];
  const connection = createConnection(
    { id: 1, send: (frame: ServerFrame) => frames.push(frame) },
    { wire, mounted: () => [] },
  );
  const call = (
    target: string,
    action: string,
    requestId: string,
    args?: unknown,
  ) =>
    JSON.stringify({
      op: "call",
      target,
      action,
      requestId,
      ...(args === undefined ? {} : { args }),
    });
  const ids = () =>
    frames
      .filter((frame) => frame.type === "reply")
      .map((frame) => (frame as { requestId: string }).requestId);

  const first = connection.handle(
    call("providers", "logos", "r1", { sources: [{ key: "a", id: "openai" }] }),
  );
  const second = connection.handle(call("sessions", "prompt", "r2"));
  await Promise.race([second, new Promise((done) => setTimeout(done, 100))]);
  expect(ids()).toEqual(["r2"]);

  open();
  await first;
  await second;
  expect(ids()).toEqual(["r2", "r1"]);
  await (fiber as unknown as { dispose: () => Promise<void> }).dispose();
});
