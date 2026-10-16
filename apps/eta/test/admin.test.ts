import type { AdminInput } from "../src/admin/llm";
import type { Host } from "../src/host";
/**
 * The management surface (REFACTOR.md §9, P1.4).
 *
 * The claim is about the *rules*, not about the routes existing: a connection's state has to be
 * derived from what this host can actually see — whether a credential is there, whether the
 * provider could be built, and how the last call went — and the state names are the ones a settings
 * page branches on (`needs_login` for "the user has to act", `rate_limited` for "waiting fixes it").
 *
 * Half of it is unit: the derivation is a pure function of the config, the catalog and the usage
 * rows, so the rules are stated once and checked directly. The other half goes through the host, so
 * the wiring (the credential file, the usage table, the config's mtime) is covered too.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentUsageOf,
  connectionsOf,
  connectorsOf,
  modelsOf,
} from "../src/admin/llm";
import { configuredProviders, readConfig } from "../src/config";
import { assembleHost } from "../src/host";
import { providerCatalog } from "../src/providers/catalog";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const base = (overrides: Partial<AdminInput> = {}): AdminInput => ({
  providers: [],
  catalog: providerCatalog(),
  failures: [],
  recent: [],
  signedIn: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const provider = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "p1",
    kind: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-1",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 64000 },
    ],
    ...overrides,
  }) as unknown as AdminInput["providers"][number];

describe("what a connection's state means", () => {
  it("is needs_login when the credential is not there, and active when it is", () => {
    const missing = connectionsOf(
      base({ providers: [provider({ apiKey: undefined })] }),
    );
    expect(missing[0]).toMatchObject({
      id: "p1",
      connector: "deepseek",
      state: "needs_login",
      label: "DeepSeek",
    });

    const present = connectionsOf(base({ providers: [provider()] }));
    expect(present[0]?.state).toBe("active");
  });

  it("is needs_login for a device-code kind with no credential, and active once signed in", () => {
    const codex = provider({
      id: "codex",
      kind: "openai-codex",
      apiKey: undefined,
    });
    expect(connectionsOf(base({ providers: [codex] }))[0]?.state).toBe(
      "needs_login",
    );
    expect(
      connectionsOf(base({ providers: [codex], signedIn: ["codex"] }))[0]
        ?.state,
    ).toBe("active");
  });

  it("is rate_limited when the last call was throttled, and degraded when it failed otherwise", () => {
    const throttled = connectionsOf(
      base({
        providers: [provider()],
        recent: [
          {
            provider: "p1",
            model: "deepseek-chat",
            failed: true,
            error: "429 Too Many Requests",
          },
        ],
      }),
    );
    expect(throttled[0]).toMatchObject({
      state: "rate_limited",
      error: { code: "rate_limited" },
    });

    const broken = connectionsOf(
      base({
        providers: [provider()],
        recent: [
          {
            provider: "p1",
            model: "deepseek-chat",
            failed: true,
            error: "500 oops",
          },
        ],
      }),
    );
    expect(broken[0]).toMatchObject({
      state: "degraded",
      error: { code: "provider_error", message: "500 oops" },
    });
  });

  it("is error when the provider could not be built at all", () => {
    const derived = connectionsOf(
      base({
        providers: [provider()],
        failures: [{ id: "p1", error: "unknown kind" }],
      }),
    );
    expect(derived[0]).toMatchObject({
      state: "error",
      error: { code: "provider_build_failed", message: "unknown kind" },
    });
    // And a model behind it cannot be used: a chat would fail however long it waited.
    expect(
      modelsOf(
        base({ providers: [provider()], failures: [{ id: "p1", error: "x" }] }),
      )[0],
    ).toMatchObject({
      id: "p1:deepseek-chat",
      status: "unavailable",
      available: false,
    });
  });
});

describe("the derived views", () => {
  it("names the models the way an agent names them", () => {
    const models = modelsOf(base({ providers: [provider()] }));
    expect(models).toEqual([
      {
        id: "p1:deepseek-chat",
        connector: "deepseek",
        display_name: "DeepSeek Chat",
        context_window: 64000,
        status: "available",
        available: true,
      },
    ]);
  });

  it("lists the kinds of account, with how each is authorised", () => {
    const connectors = connectorsOf(providerCatalog());
    const codex = connectors.find((entry) => entry.id === "openai-codex");
    expect(codex).toMatchObject({ flow: "device_code" });
    const deepseek = connectors.find((entry) => entry.id === "deepseek");
    expect(deepseek).toMatchObject({
      display_name: "DeepSeek",
      flow: "api_key",
    });
    // A custom endpoint is a kind too, needing a key like the rest and named by itself.
    const custom = connectors.find((entry) => entry.id === "openai-compatible");
    expect(custom).toMatchObject({
      display_name: "openai-compatible",
      flow: "api_key",
    });
  });

  it("says nothing about provider quotas, because it does not poll them", () => {
    const usage = agentUsageOf([
      {
        subject: "agent-1",
        windows: [
          {
            hours: 5,
            requests: 3,
            failed: 1,
            input: 100,
            output: 20,
            cacheRead: 5,
            cacheWrite: 0,
            reasoning: 2,
            total: 127,
          },
        ],
        models: [
          {
            provider: "p1",
            model: "deepseek-chat",
            requests: 3,
            failed: 1,
            input: 100,
            output: 20,
            cacheRead: 5,
            cacheWrite: 0,
            reasoning: 2,
            total: 127,
          },
        ],
      },
    ]);
    expect(usage[0]?.windows["5h"]).toEqual({
      requests: 3,
      failed: 1,
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 5,
      reasoning_tokens: 2,
      total_tokens: 127,
    });
    expect(usage[0]?.models[0]?.name).toBe("p1:deepseek-chat");
    // The account view is per provider, which is all this host knows about an account.
    expect(usage[0]?.accounts).toEqual([
      { name: "p1", ...usage[0]!.windows["5h"]! },
    ]);
  });
});

describe("over HTTP", () => {
  async function start(config: unknown): Promise<Host> {
    const root = await mkdtemp(join(tmpdir(), "eta-admin-"));
    roots.push(root);
    await writeFile(join(root, "config.json"), JSON.stringify(config), "utf8");
    const host = await assembleHost({
      dataDir: root,
      port: 0,
      warn: () => undefined,
      // No model layer of its own: the providers below are the point, not their wire.
      models: undefined,
    });
    hosts.push(host);
    return host;
  }

  const get = async (host: Host, path: string): Promise<unknown> =>
    (await (
      await fetch(`http://127.0.0.1:${host.port}${path}`)
    ).json()) as unknown;

  it("answers with what the config and the usage table say", async () => {
    const host = await start({
      providers: [
        {
          id: "keyed",
          kind: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-1",
          models: [{ id: "deepseek-chat" }],
        },
        {
          id: "unkeyed",
          kind: "deepseek",
          baseUrl: "https://api.deepseek.com",
          models: [{ id: "deepseek-chat" }],
        },
      ],
      defaultModel: "keyed:deepseek-chat",
    });

    // A real generation that was throttled, recorded the way the recorder records one.
    host.usage.record({
      subject: "agent-1",
      provider: "keyed",
      model: "deepseek-chat",
      failed: true,
      error: "429 Too Many Requests",
    });

    const connections = (await get(host, "/api/llm/v1/connections")) as {
      id: string;
      state: string;
    }[];
    expect(connections.map((entry) => [entry.id, entry.state])).toEqual([
      ["keyed", "rate_limited"],
      ["unkeyed", "needs_login"],
    ]);

    const models = (await get(host, "/api/llm/v1/models")) as {
      id: string;
      status: string;
      available: boolean;
    }[];
    expect(models).toEqual([
      {
        id: "keyed:deepseek-chat",
        connector: "deepseek",
        display_name: "deepseek-chat",
        // Usable, but the last call was throttled — and the reason says which.
        status: "degraded",
        available: true,
        reason: { code: "rate_limited", message: "429 Too Many Requests" },
      },
      {
        id: "unkeyed:deepseek-chat",
        connector: "deepseek",
        display_name: "deepseek-chat",
        status: "unavailable",
        available: false,
        reason: {
          code: "needs_login",
          message: "this account has no credential; sign in before using it",
        },
      },
    ]);

    // The counted usage is this host's own (P1.3), in the product's counts.
    const counted = (await get(host, "/api/llm/v1/usage/agents")) as {
      usage: {
        principal: string;
        windows: Record<string, { failed: number }>;
      }[];
    };
    const subject = counted.usage.find(
      (entry) => entry.principal === "agent-1",
    );
    expect(subject?.windows["5h"]?.failed).toBe(1);

    // Quotas are not polled, and the route says so by being empty rather than by inventing one.
    expect(await get(host, "/api/llm/v1/usage")).toEqual([]);

    const refreshed = (await (
      await fetch(`http://127.0.0.1:${host.port}/api/llm/v1/refresh`, {
        method: "POST",
      })
    ).json()) as { connections: unknown[] };
    expect(refreshed.connections).toHaveLength(2);
  });

  it("says the config is empty rather than pretending to know a provider", async () => {
    const host = await start({ providers: [] });
    const response = await fetch(
      `http://127.0.0.1:${host.port}/api/llm/v1/refresh`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(409);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("NO_PROVIDERS");
    expect(await get(host, "/api/llm/v1/connections")).toEqual([]);
    // The kinds that exist do not depend on the config: a settings page can still offer them.
    const connectors = (await get(host, "/api/llm/v1/connectors")) as unknown[];
    expect(connectors.length).toBeGreaterThan(0);
  });

  it("reads the providers the config file names, once", async () => {
    // The derivation is fed by the same read the runtime is built from — a second reading of the
    // config would be a second answer to "which providers exist".
    const root = await mkdtemp(join(tmpdir(), "eta-admin-cfg-"));
    roots.push(root);
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        providers: [
          {
            id: "a",
            kind: "deepseek",
            baseUrl: "https://api.deepseek.com",
            models: [],
          },
        ],
      }),
      "utf8",
    );
    const config = await readConfig(path, () => undefined);
    expect(configuredProviders(config).map((entry) => entry.id)).toEqual(["a"]);
  });
});
