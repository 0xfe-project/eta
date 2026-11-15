/**
 * The providers config store: `~/.eta/config.json`, read and written with a revision.
 *
 * The file is the source of truth, and it is a *shared* file — a user edits it in an editor, a
 * settings page edits it over the wire, and the two can be doing so at the same moment. Three
 * rules make that safe:
 *
 * - **The revision is the content's hash.** A write carries the revision it read; if the file no
 *   longer hashes to it, the write is refused (`config_changed`) instead of silently reverting
 *   whatever the other editor did. That is the whole of the concurrency story, and it is enough
 *   because the alternative — merging two edits to a JSON document — has no right answer.
 * - **Writes are serialised and atomic.** One at a time through a tail promise, into a temp file
 *   with `0o600`, then renamed. A reader never sees a half-written file, and the API key never
 *   exists with looser permissions than the final file.
 * - **A broken file is never overwritten.** Reading a config that does not parse is an error
 *   (`invalid_saved_config`), not an empty config: the alternative is that the first write after
 *   a typo deletes everything else the user had.
 *
 * A missing file is a legitimate state and means "no providers configured" — the server runs,
 * and the failure is the honest one (`model_unavailable`) when a session asks for a model.
 */

import type { ProvidersView } from "@eta/client-contracts";
import type { EtaConfig, EtaProviderConfig } from "./config-types";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { providerSummary } from "./config-types";

/** A caller's mistake, with the name the client shows. */
export class ProviderConfigError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
    this.name = "ProviderConfigError";
  }
}

/** The default location: the same `~/.eta/config.json` the desktop app reads. */
export function defaultConfigPath(home: string): string {
  return join(home, ".eta", "config.json");
}

export interface ProviderConfigStoreOptions {
  path: string;
  /** Diagnostics: a config that will not parse, a watcher that could not start. */
  warn?: ((message: string) => void) | undefined;
  /**
   * How often to check the file for external changes, in milliseconds. Zero disables watching
   * (a test that drives changes itself does not want a timer in the way).
   */
  watchIntervalMs?: number | undefined;
}

/** The revision a config's bytes hash to. */
export function revisionOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class ProviderConfigStore {
  readonly path: string;
  /** Everyone who cares that the config moved (see `watch`). */
  private readonly listeners = new Set<(view: ProvidersView) => void>();
  private readonly warn: (message: string) => void;
  private readonly watchIntervalMs: number;
  private tail: Promise<unknown> = Promise.resolve();
  private watcher: ReturnType<typeof setInterval> | undefined;
  private lastRevision: string | undefined;

  constructor(options: ProviderConfigStoreOptions) {
    this.path = options.path;
    this.warn = options.warn ?? (() => undefined);
    this.watchIntervalMs = options.watchIntervalMs ?? 0;
  }

  /**
   * Start noticing changes made outside this process (an editor, another tool). The callback
   * is per watch, because "who cares" is the caller's business — the store only knows that the
   * bytes changed.
   *
   * More than one listener may register, and each hears every change: a file written by an
   * editor, and a file the store itself just wrote through `save`/`delete`/`markRefreshed`. The
   * server needs the second kind as much as the first — the model layer a session generates
   * through is built from this config, and a provider added from the settings page is of no use
   * until that layer knows about it. `stop` drops every listener, which is what lets the plugin
   * that owns this store decide the lifetime of all of them at once.
   */
  watch(onChange?: (view: ProvidersView) => void): void {
    if (onChange !== undefined) this.listeners.add(onChange);
    if (this.watchIntervalMs <= 0 || this.watcher !== undefined) return;
    this.watcher = setInterval(() => {
      void this.poll().catch((error: unknown) =>
        this.warn(`[eta-server] config watch: ${String(error)}`),
      );
    }, this.watchIntervalMs);
    // A watcher is not a reason to keep the process alive.
    (this.watcher as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.listeners.clear();
    if (this.watcher === undefined) return;
    clearInterval(this.watcher);
    this.watcher = undefined;
  }

  /**
   * Tell every listener the config moved. Not awaited: a listener that rebuilds the model layer
   * loads provider code lazily, and a settings page's reply must not wait on that. A listener
   * that throws (or rejects) is reported and does not stop the others, and does not undo the
   * write that caused the notice — the file is still the source of truth.
   */
  private notify(view: ProvidersView): void {
    for (const listener of [...this.listeners]) {
      try {
        void Promise.resolve(listener(view)).catch((error: unknown) =>
          this.warn(`[eta-server] config listener: ${String(error)}`),
        );
      } catch (error) {
        this.warn(`[eta-server] config listener: ${String(error)}`);
      }
    }
  }

  /** What a settings page renders: providers, network, and the revision. */
  async view(): Promise<ProvidersView> {
    const { config, revision } = await this.read();
    return publicView(config, revision);
  }

  /**
   * Add or replace one provider. `apiKey: null` clears the saved key, omitting it keeps
   * whatever is there — a settings form that was not touched must not erase a secret it was
   * never shown.
   */
  async save(input: {
    revision: unknown;
    provider: {
      id: string;
      name?: string;
      kind?: EtaProviderConfig["kind"];
      baseUrl: string;
      apiKey?: string | null;
      headers?: EtaProviderConfig["headers"] | null;
      models: EtaProviderConfig["models"];
    };
  }): Promise<ProvidersView> {
    return await this.mutate(input.revision, (config) => {
      const providers = config.providers ?? [];
      const index = providers.findIndex(
        (provider) => provider.id === input.provider.id,
      );
      const previous = index < 0 ? undefined : providers[index];
      const next = normalizeProvider(input.provider, previous);
      if (next.models.length === 0)
        throw new ProviderConfigError("models_required");
      if (index < 0) providers.push(next);
      else providers[index] = next;
      config.providers = providers;
    });
  }

  async delete(id: string, revision: unknown): Promise<ProvidersView> {
    return await this.mutate(revision, (config) => {
      config.providers = (config.providers ?? []).filter(
        (provider) => provider.id !== id,
      );
    });
  }

  async setNetwork(
    input: { mode: string; proxyUrl?: string; noProxy?: string },
    revision: unknown,
  ): Promise<ProvidersView> {
    return await this.mutate(revision, (config) => {
      if (
        input.mode !== "system" &&
        input.mode !== "manual" &&
        input.mode !== "direct"
      ) {
        throw new ProviderConfigError("invalid_config");
      }
      const proxyUrl = normalizeProxyUrl(input.proxyUrl);
      const noProxy = input.noProxy?.trim() ?? "";
      config.network = {
        mode: input.mode,
        ...(proxyUrl === undefined ? {} : { proxyUrl }),
        ...(input.mode === "manual" && noProxy.length > 0 ? { noProxy } : {}),
      };
    });
  }

  /**
   * Bring a provider's configured models up to date with what its list says now:
   *
   * - nothing is added: a model is in the config because someone turned it on, and one they
   *   turned off must not come back by itself;
   * - a provider's own list only fills the gaps of a listed model: what the file already says
   *   about it (perhaps typed by hand) stays;
   * - with `delist`, the list is a catalog that speaks for everything the provider serves
   *   (models.dev): its facts win, keeping the person's own choices (default thinking,
   *   overrides), and a model it no longer lists is kept and marked `delisted`, never dropped —
   *   an agent may be using it, and a model that vanished from the config would fail somewhere
   *   far from the reason.
   *
   * Answers with the ids that are delisted now.
   */
  async updateModels(
    id: string,
    listed: EtaProviderConfig["models"],
    at: string,
    options: { delist: boolean },
  ): Promise<{ view: ProvidersView; delisted: string[] } | undefined> {
    const current = await this.view();
    if (!current.providers.some((provider) => provider.id === id))
      return undefined;
    const delisted: string[] = [];
    const view = await this.mutate(current.revision, (config) => {
      const provider = (config.providers ?? []).find(
        (entry) => entry.id === id,
      );
      if (provider === undefined) return;
      const fresh = new Map(listed.map((model) => [model.id, model]));
      provider.models = provider.models.map((model) => {
        const found = fresh.get(model.id);
        if (found === undefined) {
          if (!options.delist) return model;
          delisted.push(model.id);
          return { ...model, delisted: true };
        }
        const { delisted: _gone, ...kept } = model;
        if (!options.delist) return { ...found, ...kept };
        return {
          ...kept,
          ...found,
          ...(model.defaultThinking === undefined
            ? {}
            : { defaultThinking: model.defaultThinking }),
          ...(model.overrides === undefined
            ? {}
            : { overrides: model.overrides }),
        };
      });
      provider.lastRefreshedAt = at;
    });
    return { view, delisted };
  }

  /** The parsed config, or the honest error. */
  async read(): Promise<{ config: EtaConfig; revision: string }> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ProviderConfigError("read_failed", 500);
      // No file: a legitimate state, and the empty config is the one that means it.
      return { config: {}, revision: revisionOf("") };
    }
    let config: EtaConfig;
    try {
      const parsed: unknown = raw.trim().length === 0 ? {} : JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new Error("not an object");
      config = parsed as EtaConfig;
      if (
        config.providers !== undefined &&
        (!Array.isArray(config.providers) ||
          config.providers.some(
            (provider) =>
              typeof provider?.id !== "string" ||
              typeof provider.baseUrl !== "string" ||
              !Array.isArray(provider.models),
          ))
      ) {
        throw new Error("a provider is missing its id, baseUrl or models");
      }
    } catch {
      // A file that will not parse is an error, never an empty config: the first write after a
      // typo would otherwise delete everything else the user had.
      throw new ProviderConfigError("invalid_saved_config", 422);
    }
    return { config, revision: revisionOf(raw) };
  }

  private mutate(
    revision: unknown,
    update: (config: EtaConfig) => void,
  ): Promise<ProvidersView> {
    const run = this.tail.then(async () => {
      const state = await this.read();
      if (typeof revision !== "string" || state.revision !== revision) {
        throw new ProviderConfigError("config_changed", 409);
      }
      update(state.config);
      // A default model is a setting this app no longer has. A file from before keeps one until
      // its first write, so the upgrade's migration can read it; after that it would only mislead
      // whoever edits the file by hand.
      delete (state.config as { defaultModel?: unknown }).defaultModel;
      const raw = `${JSON.stringify(state.config, null, 2)}\n`;
      const temporary = `${this.path}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        // `0o600` on creation: the API key must never exist with looser permissions, not
        // even for the moment between writing and renaming.
        await writeFile(temporary, raw, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        // And catch an editor that changed the file while this write was prepared.
        if ((await this.read()).revision !== revision)
          throw new ProviderConfigError("config_changed", 409);
        await rename(temporary, this.path);
      } catch (error) {
        if (error instanceof ProviderConfigError) throw error;
        throw new ProviderConfigError("save_failed", 500);
      } finally {
        await rm(temporary, { force: true });
      }
      const view = publicView(state.config, revisionOf(raw));
      this.lastRevision = view.revision;
      this.notify(view);
      return view;
    });
    // The chain must survive a failed write, or one refusal would stop every later one.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Notice an external change and tell the listeners: the UI push and the model-layer rebuild. */
  private async poll(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      // A file that went away is a change too: the providers are gone.
      if (
        this.lastRevision === undefined ||
        this.lastRevision === revisionOf("")
      )
        return;
      this.lastRevision = revisionOf("");
      this.notify(await this.view());
      return;
    }
    const revision = revisionOf(raw);
    if (revision === this.lastRevision) return;
    this.lastRevision = revision;
    this.notify(await this.view());
  }
}

/**
 * A proxy URL, or a refusal.
 *
 * Two rules, and both are about what would end up in a plain-text file:
 *
 * - **No credentials in the URL.** `http://user:pass@host` is a password written to disk in a file
 *   this app reads back and a settings page renders. Proxy authentication belongs in the
 *   environment (or the client's own credential store), not in a config the UI shows.
 * - **It has to be a URL.** A scheme the resolver cannot use, or a string that is not a URL at all,
 *   is refused now rather than becoming a proxy that silently does not work.
 *
 * Normalised through `URL` so the stored value is the one a client would parse: `localhost:1082`
 * becomes `http://localhost:1082/`.
 */
function normalizeProxyUrl(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  if (text.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ProviderConfigError("invalid_network");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ProviderConfigError("invalid_network");
  if (url.username.length > 0 || url.password.length > 0)
    throw new ProviderConfigError("invalid_network");
  return url.href;
}

/** The client's view of a config: the key becomes a boolean, everything else stays. */
export function publicView(config: EtaConfig, revision: string): ProvidersView {
  return {
    revision,
    network: config.network ?? { mode: "system" },
    providers: (config.providers ?? []).map(providerSummary),
  };
}

/**
 * One provider, from what a form sent.
 *
 * The two rules that matter are about what is *not* sent: an omitted key keeps the saved one (a
 * form that never showed the secret must not erase it), and an omitted headers object keeps the
 * saved ones for the same reason.
 */
function normalizeProvider(
  input: {
    id: string;
    name?: string;
    kind?: EtaProviderConfig["kind"];
    baseUrl: string;
    apiKey?: string | null;
    headers?: EtaProviderConfig["headers"] | null;
    models: EtaProviderConfig["models"];
  },
  previous: EtaProviderConfig | undefined,
): EtaProviderConfig {
  const id = input.id.trim();
  if (id.length === 0 || id.length > 80)
    throw new ProviderConfigError("invalid_provider_id");
  const baseUrl = input.baseUrl.trim();
  if (baseUrl.length === 0 || baseUrl.length > 2_000)
    throw new ProviderConfigError("invalid_config");
  const kind = input.kind ?? previous?.kind ?? "openai-compatible";
  const apiKey =
    input.apiKey === null
      ? undefined
      : typeof input.apiKey === "string"
        ? input.apiKey.trim()
        : previous?.apiKey;
  const headers =
    input.headers === null
      ? undefined
      : input.headers !== undefined
        ? input.headers
        : previous?.headers;
  return {
    id,
    ...(input.name === undefined
      ? {}
      : { name: input.name.trim().slice(0, 200) }),
    kind,
    baseUrl,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    ...(headers === undefined ? {} : { headers }),
    models: input.models,
    ...(previous?.lastRefreshedAt === undefined
      ? {}
      : { lastRefreshedAt: previous.lastRefreshedAt }),
  };
}
