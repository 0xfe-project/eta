/**
 * `plugins.composioStatus` only reads what the host keeps (is there a key, is the source on), so on
 * a real wire it must not wait behind a slow call of the same connection, such as the one that asks
 * Composio which toolkits are connected.
 */
import type { ServerFrame } from "@eta/client-wire-proto";
import { createRequire } from "node:module";
import { createConnection, WireService } from "@eta/server";
import { expect, it } from "vitest";
import { pluginsPlugin } from "../src/plugins/plugin";

/**
 * The wire service is a cordis service, and cordis is a dependency of @eta/server, not of this app:
 * it is looked up from where @eta/server lives, so this test adds no dependency.
 */
async function context(): Promise<
  ConstructorParameters<typeof WireService>[0]
> {
  const from = createRequire(
    createRequire(import.meta.url).resolve("@eta/server"),
  );
  const { Context } = (await import(from.resolve("cordis"))) as {
    Context: new () => ConstructorParameters<typeof WireService>[0];
  };
  return new Context();
}

it("answers composioStatus while a slow composioConnected ahead of it is still waiting", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const composio = {
    hasKey: () => true,
    source: () => ({ enabled: true }),
    follow: async () => {
      await slow;
      return { status: "ready", slugs: [] };
    },
  };
  const wire = new WireService(await context());
  pluginsPlugin(
    {
      plugins: {} as never,
      agents: {} as never,
      market: {} as never,
      composio: composio as never,
    },
    () => {},
  ).apply({ wire, sessions: {}, effect: (run: () => unknown) => run() });
  const frames: ServerFrame[] = [];
  const connection = createConnection(
    { id: 1, send: (frame: ServerFrame) => frames.push(frame) },
    { wire, mounted: () => [] },
  );
  const call = (action: string, requestId: string) =>
    JSON.stringify({ op: "call", target: "plugins", action, requestId });
  const replies = () =>
    frames
      .filter((frame) => frame.type === "reply")
      .map((frame) => (frame as { requestId: string }).requestId);

  const first = connection.handle(call("composioConnected", "r1"));
  const second = connection.handle(call("composioStatus", "r2"));
  await Promise.race([second, new Promise((done) => setTimeout(done, 100))]);
  expect(replies()).toEqual(["r2"]);

  release();
  await first;
  await second;
  expect(replies()).toEqual(["r2", "r1"]);
});
