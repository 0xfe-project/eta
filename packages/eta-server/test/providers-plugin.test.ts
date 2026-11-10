/**
 * The bundled `providers` plugin (S19).
 *
 * The plugin's job is small and specific: put `~/.eta/config.json` on the wire as a state target
 * with actions that carry a revision, and push when the file changes underneath. These tests
 * load it the way a loader would and check only through the pipe's doors.
 */

import type { ProvidersView } from "@eta/client-contracts";
import type { ServerFrame, StateSnapshot } from "@eta/client-wire-proto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_ACTIONS, providersPlugin } from "../src/bundled/providers";
import { ProviderConfigStore, revisionOf } from "../src/providers/store";
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
  options: { watchIntervalMs?: number; fetch?: typeof fetch } = {},
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
      [...PROVIDER_ACTIONS].map((action) => `providers.${action}`).sort(),
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

  it("sets the default, deletes a provider, and refuses a default nobody serves", async () => {
    const h = await harness();
    await h.load();
    await until(() => h.config() !== undefined);
    await callResult(h, "save", {
      revision: revisionOf(""),
      provider: provider("a"),
    });
    const revision = h.config()?.revision;

    const bad = await callResult(h, "setDefault", {
      revision,
      defaultModel: "a:nope",
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("invalid_default_model");

    const good = await callResult(h, "setDefault", {
      revision,
      defaultModel: "a:m1",
    });
    expect(good.ok).toBe(true);
    expect(h.config()?.defaultModel).toBe("a:m1");

    const removed = await callResult(h, "delete", {
      revision: h.config()?.revision,
      id: "a",
    });
    expect(removed.ok).toBe(true);
    expect(h.config()?.providers).toEqual([]);
    expect(h.config()?.defaultModel).toBeUndefined();
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
  it("asks the endpoint and writes down what it found", async () => {
    const calls: string[] = [];
    const send = (async (url: string) => {
      calls.push(String(url));
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

    await wire.dispatch(
      {
        op: "call",
        target: "providers",
        action: "refresh",
        args: { id: "local" },
      },
      {
        reply: () => undefined,
      } as never,
    );
    expect(calls).toEqual(["https://local.test/v1/models"]);
    const refreshed = wire.snapshot("providers")?.sections
      .config as ProvidersView;
    expect(refreshed.providers[0]?.models.map((model) => model.id)).toContain(
      "discovered",
    );
    expect(refreshed.providers[0]?.lastRefreshedAt).toBeDefined();

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

describe("subscription login belongs to the native llm plugin", () => {
  it.each(["codexLogin", "codexAnswer", "codexStatus", "codexCancel"])(
    "does not register providers.%s",
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), "eta-provider-no-login-"));
      roots.push(root);
      const ctx = new Context();
      const wire = new WireService(ctx);
      const store = new ProviderConfigStore({
        path: join(root, "config.json"),
      });
      const fiber = ctx.plugin(
        providersPlugin({ store }) as never,
        undefined as never,
      );
      await until(() => wire.descriptors().length > 0);
      await expect(
        wire.dispatch({ op: "call", target: "providers", action, args: {} }, {
          reply: () => undefined,
        } as never),
      ).rejects.toThrow(`unknown op: providers.${action}`);
      await (fiber as unknown as { dispose: () => Promise<void> }).dispose();
    },
  );
});

describe("unsaved model discovery", () => {
  it("uses draft connection values without requiring an id or models, writing a file, pushing state or rebuilding runtime", async () => {
    let requested: { url: string; headers: Headers } | undefined;
    const send = (async (
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
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
      fetch: (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
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

describe("public metadata preview", () => {
  it("does not read/send stored secrets, publish state or write config on success/failure; only save persists", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
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
      }),
    );
    const h = await harness({ fetch: send });
    await h.load();
    await until(() => h.config() !== undefined);
    await callResult(h, "save", {
      revision: h.config()?.revision,
      provider: {
        ...provider("official"),
        baseUrl: "https://api.openai.com/v1",
        apiKey: "saved-secret",
        headers: { Authorization: "custom-secret" },
        models: [{ id: "exact" }],
      },
    });
    const before = await readFile(h.store.path, "utf8");
    const view = h.config();
    h.frames.length = 0;
    const args = {
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      modelIds: ["exact"],
    };
    const result = await callResult(h, "metadata", args);
    expect(result).toEqual({
      ok: true,
      result: {
        models: [{ id: "exact", name: "Public Exact", contextWindow: 32000 }],
      },
    });
    expect(send.mock.calls[0]?.[1]?.headers).toEqual({
      Accept: "application/json",
    });
    expect(h.config()).toEqual(view);
    expect(h.frames).toEqual([]);
    expect(await readFile(h.store.path, "utf8")).toBe(before);
    send.mockRejectedValueOnce(new Error("public network offline"));
    expect(await callResult(h, "metadata", args)).toEqual({
      ok: false,
      error: "public network offline",
    });
    expect(await readFile(h.store.path, "utf8")).toBe(before);
    await callResult(h, "save", {
      revision: view?.revision,
      provider: {
        ...provider("official"),
        models: (result.result as { models: unknown[] }).models,
      },
    });
    expect(
      JSON.parse(await readFile(h.store.path, "utf8")).providers[0].models,
    ).toEqual((result.result as { models: unknown[] }).models);
    await h.unload();
  });
});
