/**
 * The bundled `providers` plugin (S19).
 *
 * The plugin's job is small and specific: put `~/.eta/config.json` on the wire as a state target
 * with actions that carry a revision, and push when the file changes underneath. These tests
 * load it the way a loader would and check only through the pipe's doors.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame, StateSnapshot } from "@eta/client-wire-proto";
import type { ProvidersView } from "@eta/client-contracts";
import { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_ACTIONS, providersPlugin } from "../src/bundled/providers";
import { ProviderConfigStore, revisionOf } from "../src/providers/store";
import { WireService } from "../src/wire-service";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

interface Harness {
  ctx: Context;
  wire: WireService;
  frames: { target?: string; frame: ServerFrame }[];
  store: ProviderConfigStore;
  load(): Promise<void>;
  unload(): Promise<void>;
  call(action: string, args?: unknown): Promise<unknown>;
  config(): ProvidersView | undefined;
}

async function harness(
  options: { watchIntervalMs?: number } = {},
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
        providersPlugin({ store }) as never,
        undefined as never,
      );
      await fiber;
      unload = async () => {
        await (fiber as unknown as { dispose(): Promise<void> }).dispose();
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
    await (fiber as unknown as { dispose(): Promise<void> }).dispose();
  });
});

describe("the codex login, over the wire", () => {
  it("starts a login, reports the prompt it is waiting on, and answers it", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-codex-wire-"));
    roots.push(root);
    const ctx = new Context();
    const wire = new WireService(ctx);
    const store = new ProviderConfigStore({ path: join(root, "config.json") });
    const plugin = providersPlugin({ store, loginTimeoutMs: 60_000 });
    // The flow itself is pi-ai's and needs a network; what this test drives is the state machine
    // a client talks to. Starting a login does not block on the flow, so nothing here waits for
    // one — the attempt is cancelled before it can do anything.
    ctx.plugin(plugin as never, undefined as never);
    await until(() => wire.descriptors().length > 0);

    const started = (await wire.dispatch(
      { op: "call", target: "providers", action: "codexLogin", args: {} },
      {
        reply: () => undefined,
      } as never,
    )) as { result: { login: { id: string; status: string; method: string } } };
    expect(started.result.login.status).toBe("pending");
    expect(started.result.login.method).toBe("browser");
    // The public state carries no token — it is rendered in a UI and sent over the wire.
    expect(JSON.stringify(started.result.login)).not.toContain("token");

    // A status for an id nobody knows is `failed`, not a lie about pending.
    const unknown = (await wire.dispatch(
      {
        op: "call",
        target: "providers",
        action: "codexStatus",
        args: { id: "ghost" },
      },
      {
        reply: () => undefined,
      } as never,
    )) as { result: { login: { status: string } } };
    expect(unknown.result.login.status).toBe("failed");

    // Cancelling settles it as cancelled, and the status says so afterwards.
    await wire.dispatch(
      {
        op: "call",
        target: "providers",
        action: "codexCancel",
        args: { id: started.result.login.id },
      },
      {
        reply: () => undefined,
      } as never,
    );
    const after = (await wire.dispatch(
      {
        op: "call",
        target: "providers",
        action: "codexStatus",
        args: { id: started.result.login.id },
      },
      { reply: () => undefined } as never,
    )) as { result: { login: { status: string } } };
    expect(after.result.login.status).toBe("cancelled");

    // An answer for a prompt nobody is waiting on is refused by name, not silently accepted.
    await expect(
      wire.dispatch(
        {
          op: "call",
          target: "providers",
          action: "codexAnswer",
          args: { id: started.result.login.id, promptId: "x", value: "1" },
        },
        { reply: () => undefined } as never,
      ),
    ).rejects.toThrow(/not waiting/);
    await expect(
      wire.dispatch(
        {
          op: "call",
          target: "providers",
          action: "codexLogin",
          args: { method: "carrier-pigeon" },
        },
        {
          reply: () => undefined,
        } as never,
      ),
    ).rejects.toThrow(/browser or device_code/);
  });
});
