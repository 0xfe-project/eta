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
import type { ProviderArgs, ProvidersView } from "@eta/client-contracts";
import type { ProviderConfigStore } from "../providers/store";
import type { WireService } from "../wire-service";
import { Service } from "cordis";
import { discoverModels } from "../providers/discovery";
import { publicModelMetadata } from "../providers/metadata";

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
 * The config as one state section. The revision lives *inside* the section rather than in the
 * section's revision: it is the config file's revision (what a write must carry), not a
 * signature of the projection, and the two would be confused the moment they shared a name.
 */
function section(view: ProvidersView): {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
} {
  return {
    sections: { config: view },
    // The section moves exactly when the file's revision does, which is what makes a push
    // after a change carry the new config and a push after nothing carry none.
    revisions: { config: view.revision },
  };
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
                : section(latest),
          }),
          wire.handle("providers", "save", async (call) => {
            const args = (call.args ?? {}) as Partial<ProviderArgs["save"]>;
            if (args.provider === undefined)
              throw new Error("providers.save needs a provider");
            const view = await options.store.save({
              revision: args.revision,
              provider: args.provider,
            });
            latest = view;
            wire.pushNow("providers");
            return { result: { revision: view.revision } };
          }),
          wire.handle("providers", "delete", async (call) => {
            const args = (call.args ?? {}) as Partial<ProviderArgs["delete"]>;
            if (typeof args.id !== "string")
              throw new Error("providers.delete needs an id");
            const view = await options.store.delete(args.id, args.revision);
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
          wire.handle("providers", "metadata", async (call) => ({
            result: await publicModelMetadata(
              call.args as ProviderArgs["metadata"],
              options.fetch,
            ),
          })),
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
            const discovered = await discoverModels({
              reference: { kind: args.kind, baseUrl },
              apiKey,
              headers: args.headers ?? undefined,
              signal,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            });
            if (signal.aborted) throw new Error("discovery_timeout");
            if (discovered.failure === "network") {
              // Only the network error may contain request values. Keep the diagnostic, redact credentials.
              let message = discovered.error!;
              for (const value of [
                apiKey,
                ...Object.values(args.headers ?? {}),
              ]) {
                if (value) message = message.replaceAll(value, "[redacted]");
              }
              throw new Error(`discovery_network: ${message}`);
            }
            if (discovered.failure !== undefined)
              throw new Error(
                discovered.failure === "http"
                  ? `discovery_http_${discovered.status}`
                  : `discovery_${discovered.failure}`,
              );
            return { result: { models: discovered.models } };
          }),
          wire.handle("providers", "refresh", async (call) => {
            const { id } = (call.args ?? {}) as Partial<
              ProviderArgs["refresh"]
            >;
            if (id === undefined)
              throw new Error("providers.refresh needs an id");
            const view = await options.store.view();
            const provider = (view.providers ?? []).find(
              (entry) => entry.id === id,
            );
            if (provider === undefined)
              throw new Error(`no such provider: ${id}`);
            const discovered = await discoverModels({
              reference: { kind: provider.kind, baseUrl: provider.baseUrl },
              headers: provider.headers,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            });
            if (discovered.error !== undefined)
              throw new Error(discovered.error);
            // The refresh writes what it found, at the revision it read: a config that
            // changed while the request was in flight is refused rather than overwritten
            // with a list that is already stale.
            const updated = await options.store.markRefreshed(
              id,
              discovered.models,
              new Date().toISOString(),
            );
            latest = updated ?? (await refresh());
            wire.pushNow("providers");
            return {
              result: {
                revision: latest.revision,
                models: discovered.models.length,
              },
            };
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
