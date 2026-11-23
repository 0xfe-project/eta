/**
 * The bundled `providers` plugin (S19).
 *
 * The plugin's job is small and specific: put `~/.eta/config.json` on the wire as a state target
 * with actions that carry a revision, and push when the file changes underneath. These tests
 * load it the way a loader would and check only through the pipe's doors.
 */

import type {
  ProviderCheckResult,
  ProviderRefreshResult,
  ProvidersView,
  SourceSummaries,
  SourceSummaryEvent,
} from "@eta/client-contracts";
import type {
  EventFrame,
  ServerFrame,
  StateSnapshot,
} from "@eta/client-wire-proto";
import type { ProvidersPluginOptions } from "../src/bundled/providers";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_ACTIONS, providersPlugin } from "../src/bundled/providers";
import { MODELS_DEV_URL } from "../src/providers/metadata";
import { ProviderConfigStore, revisionOf } from "../src/providers/store";
import { createConnection } from "../src/transport";
import { WireService } from "../src/wire-service";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

interface Harness {
  ctx: Context;
  wire: WireService;
  frames: { target?: string; frame: ServerFrame }[];
  store: ProviderConfigStore;
  load: () => Promise<void>;
  unload: () => Promise<void>;
  call: (action: string, args?: unknown) => Promise<unknown>;
  config: () => ProvidersView | undefined;
}

async function harness(
  options: Pick<ProvidersPluginOptions, "fetch" | "streamQuotaSummaries"> & {
    watchIntervalMs?: number;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "eta-providers-plugin-"));
  roots.push(root);
  const ctx = new Context();
  const wire = new WireService(ctx);
  const frames: { target?: string; frame: ServerFrame }[] = [];
  wire.attachSink((addressed) => frames.push(addressed));
  const store = new ProviderConfigStore({
    path: join(root, "config.json"),
    watchIntervalMs: options.watchIntervalMs ?? 0,
  });
  let unload: (() => Promise<void>) | undefined;
  return {
    ctx,
    wire,
    frames,
    store,
    async load() {
      const fiber = ctx.plugin(
        providersPlugin({
          store,
          streamQuotaSummaries: options.streamQuotaSummaries,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }) as never,
        undefined as never,
      );
      await fiber;
      unload = async () => {
        await (fiber as unknown as { dispose: () => Promise<void> }).dispose();
      };
    },
    async unload() {
      await unload?.();
    },
    async call(action, args) {
      return await wire.dispatch(
        { op: "call", target: "providers", action, args },
        {
          reply: () => undefined,
        } as never,
      );
    },
    config() {
      const snapshot = wire.snapshot("providers") as StateSnapshot | undefined;
      return (
        (snapshot?.sections.config as ProvidersView | undefined) ?? undefined
      );
    },
  };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("timed out waiting for the state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The reply body of a call that succeeded, or the error it was refused with. */
async function callResult(
  h: Harness,
  action: string,
  args?: unknown,
): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  try {
    const outcome = (await h.call(action, args)) as { result?: unknown };
    return { ok: true, result: outcome?.result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const provider = (id: string) => ({
  id,
  kind: "openai-compatible" as const,
  baseUrl: `https://${id}.example/v1`,
  models: [{ id: "m1" }],
});

describe("what the plugin puts on the pipe", () => {
  it("registers its actions and an eager state target", async () => {
    const h = await harness();
    await h.load();
    expect(
      h.wire
        .descriptors()
        .map((descriptor) => descriptor.name)
        .sort(),
    ).toEqual(
      [
        "billing.readSourceSummaries",
        "billing.startSourceSummaries",
        ...PROVIDER_ACTIONS.map((action) => `providers.${action}`),
      ].sort(),
    );
    // Eager: a client that just connected draws the settings page from `hello`.
    expect(h.wire.registry.eagerTargets()).toContain("providers");
    await h.unload();
  });

  it("takes every registration with it", async () => {
    const h = await harness();
    await h.load();
    await h.unload();
    expect(h.wire.descriptors()).toEqual([]);
    expect(h.wire.registry.hasState("providers")).toBe(false);
  });
});

describe("the config over the wire", () => {
  it("saves a provider, and the state says what the file now holds", async () => {
    const h = await harness();
    await h.load();
    h.wire.subscribe(1, "providers");
    // The plugin reads the config when it loads; give that read its turn before asking for the
    // revision, or the test races the load it is asserting about. Until then the state is
    // deliberately empty rather than a fabricated "no providers, revision ''".
    await until(() => h.config() !== undefined);
    h.frames.length = 0;
    const before = h.config();
    expect(before?.providers).toEqual([]);
    // And the revision it hands out is the file's own (no file: the hash of nothing), not a
    // placeholder that a write would be refused for.
    expect(before?.revision).toBe(revisionOf(""));

    const saved = await callResult(h, "save", {
      revision: before?.revision,
      provider: provider("local"),
    });
    expect(saved.ok).toBe(true);
    expect(h.config()?.providers.map((entry) => entry.id)).toEqual(["local"]);
    // The write pushed: a client that is watching sees the new config without asking.
    expect(
      h.frames.some(
        (entry) => entry.target === "providers" && entry.frame.type === "state",
      ),
    ).toBe(true);
    await h.unload();
  });

  it("refuses a stale revision with a name the client can act on", async () => {
    const h = await harness();
    await h.load();
    await until(() => h.config() !== undefined);
    const first = await callResult(h, "save", {
      revision: revisionOf(""),
      provider: provider("a"),
    });
    expect(first.ok).toBe(true);
    // A second write prepared against the revision that is now old.
    const stale = await callResult(h, "save", {
      revision: revisionOf(""),
      provider: provider("b"),
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain("config_changed");
    expect(h.config()?.providers.map((entry) => entry.id)).toEqual(["a"]);
    await h.unload();
  });

  it("deletes a provider, and has no default model to set", async () => {
    const h = await harness();
    await h.load();
    await until(() => h.config() !== undefined);
    await callResult(h, "save", {
      revision: revisionOf(""),
      provider: provider("a"),
    });
    const revision = h.config()?.revision;

    // There is no default model: the action is gone, not refused.
    const gone = await callResult(h, "setDefault", {
      revision,
      defaultModel: "a:m1",
    });
    expect(gone.ok).toBe(false);
    expect(h.config()).not.toHaveProperty("defaultModel");

    const removed = await callResult(h, "delete", { revision, id: "a" });
    expect(removed.ok).toBe(true);
    expect(h.config()?.providers).toEqual([]);
    await h.unload();
  });

  it("sets the network mode, and answers a reload with the revision", async () => {
    const h = await harness();
    await h.load();
    await until(() => h.config() !== undefined);
    const view = h.config();
    const network = await callResult(h, "setNetwork", {
      revision: view?.revision,
      mode: "manual",
      proxyUrl: "http://127.0.0.1:7890",
      noProxy: "localhost",
    });
    expect(network.ok).toBe(true);
    // Normalised through `URL`, which is what a client parsing it would see.
    expect(h.config()?.network).toEqual({
      mode: "manual",
      proxyUrl: "http://127.0.0.1:7890/",
      noProxy: "localhost",
    });

    // A mode nobody implements is refused, rather than stored and ignored.
    const bad = await callResult(h, "setNetwork", {
      revision: h.config()?.revision,
      mode: "telepathy",
    });
    expect(bad.ok).toBe(false);

    const reloaded = await callResult(h, "reload", {});
    expect(reloaded.ok).toBe(true);
    expect((reloaded.result as { revision: string }).revision).toBe(
      h.config()?.revision,
    );
    await h.unload();
  });

  it("pushes when the file changes underneath, with no action from a client", async () => {
    const h = await harness({ watchIntervalMs: 5 });
    await h.load();
    await until(() => h.config() !== undefined);
    h.wire.subscribe(1, "providers");
    h.frames.length = 0;
    await writeFile(
      join(h.store.path),
      `${JSON.stringify({ providers: [provider("external")] }, null, 2)}\n`,
      "utf8",
    );
    const deadline = Date.now() + 2_000;
    while (h.config()?.providers.length !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(h.config()?.providers.map((entry) => entry.id)).toEqual([
      "external",
    ]);
    // The push is what tells a client that the config it holds is out of date.
    expect(
      h.frames.some(
        (entry) => entry.target === "providers" && entry.frame.type === "state",
      ),
    ).toBe(true);
    await h.unload();
  });
});

describe("refreshing a provider's model list", () => {
  it("a named provider keeps manual IDs and overrides through discover, save, refresh and reload", async () => {
    const h = await harness({
      fetch: (async () =>
        Response.json({
          data: [{ id: "remote-unknown" }],
        })) as unknown as typeof fetch,
    });
    await h.load();
    await until(() => h.config() !== undefined);
    const models = [
      { id: "manual-unknown", overrides: { contextWindow: 64000 } },
      { id: "remote-unknown", overrides: { name: "Mine" } },
    ];
    const discovered = await h.call("discover", {
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test",
    });
    expect(discovered).toMatchObject({
      result: { models: [{ id: "remote-unknown" }] },
    });
    await h.call("save", {
      revision: h.config()!.revision,
      provider: {
        id: "named",
        kind: "deepseek",
        baseUrl: "https://api.deepseek.com",
        models,
      },
    });
    await h.call("refresh", { id: "named" });
    await h.call("reload");
    expect(
      (await new ProviderConfigStore({ path: h.store.path }).read()).config
        .providers?.[0]?.models,
    ).toEqual(models);
    expect(h.config()?.providers[0]?.models).toEqual([
      { ...models[0], contextWindow: 64000 },
      { ...models[1], name: "Mine" },
    ]);
    await h.unload();
  });
  it("asks the endpoint with the saved key, offers what it found and adds none of it", async () => {
    const calls: string[] = [];
    const auth: (string | null)[] = [];
    const send = (async (url: string, init?: RequestInit) => {
      // The public catalog is asked for custom endpoints too; these tests are about the endpoint.
      if (String(url) === MODELS_DEV_URL)
        return new Response(null, { status: 404 });
      calls.push(String(url));
      auth.push(new Headers(init?.headers).get("authorization"));
      return new Response(
        JSON.stringify({
          data: [
            { id: "discovered", context_window: 200_000, max_tokens: 8_000 },
          ],
        }),
        {
          status: 200,
        },
      );
    }) as unknown as typeof fetch;
    const root = await mkdtemp(join(tmpdir(), "eta-providers-refresh-"));
    roots.push(root);
    const ctx = new Context();
    const wire = new WireService(ctx);
    const frames: { target?: string; frame: ServerFrame }[] = [];
    wire.attachSink((addressed) => frames.push(addressed));
    const store = new ProviderConfigStore({ path: join(root, "config.json") });
    const fiber = ctx.plugin(
      providersPlugin({ store, fetch: send }) as never,
      undefined as never,
    );
    await fiber;
    await until(
      () =>
        (wire.snapshot("providers")?.sections.config as
          | ProvidersView
          | undefined) !== undefined,
    );

    const view = wire.snapshot("providers")?.sections.config as ProvidersView;
    await wire.dispatch(
      {
        op: "call",
        target: "providers",
        action: "save",
        args: {
          revision: view.revision,
          provider: {
            id: "local",
            kind: "openai-compatible",
            baseUrl: "https://local.test/v1",
            apiKey: "sk-test",
            models: [{ id: "m1" }],
          },
        },
      },
      { reply: () => undefined } as never,
    );

    const answer = (await wire.dispatch(
      {
        op: "call",
        target: "providers",
        action: "refresh",
        args: { id: "local" },
      },
      {
        reply: () => undefined,
      } as never,
    )) as { result: ProviderRefreshResult };
    expect(calls).toEqual(["https://local.test/v1/models"]);
    expect(auth).toEqual(["Bearer sk-test"]);
    expect(answer.result.models).toEqual([
      { id: "discovered", contextWindow: 200_000, maxTokens: 8_000 },
    ]);
    const refreshed = wire.snapshot("providers")?.sections
      .config as ProvidersView;
    expect(refreshed.providers[0]?.models.map((model) => model.id)).toEqual([
      "m1",
    ]);
    expect(refreshed.providers[0]?.lastRefreshedAt).toBeDefined();
    // A list fetched with the saved key is a check of it.
    expect(wire.snapshot("providers")?.sections.checks).toMatchObject({
      local: { state: "ok" },
    });

    // Refreshing something that is not configured is named as such.
    await expect(
      wire.dispatch(
        {
          op: "call",
          target: "providers",
          action: "refresh",
          args: { id: "nope" },
        },
        {
          reply: () => undefined,
        } as never,
      ),
    ).rejects.toThrow(/no such provider/);
    await (fiber as unknown as { dispose: () => Promise<void> }).dispose();
  });
});

describe("unsaved model discovery", () => {
  it("uses draft connection values without requiring an id or models, writing a file, pushing state or rebuilding runtime", async () => {
    let requested: { url: string; headers: Headers } | undefined;
    const send = (async (
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      // The public catalog is asked for custom endpoints too; these tests are about the endpoint.
      if (String(url) === MODELS_DEV_URL)
        return new Response(null, { status: 404 });
      requested = { url: String(url), headers: new Headers(init?.headers) };
      return Response.json({
        data: [{ id: "new-model", context_window: 12000 }],
      });
    }) as unknown as typeof fetch;
    const h = await harness({ fetch: send });
    await h.load();
    await until(() => h.config() !== undefined);
    const before = h.config();
    h.frames.length = 0;
    const result = await callResult(h, "discover", {
      kind: "openai-compatible",
      baseUrl: "https://draft.test/v1/",
      apiKey: "draft-secret",
      headers: { "User-Agent": "eta-draft", "X-Custom": "custom-secret" },
    });
    expect(result).toEqual({
      ok: true,
      result: { models: [{ id: "new-model", contextWindow: 12000 }] },
    });
    expect(requested?.url).toBe("https://draft.test/v1/models");
    expect(requested?.headers.get("Authorization")).toBe("Bearer draft-secret");
    expect(requested?.headers.get("User-Agent")).toBe("eta-draft");
    expect(requested?.headers.get("X-Custom")).toBe("custom-secret");
    expect(h.config()).toEqual(before);
    expect(h.frames).toEqual([]);
    await expect(readFile(h.store.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await h.unload();
  });

  it("editing reuses the saved key only when omitted; replacement and clear are write-free, and stale revisions are refused", async () => {
    const keys: (string | null)[] = [];
    const h = await harness({
      fetch: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        // The public catalog is asked for custom endpoints too; these tests are about the endpoint.
        if (String(url) === MODELS_DEV_URL)
          return new Response(null, { status: 404 });
        keys.push(new Headers(init?.headers).get("Authorization"));
        return Response.json({ data: [{ id: "new-model" }] });
      }) as unknown as typeof fetch,
    });
    await h.load();
    await until(() => h.config() !== undefined);
    await callResult(h, "save", {
      revision: h.config()?.revision,
      provider: {
        ...provider("existing"),
        apiKey: "saved-secret",
        models: [
          {
            id: "old",
            name: "custom",
            defaultThinking: "high",
            overrides: { contextWindow: 32000 },
          },
        ],
      },
    });
    const before = await readFile(h.store.path, "utf8");
    const args = {
      id: "existing",
      revision: h.config()?.revision,
      kind: "openai-compatible",
      baseUrl: "https://changed.test/v1",
      headers: {},
    };
    expect((await callResult(h, "discover", args)).ok).toBe(true);
    expect(
      (await callResult(h, "discover", { ...args, apiKey: "replacement" })).ok,
    ).toBe(true);
    expect(
      (await callResult(h, "discover", { ...args, apiKey: null })).ok,
    ).toBe(true);
    expect(keys).toEqual(["Bearer saved-secret", "Bearer replacement", null]);
    expect(await readFile(h.store.path, "utf8")).toBe(before);
    const stale = await callResult(h, "discover", {
      ...args,
      revision: "old-revision",
    });
    expect(stale).toEqual({ ok: false, error: "config_changed" });
    expect(keys).toHaveLength(3);
    await h.unload();
  });

  it.each([
    ["not a URL", "openai-compatible", "discovery_invalid_connection"],
    [
      "https://user:secret@draft.test/v1",
      "openai-compatible",
      "discovery_invalid_connection",
    ],
    [
      "https://draft.test/v1?key=secret",
      "openai-compatible",
      "discovery_invalid_connection",
    ],
    ["file:///tmp/models", "openai-compatible", "discovery_invalid_connection"],
    ["https://draft.test/v1", "openai-codex", "discovery_unsupported"],
  ])(
    "refuses unsafe/unsupported connection %s (%s) without echoing it",
    async (baseUrl, kind, error) => {
      let calls = 0;
      const h = await harness({
        fetch: (async () => {
          calls++;
          return Response.json({ data: [] });
        }) as unknown as typeof fetch,
      });
      await h.load();
      expect(await callResult(h, "discover", { baseUrl, kind })).toEqual({
        ok: false,
        error,
      });
      expect(calls).toBe(0);
      await h.unload();
    },
  );

  it.each([
    [
      () => new Response("secret upstream body", { status: 401 }),
      "discovery_http_401",
    ],
    [() => new Response("secret invalid JSON"), "discovery_response"],
    [() => Response.json({ models: [] }), "discovery_response"],
    [
      () => {
        throw new Error("Bearer secret https://private.test/");
      },
      "discovery_network: Bearer [redacted] https://private.test/",
    ],
  ])(
    "reports a safe error without leaking upstream content",
    async (response, error) => {
      const h = await harness({
        fetch: (async () => response()) as unknown as typeof fetch,
      });
      await h.load();
      expect(
        await callResult(h, "discover", {
          kind: "openai-compatible",
          baseUrl: "https://draft.test/v1",
          apiKey: "secret",
        }),
      ).toEqual({ ok: false, error });
      await h.unload();
    },
  );

  it("returns a genuinely empty list as a successful preview", async () => {
    const h = await harness({
      fetch: (async () =>
        Response.json({ data: [] })) as unknown as typeof fetch,
    });
    await h.load();
    expect(
      await callResult(h, "discover", {
        kind: "openai-compatible",
        baseUrl: "https://draft.test/v1",
      }),
    ).toEqual({ ok: true, result: { models: [] } });
    await h.unload();
  });
});

describe("discovery connection safety", () => {
  it("honors case-insensitive authorization overrides/removal like generation", async () => {
    const auth: (string | null)[] = [];
    const h = await harness({
      fetch: (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        auth.push(new Headers(init?.headers).get("Authorization"));
        return Response.json({ data: [] });
      }) as unknown as typeof fetch,
    });
    await h.load();
    for (const authorization of ["Custom replacement", null])
      await callResult(h, "discover", {
        kind: "openai-compatible",
        baseUrl: "https://draft.test/v1",
        apiKey: "original",
        headers: { authorization },
      });
    expect(auth).toEqual(["Custom replacement", null]);
    await h.unload();
  });
  it("bounds upstream requests and safely reports an aborted deadline", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(AbortSignal.abort());
    const h = await harness({
      fetch: (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(true);
        throw new Error("secret timeout detail");
      }) as unknown as typeof fetch,
    });
    await h.load();
    expect(
      await callResult(h, "discover", {
        kind: "openai-compatible",
        baseUrl: "https://draft.test/v1",
      }),
    ).toEqual({ ok: false, error: "discovery_timeout" });
    expect(timeout).toHaveBeenCalledWith(45_000);
    await h.unload();
  });
});

describe("discovery diagnostics", () => {
  it("keeps a useful network diagnostic while redacting the saved key and draft header values", async () => {
    const h = await harness({
      fetch: (async () => {
        throw new Error(
          "ECONNREFUSED draft.test:443 Bearer saved-secret X-Token: header-secret",
        );
      }) as unknown as typeof fetch,
    });
    await h.load();
    await until(() => h.config() !== undefined);
    await callResult(h, "save", {
      revision: h.config()?.revision,
      provider: { ...provider("existing"), apiKey: "saved-secret" },
    });
    expect(
      await callResult(h, "discover", {
        id: "existing",
        revision: h.config()?.revision,
        kind: "openai-compatible",
        baseUrl: "https://draft.test/v1",
        headers: { "X-Token": "header-secret" },
      }),
    ).toEqual({
      ok: false,
      error:
        "discovery_network: ECONNREFUSED draft.test:443 Bearer [redacted] X-Token: [redacted]",
    });
    await h.unload();
  });
});

describe("listing models with models.dev's facts in one call", () => {
  it("fills the gaps of an official endpoint's list, sends models.dev no secret, and writes nothing", async () => {
    let catalogDown = false;
    const send = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url) === "https://models.dev/api.json") {
        if (catalogDown) throw new Error("public network offline");
        return Response.json({
          openai: {
            id: "openai",
            models: {
              exact: {
                id: "exact",
                name: "Public Exact",
                limit: { context: 32000 },
              },
            },
          },
        });
      }
      return Response.json({
        data: [{ id: "exact" }, { id: "own", context_window: 8000 }],
      });
    });
    const h = await harness({ fetch: send });
    await h.load();
    await until(() => h.config() !== undefined);
    await callResult(h, "save", {
      revision: h.config()?.revision,
      provider: {
        ...provider("official"),
        baseUrl: "https://api.openai.com/v1",
        apiKey: "saved-secret",
        headers: { "x-team": "custom-secret" },
        models: [{ id: "exact" }],
      },
    });
    const before = await readFile(h.store.path, "utf8");
    const view = h.config();
    h.frames.length = 0;
    const args = {
      id: "official",
      revision: view?.revision,
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
    };
    expect(await callResult(h, "discover", args)).toEqual({
      ok: true,
      result: {
        models: [
          { id: "exact", name: "Public Exact", contextWindow: 32000 },
          { id: "own", contextWindow: 8000 },
        ],
      },
    });
    const [list, catalog] = send.mock.calls;
    expect(String(list?.[0])).toBe("https://api.openai.com/v1/models");
    expect(new Headers(list?.[1]?.headers).get("authorization")).toBe(
      "Bearer saved-secret",
    );
    expect(String(catalog?.[0])).toBe("https://models.dev/api.json");
    expect(catalog?.[1]?.headers).toEqual({ Accept: "application/json" });
    expect(h.config()).toEqual(view);
    expect(h.frames).toEqual([]);
    expect(await readFile(h.store.path, "utf8")).toBe(before);

    // The catalog is a supplement: without it the list still stands.
    catalogDown = true;
    expect(await callResult(h, "discover", args)).toEqual({
      ok: true,
      result: { models: [{ id: "exact" }, { id: "own", contextWindow: 8000 }] },
    });
    await h.unload();
  });

  it("checks every saved provider, and a refused key reads as such", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).startsWith("https://bad.example")
          ? Response.json({ error: "no" }, { status: 401 })
          : String(url).startsWith("https://down.example")
            ? Promise.reject(new Error("connect ECONNREFUSED"))
            : Response.json({ data: [{ id: "m1" }] }),
      );
    const h = await harness({ fetch: send });
    await h.load();
    await until(() => h.config() !== undefined);
    for (const id of ["good", "bad", "down"])
      await callResult(h, "save", {
        revision: h.config()?.revision,
        provider: { ...provider(id), apiKey: "k" },
      });
    await callResult(h, "save", {
      revision: h.config()?.revision,
      provider: { ...provider("nokey"), kind: "deepseek" },
    });
    const checked = await callResult(h, "check", {});
    expect(checked.ok).toBe(true);
    const checks = (checked.result as ProviderCheckResult).checks;
    expect(Object.keys(checks).sort()).toEqual(["bad", "down", "good"]);
    expect(checks.good?.state).toBe("ok");
    expect(checks.bad).toMatchObject({
      state: "invalid_key",
      error: "discovery_http_401",
    });
    expect(checks.down).toMatchObject({
      state: "unreachable",
      error: "discovery_network",
    });
    expect(
      Object.keys(
        (h.wire.snapshot("providers")?.sections.checks ?? {}) as object,
      ).sort(),
    ).toEqual(["bad", "down", "good"]);
    expect((await callResult(h, "check", { id: "nope" })).error).toMatch(
      /no such provider/,
    );
    await h.unload();
  });
});

describe("account balances through the saved source", () => {
  it("isolates official products, credentials, regions and currencies; requires an explicit paid lookup", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      const token = new Headers(init.headers).get("authorization");
      if (url === "https://api.deepseek.com/user/balance") {
        expect(token).toBe("Bearer synthetic-d");
        return Response.json({
          balance_infos: [
            { currency: "USD", total_balance: "0" },
            { currency: "CNY", total_balance: "12.340000000000001" },
            { currency: "other", total_balance: "42" },
          ],
        });
      }
      const china = url === "https://api.moonshot.cn/v1/users/me/balance";
      if (!china)
        expect(url).toBe("https://api.moonshot.ai/v1/users/me/balance");
      expect(token).toBe(
        china ? "Bearer synthetic-cn" : "Bearer synthetic-global",
      );
      return new Response(
        '{"code":0,"status":true,"data":{"available_balance":0.123456789123456789,"cash_balance":-2}}',
      );
    });
    const h = await harness({ fetch: request as unknown as typeof fetch });
    const sources = [
      ["d", "deepseek", "https://api.deepseek.com"],
      ["cn", "moonshot-cn", "https://api.moonshot.cn/v1"],
      ["global", "moonshot-global", "https://api.moonshot.ai/v1"],
      ["missing", "deepseek", "https://api.deepseek.com"],
      ["spoof", "deepseek", "https://example.test"],
      ["custom", "openai-compatible", "https://api.deepseek.com"],
      ["router", "openrouter", "https://openrouter.ai/api/v1"],
      ["spend", "opencode", "https://opencode.ai/inference/openai/v1"],
      ["cross", "moonshot-cn", "https://api.moonshot.ai/v1"],
    ];
    await writeFile(
      h.store.path,
      JSON.stringify({
        providers: sources.map(([id, kind, baseUrl]) => ({
          id,
          kind,
          baseUrl,
          models: [],
          apiKey: id === "missing" ? undefined : `synthetic-${id}`,
        })),
      }),
    );
    await h.load();
    try {
      const read = async (id: string, refresh = true) =>
        (await callResult(h, "readBalance", { id, refresh })).result;
      expect(await read("d", false)).toEqual({ state: "query" });
      for (const [id, state] of [
        ["missing", "missing_key"],
        ["spoof", "unsupported"],
        ["custom", "unsupported"],
        ["cross", "unsupported"],
        ["router", "forbidden"],
        ["spend", "spend_only"],
      ]) {
        expect(await read(id!)).toEqual({ state });
      }
      expect(request).not.toHaveBeenCalled();
      const [one, two] = await Promise.all([read("d"), read("d")]);
      expect(one).toMatchObject({
        state: "available",
        partial: true,
        lines: [
          { currency: "USD", available: "0" },
          { currency: "CNY", available: "12.340000000000001" },
        ],
      });
      expect(two).toEqual(one);
      expect(await read("d")).toEqual(one);
      expect(request).toHaveBeenCalledTimes(1);
      for (const [id, currency] of [
        ["cn", "CNY"],
        ["global", "USD"],
      ]) {
        expect(await read(id!)).toMatchObject({
          state: "available",
          lines: [{ currency, available: "0.123456789123456789" }],
        });
      }
    } finally {
      await h.unload();
    }
  });

  it("fences an in-flight balance across credential replacement and expires historical values", async () => {
    const pending = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      })
      .mockResolvedValueOnce(
        Response.json({
          balance_infos: [
            { currency: "USD", total_balance: "0.01" },
            { currency: "CNY", total_balance: null },
          ],
        }),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const h = await harness({ fetch: request as unknown as typeof fetch });
    const save = (key: string) =>
      writeFile(
        h.store.path,
        JSON.stringify({
          providers: [
            {
              id: "d",
              kind: "deepseek",
              baseUrl: "https://api.deepseek.com",
              apiKey: key,
              models: [],
            },
          ],
        }),
      );
    const read = async (refresh = true) =>
      (await callResult(h, "readBalance", { id: "d", refresh })).result;
    await save("first");
    await h.load();
    try {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const old = read();
      await started.promise;
      await save("second");
      expect(await read()).toMatchObject({
        state: "available",
        failedCurrencies: ["CNY"],
        lines: [{ currency: "USD", available: "0.01" }],
      });
      pending.resolve(
        Response.json({
          balance_infos: [{ currency: "CNY", total_balance: "81" }],
        }),
      );
      expect(await old).toEqual({ state: "unavailable" });
      clock.mockReturnValue(now + 60_000);
      expect(await read()).toMatchObject({
        state: "unavailable",
        lines: [{ currency: "USD", available: "0.01" }],
      });
      clock.mockReturnValue(now + 1_810_000);
      expect(await read(false)).not.toHaveProperty("lines");
      expect(await read()).toMatchObject({ state: "forbidden" });
      expect(await read()).not.toHaveProperty("lines");
      expect(request).toHaveBeenCalledTimes(4);
    } finally {
      await h.unload();
    }
  });

  it("classifies the Host deadline without reporting zero", async () => {
    const timeout = AbortSignal.abort(
      new DOMException("deadline", "TimeoutError"),
    );
    const h = await harness({
      fetch: (async (_url: unknown, options?: RequestInit) => {
        options?.signal?.throwIfAborted();
        throw new Error("deadline expected");
      }) as unknown as typeof fetch,
    });
    await writeFile(
      h.store.path,
      JSON.stringify({
        providers: [
          {
            id: "d",
            kind: "deepseek",
            baseUrl: "https://api.deepseek.com",
            apiKey: "test",
            models: [],
          },
        ],
      }),
    );
    await h.load();
    try {
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout);
      const reply = await callResult(h, "readBalance", {
        id: "d",
        refresh: true,
      });
      expect(reply.result).toMatchObject({ state: "timeout" });
      expect(reply.result).not.toHaveProperty("lines");
    } finally {
      await h.unload();
    }
  });

  it.each([
    [401, "invalid_key"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [502, "unavailable"],
  ] as const)(
    "reports HTTP %i without changing connection health",
    async (status, state) => {
      const request = vi.fn(
        async () =>
          new Response(null, { status, headers: { "Retry-After": "72" } }),
      );
      const h = await harness({ fetch: request as unknown as typeof fetch });
      await writeFile(
        h.store.path,
        JSON.stringify({
          providers: [
            {
              id: "d",
              kind: "deepseek",
              baseUrl: "https://api.deepseek.com",
              apiKey: "fixture",
              models: [],
            },
          ],
        }),
      );
      await h.load();
      try {
        const reply = await callResult(h, "readBalance", {
          id: "d",
          refresh: true,
        });
        expect(reply.result).toMatchObject({ state });
        expect(reply.result).not.toHaveProperty("lines");
        if (status === 429)
          expect(
            Date.parse((reply.result as { retryAt: string }).retryAt),
          ).toBeGreaterThan(Date.now() + 70_000);
        await callResult(h, "readBalance", { id: "d", refresh: true });
        expect(request).toHaveBeenCalledTimes(1);
        expect(h.wire.snapshot("providers")?.sections.checks).toEqual({});
      } finally {
        await h.unload();
      }
    },
  );
});

describe("billing.readSourceSummaries", () => {
  it("bounds concurrent reads across visits, shares aliases and never returns a previous success on failure", async () => {
    const release = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    let phase = 0;
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const credential = new Headers(init?.headers).get("Authorization");
      peak = Math.max(peak, ++active);
      try {
        await release.promise;
        if (
          phase === 2 ||
          (phase === 1 && credential === "Bearer synthetic-0")
        ) {
          return new Response("private upstream body", {
            status: 429,
            headers: { "Retry-After": "120" },
          });
        }
        return Response.json({
          balance_infos: [{ currency: "CNY", total_balance: String(phase) }],
        });
      } finally {
        active--;
      }
    });
    const h = await harness({ fetch: request as unknown as typeof fetch });
    const providers = Array.from({ length: 7 }, (_, i) => ({
      id: String(i),
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: `synthetic-${i % 6}`,
      models: [],
    }));
    await writeFile(
      h.store.path,
      JSON.stringify({ providers: [...providers, provider("custom")] }),
    );
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.load();
    const batch = async () =>
      (
        (await h.wire.dispatch(
          {
            op: "call",
            target: "billing",
            action: "readSourceSummaries",
            args: {},
          },
          { reply: () => {} } as never,
        )) as { result: SourceSummaries }
      ).result.items;
    try {
      const one = batch();
      const two = batch();
      await until(() => active === 4);
      release.resolve();
      expect(await two).toEqual(await one);
      expect((await one)[0]?.value).toEqual({
        balance: { lines: [{ currency: "CNY", available: "0" }] },
      });
      expect((await one).at(-1)?.value).toBeNull();
      expect(peak).toBe(4);
      expect(request).toHaveBeenCalledTimes(6);
      phase = 1;
      const partial = await batch();
      expect(partial.map((i) => !!i.value)).toEqual([
        false,
        true,
        true,
        true,
        true,
        true,
        false,
        false,
      ]);
      expect(request).toHaveBeenCalledTimes(12);
      phase = 2;
      expect((await batch()).every((i) => i.value === null)).toBe(true);
      expect(request).toHaveBeenCalledTimes(17);
      expect((await batch()).every((i) => i.value === null)).toBe(true);
      expect(request).toHaveBeenCalledTimes(17);
      expect(warnings.mock.calls.flat().join(" ")).toMatch(
        /failure=rate_limited retry=\d{4}/,
      );
      expect(warnings.mock.calls.flat().join(" ")).not.toMatch(
        /synthetic|private upstream/,
      );
    } finally {
      release.resolve();
      await h.unload();
    }
  });
});

describe("billing.startSourceSummaries", () => {
  it("queues balances before quota within four slots and streams only to the caller", async () => {
    const releases = Array.from({ length: 5 }, () =>
      Promise.withResolvers<void>(),
    );
    const quota = Promise.withResolvers<void>();
    const started: string[] = [];
    const billing = (frames: ServerFrame[]) =>
      frames.filter(
        (frame): frame is EventFrame =>
          frame.type === "event" &&
          frame.target === "billing" &&
          frame.name.startsWith("source"),
      );
    const h = await harness({
      fetch: (async (_url, init) => {
        const id = new Headers(init?.headers).get("Authorization")!.slice(-1);
        started.push(id);
        await releases[Number(id)]!.promise;
        return Response.json({
          balance_infos: [{ currency: "USD", total_balance: id }],
        });
      }) as typeof fetch,
      streamQuotaSummaries: async (schedule, publish) => {
        await schedule(async () => {
          started.push("quota");
          await quota.promise;
          return { connectionId: "codex", windows: [] };
        });
        publish({
          source: "account",
          id: "codex",
          quotaRevision: "rev",
          value: { quota: { period: "weekly", usedPercent: 17 } },
        });
      },
    });
    await writeFile(
      h.store.path,
      JSON.stringify({
        providers: releases.map((_, id) => ({
          id: String(id),
          kind: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: `fixture-${id}`,
          models: [],
        })),
      }),
    );
    await h.load();
    const callerFrames: ServerFrame[] = [];
    const otherFrames: ServerFrame[] = [];
    const deps = { wire: h.wire, mounted: () => [] };
    const caller = createConnection(
      { id: 1, send: (frame) => callerFrames.push(frame) },
      deps,
    );
    const other = createConnection(
      { id: 2, send: (frame) => otherFrames.push(frame) },
      deps,
    );
    const events = () => billing(callerFrames);
    try {
      await other.handle(
        JSON.stringify({ op: "subscribe", target: "billing" }),
      );
      await caller.handle(
        JSON.stringify({
          op: "call",
          target: "billing",
          action: "startSourceSummaries",
          args: { visitId: "visit" },
          requestId: "start",
        }),
      );
      expect(callerFrames.at(-1)).toMatchObject({
        type: "reply",
        ok: true,
        requestId: "start",
      });
      await until(() => started.length === 4);
      expect(started).toEqual(["0", "1", "2", "3"]);

      releases[2]!.resolve();
      await until(() => events().length === 1);
      expect(events()[0]).toMatchObject({
        data: { id: "2", visitId: "visit" },
      });
      expect(started).toEqual(["0", "1", "2", "3", "4"]);

      releases[0]!.resolve();
      await until(() => started.includes("quota") && events().length === 2);
      quota.resolve();
      await until(() => events().length === 3);
      expect(events()[2]).toMatchObject({
        data: {
          id: "codex",
          visitId: "visit",
          value: { quota: { period: "weekly" } },
        },
      });

      for (const release of releases) release.resolve();
      await until(() => events().length === 7);
      expect(events().at(-1)).toMatchObject({
        name: "sourceSummariesDone",
        data: { visitId: "visit" },
      });
      expect(
        events()
          .slice(0, -1)
          .map((item) => (item.data as SourceSummaryEvent).id)
          .sort(),
      ).toEqual(["0", "1", "2", "3", "4", "codex"]);
      expect(billing(otherFrames)).toEqual([]);
      expect(h.frames.filter(({ frame }) => billing([frame]).length)).toEqual(
        [],
      );
    } finally {
      for (const release of releases) release.resolve();
      quota.resolve();
      caller.close();
      other.close();
      await h.unload();
    }
  });
});
