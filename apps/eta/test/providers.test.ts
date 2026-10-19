/**
 * Model providers through the real host: a client saves a custom OpenAI-compatible provider over
 * the socket, the `providers` state moves, and the key is a boolean on the wire and a string only
 * in the config file, which only its owner can read.
 */
import type { ProvidersView, ServerFrame } from "@eta/client-contracts";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connect, until } from "./support/client";
import { testHost } from "./support/host";

type StateFrame = Extract<ServerFrame, { type: "state" }>;

const SECRET = "sk-test-0123456789abcdef";

/** The `providers` config as the newest state frame left it. */
function configOf(frames: ServerFrame[]): ProvidersView | undefined {
  let config: ProvidersView | undefined;
  for (const frame of frames) {
    if (frame.type !== "state" || frame.target !== "providers") continue;
    const sections =
      (frame as StateFrame).snapshot?.sections ??
      (frame as StateFrame).patch?.sections;
    if (sections?.config !== undefined)
      config = sections.config as ProvidersView;
  }
  return config;
}

describe("model providers", () => {
  it("save a custom provider: state moves, the key stays off the wire, the file is private", async () => {
    const host = await testHost();
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    const hello = await client.hello();
    // An eager target: its state rides in hello (empty until the host has read the file).
    expect(Object.keys(hello.state)).toContain("providers");

    // Subscribing is what brings the pushes; the snapshot carries the revision a write must carry.
    client.subscribe("providers");
    await until(() => configOf(client.frames) !== undefined);
    const first = configOf(client.frames)!;
    expect(first.providers).toEqual([]);

    const saved = (await client.call("providers", "save", {
      revision: first.revision,
      provider: {
        id: "custom",
        name: "Custom",
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: SECRET,
        headers: { "x-test": "1" },
        models: [{ id: "m1", name: "One", contextWindow: 32_000 }],
      },
    })) as { revision: string };

    await until(
      () =>
        configOf(client.frames)?.providers.some((p) => p.id === "custom") ===
        true,
    );
    const view = configOf(client.frames)!;
    expect(view.revision).toBe(saved.revision);
    expect(view.providers).toEqual([
      {
        id: "custom",
        name: "Custom",
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:9/v1",
        // The key is reported as present; the key itself is not on the wire.
        hasApiKey: true,
        headers: { "x-test": "1" },
        models: [{ id: "m1", name: "One", contextWindow: 32_000 }],
      },
    ]);
    expect(JSON.stringify(client.frames)).not.toContain(SECRET);

    // On disk the config holds the key, readable by its owner alone.
    const path = join(host.dataDir, "config.json");
    expect(JSON.parse(await readFile(path, "utf8")).providers[0].apiKey).toBe(
      SECRET,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    client.close();
  });

  it("refuse a write made on a config that has moved on, and take it back by id", async () => {
    const host = await testHost();
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    await client.hello();
    client.subscribe("providers");
    await until(() => configOf(client.frames) !== undefined);
    const stale = configOf(client.frames)!.revision;
    const provider = {
      id: "a",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [{ id: "m" }],
    };
    await client.call("providers", "save", { revision: stale, provider });

    await expect(
      client.call("providers", "save", {
        revision: stale,
        provider: { ...provider, id: "b" },
      }),
    ).rejects.toThrow("config_changed");

    await until(() => configOf(client.frames)?.providers.length === 1);
    const current = configOf(client.frames)!;
    await client.call("providers", "delete", {
      revision: current.revision,
      id: "a",
    });
    await until(() => configOf(client.frames)?.providers.length === 0);
    client.close();
  });
});
