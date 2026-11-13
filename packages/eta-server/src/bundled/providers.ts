/**
 * The `providers` plugin: `~/.eta/config.json` on the wire.
 *
 * It owns a target called `providers` with one section — the config as a client sees it (keys
 * become booleans, headers stay) plus the revision it was read at — and the actions that change
 * it. Every write carries the revision it read, so a settings page and an editor cannot silently
 * overwrite each other; a refused write comes back as `config_changed` and the client re-reads.
 *
 * The file is watched, and a change made *outside* this process pushes the new state to whoever
 * is subscribed — and tells the host through `onModelsChanged`, which is what makes a provider
 * added by hand (or by the settings page) generatable without a restart. The config itself is
 * read per turn by whoever needs it; what a restart used to be required for is the model layer,
 * and that is rebuilt here.
 *
 * Like every bundled plugin, it is only mounted by default: unmount it and `providers.*` becomes
 * "unknown op" while the rest of the server keeps running (sessions then run on whatever models
 * the host injected, or fail honestly with `model_unavailable`).
 */
import type {
  ProviderArgs,
  ProviderCheck,
  ProviderHeaders,
  ProvidersView,
} from "@eta/client-contracts";
import type { DiscoveryResult } from "../providers/discovery";
import type { ProviderConfigStore } from "../providers/store";
import type { WireService } from "../wire-service";
import { Service } from "cordis";
import { providerDefinitionForKind } from "../providers/catalog";
import {
  checkConnection,
  checkOf,
  listProviderModels,
} from "../providers/discovery";
import { ProviderLogos } from "../providers/logos";

export { PROVIDER_ACTIONS } from "@eta/client-contracts";

export interface ProvidersPluginOptions {
  store: ProviderConfigStore;
  /**
   * The HTTP client discovery uses. A test supplies one; production uses `fetch`, which is what
   * makes the refresh path the same client the requests go through.
   */
  fetch?: typeof fetch | undefined;
  /** Diagnostics. */
  warn?: ((message: string) => void) | undefined;
  /**
   * What to tell the host when the config moved, however it moved — written by a settings page
   * through this plugin, or by an editor beside it. The host rebuilds the model layer from the
   * file; this plugin does not read the keys back, so it hands over no view and the host reads
   * what it needs.
   *
   * Without this the config's hot reload is half a reload: the settings page would show a
   * provider the sessions cannot generate through, and the failure would land much later as
   * `model_unavailable`.
   */
  onModelsChanged?: (() => void | Promise<void>) | undefined;
}

/**
 * The config, and the last check of each provider, as two state sections. The config's revision
 * lives *inside* its section rather than in the section's revision: it is the config file's
 * revision (what a write must carry), not a signature of the projection, and the two would be
 * confused the moment they shared a name.
 */
function sections(
  view: ProvidersView,
  checks: ReadonlyMap<string, ProviderCheck>,
  checksRevision: number,
): {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
} {
  return {
    sections: { config: view, checks: Object.fromEntries(checks) },
    // The section moves exactly when the file's revision does, which is what makes a push
    // after a change carry the new config and a push after nothing carry none.
    revisions: { config: view.revision, checks: String(checksRevision) },
  };
}

/** The connection a provider is reached through: what a check is a check of. */
function connectionOf(
  provider:
    | {
        kind?: string;
        baseUrl: string;
        apiKey?: string;
        headers?: ProviderHeaders;
      }
    | undefined,
): string {
  return JSON.stringify([
    provider?.kind,
    provider?.baseUrl,
    provider?.apiKey,
    provider?.headers,
  ]);
}

/**
 * A failed listing as the error a client is told. Never echo URLs, keys, headers or upstream
 * error bodies: only the network error may contain request values, and those are redacted.
 */
function discoveryError(
  discovered: DiscoveryResult,
  secrets: readonly (string | null | undefined)[],
): Error {
  if (discovered.failure === "network") {
    let message = discovered.error!;
    for (const value of secrets) {
      if (value) message = message.replaceAll(value, "[redacted]");
    }
    return new Error(`discovery_network: ${message}`);
  }
  return new Error(
    discovered.failure === "http"
      ? `discovery_http_${discovered.status}`
      : `discovery_${discovered.failure}`,
  );
}

export function providersPlugin(options: ProvidersPluginOptions) {
  return {
    name: "providers",
    inject: ["wire"],
    apply(ctx: unknown): unknown {
      const context = ctx as {
        wire: WireService;
        effect: (execute: () => () => unknown) => unknown;
      };
      const wire = context.wire;
      return context.effect(() => {
        // What the section shows: the last read, plus the revision a write must carry.
        // Kept as a box because the state projector must be synchronous while reading the
        // file is not — the read happens on every write and on every watch tick.
        let latest: ProvidersView | undefined;
        // The last check of each provider, since this host started. Only a save that changes how
        // a provider is reached, or a delete, forgets one; nothing re-checks by itself.
        const checks = new Map<string, ProviderCheck>();
        const logos = new ProviderLogos(options.fetch);
        let checksRevision = 0;
        const record = (id: string, check: ProviderCheck | undefined): void => {
          if (check === undefined) {
            if (!checks.delete(id)) return;
          } else checks.set(id, check);
          checksRevision += 1;
        };
        const refresh = async (): Promise<ProvidersView> => {
          const view = await options.store.view();
          latest = view;
          return view;
        };
        void refresh().then(
          () => wire.pushNow("providers"),
          (error: unknown) =>
            options.warn?.(`[eta-server] providers: ${String(error)}`),
        );

        const registrations: (() => void)[] = [
          wire.stateOf("providers", {
            // Eager: a settings page that has to ask before it can draw is a settings page
            // that flickers.
            eager: true,
            // Before the first read lands there is no config to show, and saying "no
            // providers, revision ''" would be a fabrication a client could act on — it
            // would send that revision back and be refused. An empty snapshot says the
            // honest thing: nothing is known yet, and the push after the read fills it in.
            project: () =>
              latest === undefined
                ? { sections: {}, revisions: {} }
                : sections(latest, checks, checksRevision),
          }),
          wire.handle("providers", "save", async (call) => {
            const args = (call.args ?? {}) as Partial<ProviderArgs["save"]>;
            if (args.provider === undefined)
              throw new Error("providers.save needs a provider");
            const id = args.provider.id;
            const was = (await options.store.read()).config.providers?.find(
              (entry) => entry.id === id,
            );
            const view = await options.store.save({
              revision: args.revision,
              provider: args.provider,
            });
            const now = (await options.store.read()).config.providers?.find(
              (entry) => entry.id === id,
            );
            // A check is of the connection: a new key or address makes the last one say nothing.
            if (connectionOf(was) !== connectionOf(now)) record(id, undefined);
            latest = view;
            wire.pushNow("providers");
            return { result: { revision: view.revision } };
          }),
          wire.handle("providers", "delete", async (call) => {
            const args = (call.args ?? {}) as Partial<ProviderArgs["delete"]>;
            if (typeof args.id !== "string")
              throw new Error("providers.delete needs an id");
            const view = await options.store.delete(args.id, args.revision);
            record(args.id, undefined);
            latest = view;
            wire.pushNow("providers");
            return { result: { revision: view.revision } };
          }),
          wire.handle("providers", "setDefault", async (call) => {
            const args = (call.args ?? {}) as Partial<
              ProviderArgs["setDefault"]
            >;
            const view = await options.store.setDefault(
              args.defaultModel ?? null,
              args.revision,
            );
            latest = view;
            wire.pushNow("providers");
            return {
              result: {
                revision: view.revision,
                defaultModel: view.defaultModel ?? null,
              },
            };
          }),
          wire.handle("providers", "setNetwork", async (call) => {
            const args = (call.args ?? {}) as Partial<
              ProviderArgs["setNetwork"]
            >;
            if (typeof args.mode !== "string")
              throw new Error("providers.setNetwork needs a mode");
            const view = await options.store.setNetwork(
              {
                mode: args.mode,
                ...(args.proxyUrl === undefined
                  ? {}
                  : { proxyUrl: args.proxyUrl }),
                ...(args.noProxy === undefined
                  ? {}
                  : { noProxy: args.noProxy }),
              },
              args.revision,
            );
            latest = view;
            wire.pushNow("providers");
            return {
              result: {
                revision: view.revision,
                network: view.network ?? null,
              },
            };
          }),
          wire.handle("providers", "discover", async (call) => {
            const args = (call.args ?? {}) as Partial<ProviderArgs["discover"]>;
            // Never echo URLs, keys, headers or upstream error bodies.
            let url: URL;
            try {
              url = new URL(args.baseUrl?.trim() ?? "");
            } catch {
              throw new Error("discovery_invalid_connection");
            }
            if (
              !["http:", "https:"].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.search ||
              url.hash
            )
              throw new Error("discovery_invalid_connection");
            const baseUrl = url.href.replace(/\/+$/, "");
            if (
              typeof args.kind !== "string" ||
              (args.apiKey !== undefined &&
                args.apiKey !== null &&
                typeof args.apiKey !== "string")
            )
              throw new Error("discovery_invalid_connection");
            const { config, revision } = await options.store.read();
            const existing =
              args.id === undefined
                ? undefined
                : config.providers?.find((entry) => entry.id === args.id);
            if (
              args.id !== undefined &&
              (existing === undefined || args.revision !== revision)
            )
              throw new Error("config_changed");
            const signal = AbortSignal.timeout(45_000);
            const apiKey =
              args.apiKey === null
                ? undefined
                : (args.apiKey?.trim() ?? existing?.apiKey);
            const discovered = await listProviderModels({
              reference: { kind: args.kind, baseUrl },
              apiKey,
              headers: args.headers ?? undefined,
              signal,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            });
            if (signal.aborted) throw new Error("discovery_timeout");
            if (discovered.failure !== undefined)
              throw discoveryError(discovered, [
                apiKey,
                ...Object.values(args.headers ?? {}),
              ]);
            return {
              result: {
                models: discovered.models,
                ...(discovered.unsupported === undefined
                  ? {}
                  : { unsupported: discovered.unsupported }),
              },
            };
          }),
          wire.handle("providers", "refresh", async (call) => {
            const { id } = (call.args ?? {}) as Partial<
              ProviderArgs["refresh"]
            >;
            if (id === undefined)
              throw new Error("providers.refresh needs an id");
            const { config } = await options.store.read();
            const provider = config.providers?.find((entry) => entry.id === id);
            if (provider === undefined)
              throw new Error(`no such provider: ${id}`);
            const signal = AbortSignal.timeout(45_000);
            const kind = provider.kind ?? "openai-compatible";
            const discovered = await listProviderModels({
              reference: { kind, baseUrl: provider.baseUrl },
              apiKey: provider.apiKey,
              headers: provider.headers,
              signal,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            });
            const at = new Date().toISOString();
            // A list fetched with the saved key is a check of it too.
            if (discovered.failure !== undefined) {
              record(id, {
                ...(signal.aborted
                  ? { state: "unreachable", error: "discovery_timeout" }
                  : checkOf(discovered)),
                checkedAt: at,
              });
              wire.pushNow("providers");
              if (signal.aborted) throw new Error("discovery_timeout");
              throw discoveryError(discovered, [
                provider.apiKey,
                ...Object.values(provider.headers ?? {}),
              ]);
            }
            record(id, { state: "ok", checkedAt: at });
            // A catalog that lists everything the provider serves (models.dev) is followed both
            // ways: the facts come in, and models it stopped listing are marked, not dropped.
            const updated = await options.store.updateModels(
              id,
              discovered.models,
              at,
              {
                delist:
                  providerDefinitionForKind(kind)?.discovery.adapter ===
                  "models-dev",
              },
            );
            latest = updated?.view ?? (await refresh());
            wire.pushNow("providers");
            return {
              result: {
                revision: latest.revision,
                models: discovered.models,
                ...(discovered.unsupported === undefined
                  ? {}
                  : { unsupported: discovered.unsupported }),
                ...(updated === undefined || updated.delisted.length === 0
                  ? {}
                  : { delisted: updated.delisted }),
              },
            };
          }),
          wire.handle("providers", "logos", async (call) => {
            const { sources } = (call.args ?? {}) as Partial<
              ProviderArgs["logos"]
            >;
            return {
              result: await logos.logos(Array.isArray(sources) ? sources : []),
            };
          }),
          wire.handle("providers", "check", async (call) => {
            const { id } = (call.args ?? {}) as Partial<ProviderArgs["check"]>;
            const { config } = await options.store.read();
            const targets = (config.providers ?? []).filter(
              (entry) => id === undefined || entry.id === id,
            );
            if (id !== undefined && targets.length === 0)
              throw new Error(`no such provider: ${id}`);
            const answered: Record<string, ProviderCheck> = {};
            await Promise.all(
              targets.map(async (provider) => {
                const kind = provider.kind ?? "openai-compatible";
                const definition = providerDefinitionForKind(kind);
                // A key the provider cannot run without is missing, which the config already
                // says; a subscription signs in elsewhere. Neither has anything to probe.
                if (
                  definition?.auth.adapter === "codex-oauth" ||
                  (definition?.auth.required === true &&
                    (provider.apiKey ?? "").length === 0)
                ) {
                  record(provider.id, undefined);
                  return;
                }
                const signal = AbortSignal.timeout(30_000);
                const check: ProviderCheck = {
                  ...(await checkConnection({
                    reference: { kind, baseUrl: provider.baseUrl },
                    apiKey: provider.apiKey,
                    headers: provider.headers,
                    signal,
                    ...(options.fetch === undefined
                      ? {}
                      : { fetch: options.fetch }),
                  })),
                  checkedAt: new Date().toISOString(),
                };
                record(provider.id, check);
                answered[provider.id] = check;
              }),
            );
            wire.pushNow("providers");
            return { result: { checks: answered } };
          }),
          wire.handle("providers", "reload", async () => {
            // A client asking "did anything change?" — the answer is the state, and the
            // revision in it is what says whether anything did. When it did, the host hears
            // about it here too: a reload that re-renders the page but leaves the sessions on
            // the old provider answers the question with half the truth.
            const before = latest?.revision;
            const view = await refresh();
            wire.pushNow("providers");
            if (before !== undefined && before !== view.revision)
              await options.onModelsChanged?.();
            return { result: { revision: view.revision } };
          }),
        ];

        // A change made outside this process (an editor, another tool) reaches subscribers
        // the same way a change made through an action does: the state moved. Starting the
        // watch without saying who to tell is a watch nobody hears — which is what this
        // was until the test that writes the file directly failed.
        //
        // The host is told through the same door: the model layer is built from this config, so
        // a hand-edited provider becomes generatable as soon as it becomes visible. The store
        // notifies for its own writes as well, so a provider saved from the settings page takes
        // the same path.
        options.store.watch((view) => {
          latest = view;
          wire.pushNow("providers");
          void Promise.resolve(options.onModelsChanged?.()).catch(
            (error: unknown) =>
              options.warn?.(
                `[eta-server] providers: model layer not rebuilt: ${String(error)}`,
              ),
          );
        });
        const stopWatching = (): void => options.store.stop();
        return () => {
          for (const off of registrations.splice(0)) off();
          stopWatching();
        };
      });
    },
  };
}

/** The service shape other plugins can inject (`ctx.providers`) — the store, by name. */
export class ProvidersService extends Service {
  static readonly provide = "providers";

  readonly store: ProviderConfigStore;

  constructor(
    ctx: ConstructorParameters<typeof Service>[0],
    store: ProviderConfigStore,
  ) {
    super(ctx, "providers");
    this.store = store;
  }
}
