/**
 * The gateway's accounts, catalog and quota, read from CPA.
 *
 * CPA holds the credentials and routes with them; this reads what it reports (its credential
 * files, the API keys in its config, the models each serves) and turns that into the `llm`
 * target's views. Nothing here is kept but the models seen so far (`models.json`, so a model
 * stays listed after its account goes) and the outcome of the latest check of each account.
 */
import type { CpaClient, ModelInfo } from "@cpajs/cpa/client";
import type {
  LlmConnection,
  LlmConnector,
  LlmLogin,
  LlmModel,
  LlmProblem,
  LlmQuota,
  SourceSummary,
  SourceSummaryUpdate,
} from "@eta/client-contracts";
import type { Connector, KeyGroups } from "./connectors";
import type { Connection } from "./state";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { CpaHttpError } from "@cpajs/cpa/client";
import { billingRetryAt, isMonthDuration } from "@eta/client-contracts";
import { excludesAll, updateKeys } from "./connectors";
import { codeOf, LlmError, notFound, problem } from "./problems";
import { selectSourceQuota } from "./source-quota";
import {
  connectionReason,
  connectionView,
  fileConnection,
  keyConnection,
  modelRank,
  modelState,
  severity,
} from "./state";

/** A model with the facts the model layer needs beyond the view. */
export interface CatalogModel extends LlmModel {
  reasoningLevels: string[];
  image: boolean;
}

/** A catalog entry as `models.json` keeps it (the Go gateway's format, so the file carries over). */
interface SeenModel {
  id: string;
  connector: string;
  display_name: string;
  context_window?: number;
  reasoning_levels?: string[];
  image?: boolean;
}

type ConfiguredModel = NonNullable<KeyGroups[number]["models"]>[number];

const USAGE_TIMEOUT_MS = 15_000;

/** The outcome of an account's latest check. */
interface AccountRead {
  revision?: string | undefined;
  reading: Promise<LlmQuota>;
  abort: AbortController;
  retryAt: number;
  failures: number;
  succeeded: boolean;
}

interface Check {
  started: number;
  done: number;
  error?: LlmProblem | undefined;
}

export interface GatewayOptions {
  cpa: () => CpaClient;
  connectors: readonly Connector[];
  /** Where the models seen so far are kept. */
  catalogPath: string;
  now?: (() => number) | undefined;
}

export class Gateway {
  readonly #cpa: () => CpaClient;
  readonly #connectors: readonly Connector[];
  readonly #byId = new Map<string, Connector>();
  readonly #byProvider = new Map<string, Connector>();
  readonly #catalogPath: string;
  readonly #now: () => number;
  /** When this gateway started: what an API key, which CPA dates nothing of, says it was added. */
  readonly #started: string;
  readonly #seen = new Map<string, SeenModel>();
  readonly #definitions = new Map<string, Promise<Map<string, ModelInfo>>>();
  readonly #checks = new Map<string, Check>();
  readonly #logins = new Map<
    string,
    { connector: Connector; expires: number }
  >();
  readonly #usage = new Map<string, AccountRead>();
  #refreshing: Promise<GatewayStatus & { quota: LlmQuota[] }> | undefined;

  constructor(options: GatewayOptions) {
    this.#cpa = options.cpa;
    this.#connectors = options.connectors;
    this.#catalogPath = options.catalogPath;
    this.#now = options.now ?? Date.now;
    this.#started = new Date(this.#now()).toISOString();
    for (const connector of options.connectors) {
      this.#byId.set(connector.info.id, connector);
      this.#byProvider.set(connector.provider, connector);
    }
    try {
      const seen = JSON.parse(
        readFileSync(this.#catalogPath, "utf8"),
      ) as SeenModel[];
      for (const model of seen) this.#seen.set(model.id, model);
    } catch {
      // None seen yet.
    }
  }

  connectors(): LlmConnector[] {
    return this.#connectors.map((connector) => ({ ...connector.info }));
  }

  /** The accounts and the catalog, from one reading of CPA. */
  async status(): Promise<GatewayStatus> {
    const connections = await this.#connections();
    return {
      connections: connections.map(connectionView),
      models: await this.#models(connections),
    };
  }

  async connections(): Promise<LlmConnection[]> {
    return (await this.#connections()).map(connectionView);
  }

  async models(): Promise<CatalogModel[]> {
    return this.#models(await this.#connections());
  }

  // --- Accounts ----------------------------------------------------------------------------

  /** The accounts: CPA's credential files and the API keys in its config. */
  async #connections(): Promise<Connection[]> {
    const cpa = this.#cpa();
    const now = this.#now();
    const [{ files }, keys] = await Promise.all([
      cpa.credentials.list(),
      cpa.config
        .getPath<Partial<Record<string, KeyGroups>> | null>("api-keys")
        .then(
          ({ data }) => data ?? {},
          (error: unknown): Partial<Record<string, KeyGroups>> => {
            if (error instanceof CpaHttpError && error.status === 404)
              return {};
            throw error;
          },
        ),
    ]);
    const out: Connection[] = [];
    for (const entry of files) {
      const connector = this.#byProvider.get(entry.provider.toLowerCase());
      if (connector === undefined) continue;
      out.push(
        this.#withCheck(
          fileConnection(entry, connector.info.id, now),
          Date.parse(entry.updated_at ?? "") || 0,
        ),
      );
    }
    for (const connector of this.#connectors) {
      for (const group of keys[connector.provider] ?? []) {
        for (const key of group.keys) {
          if (key.auth_index === undefined) continue;
          const connection = keyConnection({
            authIndex: key.auth_index,
            connector: connector.info.id,
            provider: connector.provider,
            key: key["api-key"],
            models: key.models ?? group.models ?? [],
            disabled:
              excludesAll(key["excluded-models"]) ||
              excludesAll(group["excluded-models"]),
            createdAt: this.#started,
          });
          out.push(this.#withCheck(connection, 0));
        }
      }
    }
    const order = this.#connectors.map((connector) => connector.info.id);
    return out.sort(
      (a, b) =>
        order.indexOf(a.connector) - order.indexOf(b.connector) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  }

  async #connection(id: string): Promise<Connection> {
    const found = (await this.#connections()).find(
      (connection) => connection.id === id,
    );
    if (found === undefined) throw notFound();
    return found;
  }

  /**
   * Add the account's latest check. A check only reports, except that a login (or key) the
   * provider rejected, even after a refresh, needs the user, unless CPA has heard from the
   * account since.
   */
  #withCheck(connection: Connection, updatedAt: number): Connection {
    const check = this.#checks.get(connection.id);
    if (check === undefined) return connection;
    const checked: Connection = {
      ...connection,
      checkedAt: new Date(check.done).toISOString(),
      ...(check.error === undefined ? {} : { checkError: check.error }),
    };
    if (
      check.error !== undefined &&
      rejected(check.error.code) &&
      updatedAt <= check.done &&
      (connection.state === "active" || connection.state === "degraded")
    ) {
      const { retryAt: _retry, ...rest } = checked;
      return {
        ...rest,
        state: "needs_login",
        error: this.#authExpired(connection.connector),
      };
    }
    return checked;
  }

  #apiKey(connector: string): boolean {
    return this.#byId.get(connector)?.info.flow === "api_key";
  }

  #authExpired(connector: string): LlmProblem {
    return this.#apiKey(connector)
      ? problem("invalid_api_key", "The API key is invalid.")
      : problem(
          "login_expired",
          "The login is no longer accepted; sign in again.",
        );
  }

  #name(connector: string): string {
    return this.#byId.get(connector)?.info.name ?? connector;
  }

  /** Enable or disable an account: a file through CPA's status, a key through its excluded models. */
  async setEnabled(id: string, enabled: boolean): Promise<LlmConnection> {
    const { source } = await this.#connection(id);
    if (source.kind === "file") {
      await this.#cpa().credentials.setStatus({
        name: source.name,
        disabled: !enabled,
      });
    } else {
      await this.#editKey(source.provider, source.key, (entry) => {
        const { "excluded-models": excluded = [], ...rest } = entry;
        const others = (excluded ?? []).filter(
          (pattern) => pattern.trim() !== "*",
        );
        const next = enabled ? others : [...others, "*"];
        return next.length === 0 ? rest : { ...rest, "excluded-models": next };
      });
    }
    this.#forgetUsage(id);
    return connectionView(await this.#connection(id));
  }

  /** Remove an account: its credential file, or its key from CPA's config. */
  async remove(id: string): Promise<void> {
    const { source } = await this.#connection(id);
    if (source.kind === "file")
      await this.#cpa().credentials.delete(source.name);
    else await this.#editKey(source.provider, source.key, () => undefined);
    this.#forgetUsage(id);
    this.#checks.delete(id);
  }

  /** Replace one key in CPA's config with what `edit` makes of it; nothing removes it. */
  #editKey(
    provider: string,
    key: string,
    edit: (
      entry: KeyGroups[number]["keys"][number],
    ) => KeyGroups[number]["keys"][number] | undefined,
  ): Promise<void> {
    return updateKeys(this.#cpa(), provider, (groups) =>
      groups
        .map((group) => ({
          ...group,
          keys: group.keys.flatMap((entry) => {
            if (entry["api-key"] !== key) return [entry];
            const next = edit(entry);
            return next === undefined ? [] : [next];
          }),
        }))
        .filter((group) => group.keys.length > 0),
    );
  }

  // --- Catalog -----------------------------------------------------------------------------

  /**
   * CPA's static details of a channel's models (the context window, the thinking levels, the
   * inputs): fixed for the binary, so read once per channel. A connector's provider is its channel.
   */
  #details(channel: string): Promise<Map<string, ModelInfo>> {
    let details = this.#definitions.get(channel);
    if (details === undefined) {
      details = this.#cpa()
        .routing.modelDefinitions(channel)
        .then(
          ({ models }) => new Map(models.map((model) => [model.id, model])),
        );
      // A failure is asked again next time.
      details.catch(() => this.#definitions.delete(channel));
      this.#definitions.set(channel, details);
    }
    return details;
  }

  /**
   * The models one account serves, with their details: a file's are CPA's; a key's are those
   * its config lists (by alias), else all of the channel's. A disabled key's models are left to
   * the account's state, so its excluded models are not read.
   */
  async #served(connection: Connection): Promise<SeenModel[]> {
    const details = await this.#details(
      this.#byId.get(connection.connector)!.provider,
    );
    const seen = (
      id: string,
      info: ModelInfo | undefined,
      configured?: ConfiguredModel,
    ): SeenModel => {
      const levels =
        configured?.thinking?.levels ?? info?.thinking?.levels ?? [];
      const window =
        configured?.["max-context-length"] ??
        firstPositive(info?.context_length, info?.inputTokenLimit);
      return {
        id,
        connector: connection.connector,
        display_name:
          configured?.["display-name"] ||
          info?.display_name ||
          info?.name ||
          id,
        ...(window === undefined ? {} : { context_window: window }),
        ...(levels.length === 0 ? {} : { reasoning_levels: [...levels] }),
        ...((info?.supportedInputModalities ?? []).some(
          (modality) => modality.toLowerCase() === "image",
        )
          ? { image: true }
          : {}),
      };
    };
    const { source } = connection;
    if (source.kind === "file") {
      const { models } = await this.#cpa().credentials.models(source.name);
      return models.map((model) => seen(model.id, details.get(model.id)));
    }
    if (source.models.length === 0)
      return [...details.values()].map((info) => seen(info.id, info));
    return source.models.map((model) =>
      seen(model.alias || model.name, details.get(model.name), model),
    );
  }

  /**
   * The catalog with each model's status now: the best of the accounts that serve it, so one
   * account's trouble does not hide a model another still serves. A model no account serves
   * stays listed, explained by its connector's most actionable account.
   */
  async #models(connections: readonly Connection[]): Promise<CatalogModel[]> {
    const worst = new Map<string, Connection>();
    for (const connection of connections) {
      const previous = worst.get(connection.connector);
      if (
        connection.state !== "active" &&
        severity(connection.state) > severity(previous?.state ?? "active")
      )
        worst.set(connection.connector, connection);
    }
    const served = await Promise.all(
      connections.map(async (connection) => ({
        connection,
        models: await this.#served(connection).catch(() => [] as SeenModel[]),
      })),
    );
    let changed = false;
    const best = new Map<string, ReturnType<typeof modelState>>();
    for (const { connection, models } of served) {
      const name = this.#name(connection.connector);
      for (const model of models) {
        if (!chatModel(model.id)) continue;
        if (
          JSON.stringify(this.#seen.get(model.id)) !== JSON.stringify(model)
        ) {
          this.#seen.set(model.id, model);
          changed = true;
        }
        const state = modelState(
          connection,
          model.id,
          name,
          this.#apiKey(connection.connector),
        );
        const previous = best.get(model.id);
        if (
          previous === undefined ||
          modelRank(state.status) > modelRank(previous.status)
        )
          best.set(model.id, state);
      }
    }
    if (changed) this.#saveCatalog();
    const out: CatalogModel[] = [];
    for (const seen of this.#seen.values()) {
      let state = best.get(seen.id);
      if (state === undefined) {
        // No account serves it: none is connected, or they all are down.
        const account = worst.get(seen.connector);
        state = {
          status: account?.state === "degraded" ? "degraded" : "unavailable",
          reason: connectionReason(
            this.#name(seen.connector),
            this.#apiKey(seen.connector),
            account,
          ),
          retryAt: account?.retryAt,
        };
      }
      out.push({
        id: seen.id,
        connector: seen.connector,
        name: seen.display_name === "" ? seen.id : seen.display_name,
        ...(seen.context_window === undefined
          ? {}
          : { contextWindow: seen.context_window }),
        status: state.status,
        available: state.status !== "unavailable",
        ...(state.reason === undefined ? {} : { reason: state.reason }),
        ...(state.retryAt === undefined ? {} : { retryAt: state.retryAt }),
        reasoningLevels: seen.reasoning_levels ?? [],
        image: seen.image === true,
      });
    }
    const order = this.#connectors.map((connector) => connector.info.id);
    return out.sort(
      (a, b) =>
        order.indexOf(a.connector) - order.indexOf(b.connector) ||
        a.id.localeCompare(b.id),
    );
  }

  #saveCatalog(): void {
    const models = [...this.#seen.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const temporary = `${this.#catalogPath}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(models, null, 2), {
        mode: 0o600,
      });
      renameSync(temporary, this.#catalogPath);
    } catch {
      // Kept in memory; written with the next change.
    }
  }

  // --- Usage and checks --------------------------------------------------------------------

  /**
   * Read the subscription windows of every enabled account whose connector can, concurrently,
   * and record each read as the account's latest check. A login the provider rejects is
   * refreshed once (as CPA does when a request gets a 401) before the check says so.
   */
  async usage(): Promise<LlmQuota[]> {
    const connections = await this.#connections();
    const enabled = connections.filter(
      (connection) => connection.state !== "disabled",
    );
    const ids = new Set(enabled.map((connection) => connection.id));
    for (const id of this.#usage.keys()) {
      if (!ids.has(id)) this.#forgetUsage(id);
    }
    const reads = enabled.flatMap((connection) => {
      const connector = this.#byId.get(connection.connector);
      if (!connector?.usage) return [];
      return [this.#readUsage(connection, connector)];
    });
    const result = await Promise.all(reads.map((entry) => entry.reading));
    return result.filter(
      (quota, index) => this.#usage.get(quota.connectionId) === reads[index],
    );
  }

  /** Read-only: each result belongs to one credential and one unambiguous monthly window. */
  async monthlySummaries(
    schedule: (read: () => Promise<LlmQuota>) => Promise<LlmQuota>,
    warn: (message: string) => void,
  ): Promise<SourceSummary[]> {
    const connections = await this.#connections();
    const items = await Promise.all(
      connections.map(async (connection) => {
        const { id, quotaRevision } = connection;
        const empty = {
          source: "account" as const,
          id,
          quotaRevision: quotaRevision ?? null,
          value: null,
        };
        const quota = await this.#readSummaryQuota(connection, schedule, warn);
        if (!quota) return empty;
        const windows = quota.windows.filter(
          (w) =>
            w.kind === "monthly" &&
            (w.durationSeconds === undefined ||
              isMonthDuration(w.durationSeconds)),
        );
        const window = windows[0];
        if (
          windows.length !== 1 ||
          !window ||
          !Number.isFinite(window.used) ||
          window.used < 0 ||
          window.used > 100 ||
          (window.resetsAt !== undefined &&
            !(Date.parse(window.resetsAt) > this.#now()))
        )
          return empty;
        return {
          ...empty,
          value: {
            monthly: {
              usedPercent: window.used,
              ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
            },
          },
        };
      }),
    );
    const current = new Map((await this.#connections()).map((c) => [c.id, c]));
    return items.map((item) =>
      current.get(item.id)?.quotaRevision === item.quotaRevision &&
      current.get(item.id)?.state === "active"
        ? item
        : { ...item, value: null },
    );
  }

  async streamQuotaSummaries(
    schedule: (read: () => Promise<LlmQuota>) => Promise<LlmQuota>,
    warn: (message: string) => void,
    publish: (item: SourceSummaryUpdate) => void,
  ): Promise<void> {
    const connections = await this.#connections();
    await Promise.all(
      connections.map(async (connection) => {
        const { id, quotaRevision } = connection;
        const quota = await this.#readSummaryQuota(connection, schedule, warn);
        let selected = null;
        if (quota) {
          const current = await this.#connection(id).catch(() => undefined);
          if (
            current?.state === "active" &&
            current.quotaRevision === quotaRevision &&
            this.#usage.get(id)?.revision === quotaRevision
          )
            selected = selectSourceQuota(quota.windows, this.#now());
        }
        publish({
          source: "account",
          id,
          quotaRevision: quotaRevision ?? null,
          value: selected === null ? null : { quota: selected },
        });
      }),
    );
  }

  async #readSummaryQuota(
    connection: Connection,
    schedule: (read: () => Promise<LlmQuota>) => Promise<LlmQuota>,
    warn: (message: string) => void,
  ): Promise<LlmQuota | undefined> {
    const { id, quotaRevision } = connection;
    const connector = this.#byId.get(connection.connector);
    if (!quotaRevision || !connector?.usage || connection.state !== "active")
      return undefined;
    const entry = this.#readUsage(connection, connector, schedule, warn);
    const quota = await entry.reading.catch(() => {
      warn(
        `[eta] billing ${connector.info.id} source=${quotaRevision.slice(0, 12)} failure=unavailable`,
      );
      return undefined;
    });
    return quota && !quota.error && this.#usage.get(id) === entry
      ? quota
      : undefined;
  }

  #readUsage(
    connection: Connection,
    connector: Connector,
    schedule?: (read: () => Promise<LlmQuota>) => Promise<LlmQuota>,
    warn?: (message: string) => void,
  ): AccountRead {
    if (this.#usage.get(connection.id)?.revision !== connection.quotaRevision)
      this.#forgetUsage(connection.id);
    const current = this.#usage.get(connection.id);
    if (
      current &&
      this.#now() < current.retryAt &&
      !(schedule && current.succeeded)
    )
      return current;
    const abort = new AbortController();
    const read = () =>
      this.#accountUsage(connection, connector, abort.signal, !schedule);
    const entry: AccountRead = {
      revision: connection.quotaRevision,
      abort,
      retryAt: Infinity,
      failures: current?.failures ?? 0,
      succeeded: false,
      reading: schedule ? schedule(read) : read(),
    };
    this.#usage.set(connection.id, entry);
    entry.reading = entry.reading.then(
      (quota) => {
        entry.succeeded = !quota.error;
        entry.retryAt = quota.retryAt
          ? Math.max(this.#now() + 15_000, Date.parse(quota.retryAt))
          : this.#now() + 15_000;
        if (
          quota.error?.code === "model_forbidden" ||
          quota.error?.code === "invalid_api_key" ||
          quota.error?.code === "login_expired"
        )
          entry.retryAt = Infinity;
        entry.failures =
          quota.error?.code === "rate_limited" ? entry.failures + 1 : 0;
        if (quota.error && warn && !abort.signal.aborted) {
          const retry = Number.isFinite(entry.retryAt)
            ? new Date(entry.retryAt).toISOString()
            : "credential_change";
          warn(
            `[eta] billing ${connector.info.id} source=${connection.quotaRevision?.slice(0, 12)} failure=${quota.error.code} retry=${retry}`,
          );
        }
        return quota;
      },
      (error) => {
        if (this.#usage.get(connection.id) === entry)
          this.#usage.delete(connection.id);
        throw error;
      },
    );
    return entry;
  }

  #forgetUsage(id: string): void {
    this.#usage.get(id)?.abort.abort();
    this.#usage.delete(id);
  }

  async #accountUsage(
    connection: Connection,
    connector: Connector,
    cancel: AbortSignal,
    checkHealth: boolean,
  ): Promise<LlmQuota> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(USAGE_TIMEOUT_MS),
      cancel,
    ]);
    const started = this.#now();
    const apiKey = this.#apiKey(connection.connector);
    let usage;
    let failure: unknown;
    try {
      usage = await connector.usage!(connection, signal);
    } catch (error) {
      failure = error;
    }
    if (
      checkHealth &&
      rejected(codeOf(failure)) &&
      !apiKey &&
      connection.source.kind === "file"
    ) {
      try {
        await this.#cpa().credentials.refresh(
          { name: connection.source.name },
          { signal },
        );
        usage = await connector.usage!(connection, signal);
        failure = undefined;
      } catch (error) {
        // The refresh failing leaves the first answer standing.
        if (codeOf(error) !== undefined) failure = error;
      }
    }
    if (checkHealth && !cancel.aborted)
      this.#record(connection.id, {
        started,
        done: this.#now(),
        error: checkError(failure, apiKey),
      });
    const retryAt =
      failure instanceof LlmError && failure.code === "rate_limited"
        ? billingRetryAt(
            failure.retryAfter,
            this.#usage.get(connection.id)?.failures ?? 0,
            this.#now(),
          )
        : undefined;
    return {
      connectionId: connection.id,
      ...(connection.quotaRevision
        ? { quotaRevision: connection.quotaRevision }
        : {}),
      ...(retryAt === undefined
        ? {}
        : { retryAt: new Date(retryAt).toISOString() }),
      ...(usage?.plan === undefined || usage.plan === ""
        ? {}
        : { plan: usage.plan }),
      windows: usage?.windows ?? [],
      ...(failure === undefined
        ? { observedAt: new Date(this.#now()).toISOString() }
        : {}),
      ...(failure === undefined
        ? {}
        : {
            error:
              failure instanceof LlmError
                ? failure.view
                : problem("usage_unavailable", "Could not read the usage."),
          }),
    };
  }

  /** Keep the newest check: one that started earlier and finished later says less. */
  #record(id: string, check: Check): void {
    const previous = this.#checks.get(id);
    if (previous !== undefined && previous.started > check.started) return;
    this.#checks.set(id, check);
  }

  /**
   * Check every account against its provider now. Concurrent calls share one round, so pressing
   * refresh repeatedly sends one request per account.
   */
  refresh(): Promise<GatewayStatus & { quota: LlmQuota[] }> {
    this.#refreshing ??= (async () => {
      try {
        const quota = await this.usage();
        return { ...(await this.status()), quota };
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  // --- Logins ------------------------------------------------------------------------------

  async loginStart(connectorId: string): Promise<LlmLogin> {
    const connector = this.#byId.get(connectorId);
    if (connector === undefined) throw notFound();
    const login = await connector.start();
    const now = this.#now();
    for (const [id, entry] of this.#logins) {
      if (now > entry.expires + 3_600_000) this.#logins.delete(id);
    }
    this.#logins.set(login.id, {
      connector,
      expires: Date.parse(login.expiresAt),
    });
    return login;
  }

  #login(id: string): Connector {
    const entry = this.#logins.get(id);
    if (entry === undefined) throw notFound();
    return entry.connector;
  }

  async loginPoll(id: string): Promise<LlmLogin> {
    return this.#login(id).poll(id);
  }

  async loginSubmit(id: string, apiKey: string): Promise<LlmLogin> {
    const connector = this.#login(id);
    await connector.submit(id, apiKey);
    return connector.poll(id);
  }

  async loginCancel(id: string): Promise<void> {
    const entry = this.#logins.get(id);
    if (entry === undefined) return;
    this.#logins.delete(id);
    try {
      await entry.connector.cancel(id);
    } catch (error) {
      if (codeOf(error) !== "not_found") throw error;
    }
  }
}

export interface GatewayStatus {
  connections: LlmConnection[];
  models: CatalogModel[];
}

/** A code that says the provider does not accept the credential. */
function rejected(code: string | undefined): boolean {
  return code === "login_expired" || code === "invalid_api_key";
}

function checkError(error: unknown, apiKey: boolean): LlmProblem | undefined {
  if (error === undefined) return undefined;
  if (rejected(codeOf(error)))
    return apiKey
      ? problem("invalid_api_key", "The provider rejected the API key.")
      : problem("login_expired", "The provider rejected the login token.");
  return problem(
    "check_failed",
    "The provider could not be reached to check the account; its status is unchanged.",
  );
}

/** Image, video and embedding models, which agents cannot use, are left out. */
function chatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return ![
    "image",
    "video",
    "embedding",
    "tts",
    "whisper",
    "imagine",
    "auto-review",
  ].some((word) => lower.includes(word));
}

function firstPositive(...values: (number | undefined)[]): number | undefined {
  return values.find((value) => value !== undefined && value > 0);
}
