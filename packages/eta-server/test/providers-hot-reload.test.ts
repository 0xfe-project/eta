/**
 * The model layer follows the config file (S19, the half the settings page cannot see).
 *
 * `providers-plugin.test.ts` proves the *view* of the config is live. This proves the thing that
 * actually breaks when it is not: a provider that appears in the UI but not in the layer sessions
 * generate through is a provider that fails as `model_unavailable` at the first turn of the first
 * run that uses it, which reads to the user as "the model does not exist" — with the app running
 * fine for everything else.
 *
 * Both ways a config moves are covered: a write through the plugin (what the settings page does)
 * and a write beside the process (what an editor, or another tool, does). And the two ways it can
 * go wrong: a file that stopped parsing must not take away working providers, and an empty list
 * must take them away on purpose.
 */

import type { ProvidersView } from "@eta/client-contracts";
import type { StateSnapshot } from "@eta/client-wire-proto";
import type { AssembledServer } from "../src/server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleServer } from "../src/server";

const roots: string[] = [];
const servers: AssembledServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** One configured provider, on a URL nothing is asked of. */
const entry = (id: string, modelId = "m1") => ({
  id,
  kind: "openai-compatible" as const,
  baseUrl: `https://${id}.example/v1`,
  apiKey: "test-key",
  models: [{ id: modelId, name: modelId, contextWindow: 128_000 }],
});

async function writeConfig(path: string, raw: string): Promise<void> {
  await writeFile(path, raw);
}

const json = (providers: unknown[]): string =>
  `${JSON.stringify({ providers }, null, 2)}\n`;

async function start(providers: unknown[]): Promise<{
  server: AssembledServer;
  path: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "eta-model-hot-reload-"));
  roots.push(root);
  const path = join(root, "config.json");
  await writeConfig(path, json(providers));
  const server = await assembleServer({
    dataDir: root,
    configPath: path,
    port: 0,
    network: false,
  });
  servers.push(server);
  // The plugin reads the file before it can answer anything, and `providers.reload` only calls
  // the host about a change it can compare against a previous reading.
  await until(() => view(server) !== undefined);
  return { server, path };
}

function view(server: AssembledServer): ProvidersView | undefined {
  const snapshot = server.wire.snapshot("providers") as
    | StateSnapshot
    | undefined;
  return snapshot?.sections.config as ProvidersView | undefined;
}

async function call(
  server: AssembledServer,
  action: string,
  args?: unknown,
): Promise<unknown> {
  const outcome = (await server.wire.dispatch(
    { op: "call", target: "providers", action, args },
    { reply: () => undefined } as never,
  )) as { result?: unknown };
  return outcome?.result;
}

async function until(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("timed out waiting for the model layer");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the model layer, hot", () => {
  it.each([
    "deepseek",
    "kimi-coding",
    "zai",
    "zai-coding-cn",
    "openai-compatible",
    "openai-responses",
  ] as const)(
    "%s exposes manually saved unknown IDs to execution without catalog membership",
    async (kind) => {
      const { server } = await start([]);
      await call(server, "save", {
        revision: view(server)?.revision,
        provider: {
          ...entry("named", "manual-unknown"),
          kind,
          models: [
            { id: "manual-unknown", overrides: { contextWindow: 64000 } },
          ],
        },
      });
      await until(
        () => server.models.getModel("named", "manual-unknown") !== undefined,
      );
      expect(server.models.getModel("named", "manual-unknown")).toMatchObject({
        id: "manual-unknown",
        contextWindow: 64000,
        baseUrl: "https://named.example/v1",
      });
    },
  );
  it("serves a provider the settings page just saved, without a restart", async () => {
    const { server } = await start([entry("a")]);
    expect(server.models.getModel("a", "m1")).toBeDefined();
    expect(server.models.getModel("b", "m2")).toBeUndefined();

    await call(server, "save", {
      revision: view(server)?.revision,
      provider: entry("b", "m2"),
    });

    // The rebuild is told about, not awaited by, the save's reply — so the layer is polled.
    await until(() => server.models.getModel("b", "m2") !== undefined);
    // And the provider that was already there is still there: the new layer replaces the
    // collection, not the user's other providers.
    expect(server.models.getModel("a", "m1")).toBeDefined();
  });

  it("picks up a provider an editor wrote into the file", async () => {
    const { server, path } = await start([entry("a")]);
    await writeConfig(path, json([entry("a"), entry("c", "m2")]));

    await call(server, "reload");

    expect(server.models.getModel("c", "m2")).toBeDefined();
    expect(server.models.getModel("a", "m1")).toBeDefined();
  });

  it("keeps the providers it has when the file stopped parsing", async () => {
    const { server, path } = await start([entry("a")]);
    await writeConfig(path, "{ this is not json");

    await expect(call(server, "reload")).rejects.toThrow(
      /invalid_saved_config/,
    );

    // A typo in an editor is not a reason to stop serving a working provider.
    expect(server.models.getModel("a", "m1")).toBeDefined();
  });

  it("drops the models when the config says there are no providers", async () => {
    const { server, path } = await start([entry("a")]);
    await writeConfig(path, json([]));

    await call(server, "reload");

    // An empty list is an answer, not a failed read: nothing is served, on purpose.
    expect(server.models.getModel("a", "m1")).toBeUndefined();
  });
});
