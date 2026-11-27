/**
 * Composio TriggerProvider: pure native `fetch` + `WebSocket` implementation (zero Composio/Pusher
 * SDK dependencies) implementing Task #136's verified API & Pusher v7 protocol contracts:
 * - Catalog: `GET /api/v3.1/triggers_types?toolkit_slugs=a,b&limit=50` (comma-joined, <= 50/page)
 * - Lifecycle: `POST /api/v3.1/trigger_instances/{slug}/upsert` with explicit `user_id` +
 *   `connected_account_id`, `GET /api/v3.1/trigger_instances/active`,
 *   `PATCH/DELETE /api/v3.1/trigger_instances/manage/{triggerId}`
 * - Realtime: `GET /api/v3/internal/sdk/realtime/credentials` ->
 *   `wss://ws-${cluster}.pusher.com/app/${key}?protocol=7&client=js&version=8.6.0&flash=false` ->
 *   `POST /api/v3/internal/sdk/realtime/auth` -> `pusher:subscribe` with verbatim `channel_data` ->
 *   heartbeat + 30s pong timeout + close code classification + 10KB chunk reassembly.
 */
import type {
  RoutineTrigger,
  TriggerCatalogAccount,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type {
  IncomingTriggerEvent,
  TriggerProvider,
  TriggerProviderHost,
  TriggerProvisionResult,
} from "../routines/triggers";
import type { Composio, ComposioConnectedAccount } from "./composio";
import { Buffer } from "node:buffer";
import { redactText } from "../captain/redact";
import { ComposioTriggerError } from "./composio";

const TRIGGERS_PAGE_LIMIT = 50;
const MAX_CATALOG_PAGES = 20;
const MAX_ACTIVE_PAGES = 20;
const CATALOG_TTL_MS = 5 * 60_000;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 120_000;
const DEFAULT_PONG_TIMEOUT_MS = 30_000;
const DEFAULT_CHUNK_TIMEOUT_MS = 60_000;
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_INCOMPLETE_CHUNKS = 64;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

const SLUG = /^[\w-]{1,100}$/;
const SAFE_ID = /^[\w.-]{1,200}$/;
const TRIGGER_SLUG = /^[\w.-]{1,200}$/;
const CLUSTER = /^[\w-]{1,64}$/;

export interface ComposioTriggerOptions {
  composio: Composio;
  /** Tests only: override `wss://ws-${cluster}.pusher.com` base URL for local fake Pusher servers. */
  pusherUrl?: string | undefined;
  /** Tests only: inject a custom WebSocket implementation. */
  webSocket?: typeof WebSocket | undefined;
  now?: (() => number) | undefined;
  warn?: ((message: string) => void) | undefined;
  catalogTtlMs?: number | undefined;
  activityTimeoutMs?: number | undefined;
  pongTimeoutMs?: number | undefined;
  chunkTimeoutMs?: number | undefined;
  reconnectBaseMs?: number | undefined;
  reconnectMaxMs?: number | undefined;
}

export type CloseAction = "tls_only" | "refused" | "retry" | "backoff";

/** Pusher Protocol v7 close code / `pusher:error.data.code` classification (`getCloseAction`). */
export function classifyPusherCloseCode(code: number): CloseAction {
  if (code === 4000) return "tls_only";
  if ((code >= 4001 && code <= 4099) || code >= 4300) return "refused";
  if (code >= 4200 && code <= 4299) return "retry";
  return "backoff";
}

/**
 * Pure parser for `trigger_to_client` frames (compatible with Composio V3 envelope + V1/V2/legacy).
 * Idempotency key priority strictly matches #136: `id` (`msg_...`) -> `metadata.log_id` ->
 * `log_id` -> `metadata.id`. `metadata.trigger_id` (instance ID) is never used as `eventId`.
 */
export function parseComposioTriggerEvent(
  rawData: unknown,
  nowMs: number = Date.now(),
): (IncomingTriggerEvent & { userId: string | null }) | null {
  const msg = parseJsonIfString(rawData);
  if (!isPlain(msg)) return null;
  const meta = isPlain(msg.metadata) ? msg.metadata : {};

  const eventId =
    nonEmpty(msg.id) ??
    nonEmpty(meta.log_id) ??
    nonEmpty(msg.log_id) ??
    nonEmpty(meta.id);
  if (eventId === null) return null;

  const instanceId =
    nonEmpty(meta.trigger_id) ??
    nonEmpty(meta.triggerId) ??
    nonEmpty(msg.trigger_id) ??
    nonEmpty(msg.triggerId) ??
    // Only treat `metadata.id` as `instanceId` when it wasn't used as the event id fallback.
    (nonEmpty(meta.id) !== null && nonEmpty(meta.id) !== eventId
      ? nonEmpty(meta.id)
      : (nonEmpty(meta.nano_id) ?? nonEmpty(meta.nanoId))) ??
    null;

  const triggerSlug =
    nonEmpty(msg.trigger_slug) ??
    nonEmpty(meta.trigger_slug) ??
    nonEmpty(msg.triggerSlug) ??
    nonEmpty(meta.triggerName) ??
    nonEmpty(meta.trigger_name) ??
    nonEmpty(msg.type);
  if (triggerSlug === null) return null;

  const accountObj = isPlain(meta.connected_account)
    ? meta.connected_account
    : isPlain(msg.connected_account)
      ? msg.connected_account
      : null;
  const accountId =
    (accountObj ? nonEmpty(accountObj.id) : null) ??
    nonEmpty(meta.connected_account_id) ??
    nonEmpty(msg.connected_account_id) ??
    null;

  const source =
    nonEmpty(meta.toolkit_slug) ??
    nonEmpty(msg.toolkit_slug) ??
    nonEmpty(meta.appName) ??
    nonEmpty(meta.app_name) ??
    null;

  const userId = nonEmpty(meta.user_id) ?? nonEmpty(msg.user_id) ?? null;

  const occurredAt = parseTimestamp(
    msg.timestamp ?? meta.timestamp ?? msg.occurred_at,
    nowMs,
  );

  const payload =
    msg.data !== undefined
      ? msg.data
      : msg.payload !== undefined
        ? msg.payload
        : msg.original_payload !== undefined
          ? msg.original_payload
          : msg;

  return {
    provider: "composio",
    instanceId,
    triggerSlug,
    source,
    accountId,
    userId,
    eventId,
    occurredAt,
    payload,
  };
}

interface CatalogCacheEntry {
  key: string;
  fetchedAt: number;
  items: Omit<TriggerCatalogItem, "accounts">[];
}

interface ChunkBuffer {
  parts: Map<number, string>;
  finalIndex: number | undefined;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

export class ComposioTriggerProvider implements TriggerProvider {
  readonly id = "composio";

  readonly #composio: Composio;
  readonly #pusherUrl: string | undefined;
  readonly #WebSocketImpl: typeof WebSocket;
  readonly #now: () => number;
  readonly #warn: (message: string) => void;
  readonly #catalogTtlMs: number;
  readonly #activityTimeoutOverrideMs: number | undefined;
  readonly #pongTimeoutMs: number;
  readonly #chunkTimeoutMs: number;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaxMs: number;

  #host: TriggerProviderHost | undefined;
  #unlistenContext: (() => void) | undefined;
  #catalogCache: CatalogCacheEntry | undefined;
  #lastApiError:
    | { epoch: number; status: "key_rejected" | "error"; message: string }
    | undefined;

  #stopped = false;
  #started = false;
  #connecting = false;
  #ws: WebSocket | undefined;
  #wsEpoch = 0;
  #intentionallyClosed = new WeakSet<WebSocket>();
  #channelName: string | undefined;
  #serverActivityMs = DEFAULT_ACTIVITY_TIMEOUT_MS;
  #streamError: string | null = null;
  #refused = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #activityTimer: ReturnType<typeof setTimeout> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;
  #activeSecrets: string[] = [];
  readonly #chunks = new Map<string, ChunkBuffer>();

  constructor(options: ComposioTriggerOptions) {
    this.#composio = options.composio;
    this.#pusherUrl = options.pusherUrl;
    this.#WebSocketImpl = options.webSocket ?? WebSocket;
    this.#now = options.now ?? Date.now;
    this.#warn = options.warn ?? ((message) => console.warn(message));
    this.#catalogTtlMs = options.catalogTtlMs ?? CATALOG_TTL_MS;
    this.#activityTimeoutOverrideMs = options.activityTimeoutMs;
    this.#pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.#chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
    this.#reconnectBaseMs =
      options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.#reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  }

  status(): TriggerProviderStatus {
    if (!this.#composio.hasKey()) {
      return { provider: this.id, status: "needs_key" };
    }
    if (!this.#composio.source().enabled) {
      return { provider: this.id, status: "disabled" };
    }
    if (this.#streamError !== null) {
      return {
        provider: this.id,
        status: "error",
        error: this.#streamError,
      };
    }
    if (
      this.#lastApiError !== undefined &&
      this.#lastApiError.epoch === this.#composio.triggerEpoch()
    ) {
      return {
        provider: this.id,
        status: this.#lastApiError.status,
        error: this.#lastApiError.message,
      };
    }
    return { provider: this.id, status: "ready" };
  }

  /* --------------------------------------------------------------- catalog */

  async listTriggers(filter?: {
    source?: string;
    query?: string;
    refresh?: boolean;
  }): Promise<TriggerCatalogItem[]> {
    if (!this.#composio.hasKey() || !this.#composio.source().enabled) return [];
    const sourceFilter = filter?.source?.trim();
    if (
      sourceFilter !== undefined &&
      sourceFilter !== "" &&
      !SLUG.test(sourceFilter)
    )
      return [];

    const accountState = await this.#composio.connectedAccounts();
    if (accountState.status === "key_rejected") {
      const message = "Composio refused the API key";
      this.#lastApiError = {
        epoch: this.#composio.triggerEpoch(),
        status: "key_rejected",
        message,
      };
      return [];
    }
    if (accountState.status === "error") {
      const message = "could not read connected accounts from Composio";
      this.#lastApiError = {
        epoch: this.#composio.triggerEpoch(),
        status: "error",
        message,
      };
      throw new Error(message);
    }
    this.#lastApiError = undefined;

    const targetSlugs =
      sourceFilter !== undefined && sourceFilter !== ""
        ? [sourceFilter]
        : [
            ...new Set([
              ...accountState.accounts.map((a) => a.slug),
              ...this.#composio.added(),
            ]),
          ].sort();

    if (targetSlugs.length === 0) return [];

    const epoch = this.#composio.triggerEpoch();
    const cacheKey = `${epoch}:${targetSlugs.join(",")}`;
    let rawItems: Omit<TriggerCatalogItem, "accounts">[];
    if (
      filter?.refresh !== true &&
      this.#catalogCache !== undefined &&
      this.#catalogCache.key === cacheKey &&
      this.#now() - this.#catalogCache.fetchedAt < this.#catalogTtlMs
    ) {
      rawItems = this.#catalogCache.items;
    } else {
      rawItems = await this.#fetchCatalog(targetSlugs, epoch);
      if (epoch === this.#composio.triggerEpoch()) {
        this.#catalogCache = {
          key: cacheKey,
          fetchedAt: this.#now(),
          items: rawItems,
        };
      }
    }

    const bySlug = groupAccountsBySlug(accountState.accounts);
    const q = filter?.query?.trim().toLowerCase();
    const items = rawItems.map((item) => ({
      ...item,
      accounts: bySlug.get(item.source) ?? [],
    }));
    if (q === undefined || q === "") return items;
    return items.filter((item) =>
      [item.source, item.sourceName, item.trigger, item.name, item.description]
        .join("\n")
        .toLowerCase()
        .includes(q),
    );
  }

  async #fetchCatalog(
    slugs: string[],
    epoch: number,
  ): Promise<Omit<TriggerCatalogItem, "accounts">[]> {
    const names = this.#composio.cachedToolkitNames();
    const collected: Omit<TriggerCatalogItem, "accounts">[] = [];
    const seen = new Set<string>();

    // Batch slugs (<= 20 per request) and always use comma format `?toolkit_slugs=a,b`.
    for (let offset = 0; offset < slugs.length; offset += 20) {
      const batch = slugs.slice(offset, offset + 20);
      const slugParam = batch.map((s) => encodeURIComponent(s)).join(",");
      let cursor: string | null = null;
      for (let page = 1; ; page++) {
        if (page > MAX_CATALOG_PAGES)
          throw new Error(
            `Composio trigger catalog exceeded ${MAX_CATALOG_PAGES} pages`,
          );
        const queryParts = [
          `limit=${TRIGGERS_PAGE_LIMIT}`,
          `toolkit_slugs=${slugParam}`,
        ];
        if (cursor !== null)
          queryParts.push(`cursor=${encodeURIComponent(cursor)}`);
        const body = await this.#composio.triggerRequest(
          "GET",
          `/api/v3.1/triggers_types?${queryParts.join("&")}`,
        );
        if (!isPlain(body) || !Array.isArray(body.items))
          throw new Error("Composio returned an invalid trigger catalog");
        for (const entry of body.items) {
          const parsed = catalogItemOf(entry, names);
          if (parsed === null) continue;
          const dedupeKey = `${parsed.source}:${parsed.trigger}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          collected.push(parsed);
        }
        const next: unknown = body.next_cursor;
        if (typeof next !== "string" || next === "" || body.items.length === 0)
          break;
        if (next === cursor)
          throw new Error("Composio trigger catalog cursor did not advance");
        if (epoch !== this.#composio.triggerEpoch()) break;
        cursor = next;
      }
    }
    return collected;
  }

  /* ------------------------------------------------------- instance sync */

  async provision(input: {
    routineId: string;
    trigger: RoutineTrigger;
    enabled: boolean;
    existingInstanceId: string | null;
  }): Promise<TriggerProvisionResult> {
    if (!this.#composio.hasKey())
      throw new Error("Composio API key is not configured");
    if (!this.#composio.source().enabled)
      throw new Error("Composio is disabled");

    const account = await this.#resolveAccount(
      input.trigger.source,
      input.trigger.accountId ?? null,
    );
    const body: Record<string, unknown> = {
      user_id: this.#composio.userId(),
      connected_account_id: account.connectedAccountId,
      trigger_config: input.trigger.config ?? {},
    };
    if (input.trigger.mode === "webhook" || input.trigger.mode === "poll")
      body.type = input.trigger.mode;
    if (
      typeof input.trigger.pollingIntervalMinutes === "number" &&
      Number.isInteger(input.trigger.pollingIntervalMinutes) &&
      input.trigger.pollingIntervalMinutes > 0
    ) {
      body.polling_interval = input.trigger.pollingIntervalMinutes;
    }

    const res = await this.#composio.triggerRequest(
      "POST",
      `/api/v3.1/trigger_instances/${encodeURIComponent(input.trigger.trigger)}/upsert`,
      { body },
    );

    const payload = isPlain(res) && isPlain(res.data) ? res.data : res;
    let instanceId = isPlain(payload)
      ? (nonEmpty(payload.trigger_id) ??
        nonEmpty(payload.triggerId) ??
        nonEmpty(payload.id))
      : null;
    if (instanceId === null && isPlain(res)) {
      instanceId = nonEmpty(res.trigger_id) ?? nonEmpty(res.id);
    }
    if (instanceId === null) {
      // HTTP 204 returns an empty object from `triggerRequest`: reuse existing or look up active.
      instanceId =
        input.existingInstanceId ??
        (await this.#findInstanceId(
          input.trigger.trigger,
          account.connectedAccountId,
        ));
    }
    if (instanceId === null || !SAFE_ID.test(instanceId)) {
      throw new Error(
        "Composio did not return a trigger instance id from upsert",
      );
    }

    let mode = isPlain(payload) ? modeOf(payload.type) : null;
    let pollingIntervalMinutes = isPlain(payload)
      ? intOrNull(payload.polling_interval)
      : null;
    const fallbackReason =
      isPlain(payload) && typeof payload.fallback_reason === "string"
        ? payload.fallback_reason.trim() || null
        : null;

    if (!input.enabled) {
      await this.setEnabled(instanceId, false);
    } else if (mode === null) {
      mode = input.trigger.mode ?? null;
    }
    if (pollingIntervalMinutes === null) {
      pollingIntervalMinutes = input.trigger.pollingIntervalMinutes ?? null;
    }

    this.#refused = false;
    this.#streamError = null;
    this.syncBindings();

    return {
      instanceId,
      accountId: account.connectedAccountId,
      mode,
      pollingIntervalMinutes,
      fallbackReason,
      active: input.enabled,
    };
  }

  async setEnabled(instanceId: string, enabled: boolean): Promise<void> {
    if (!SAFE_ID.test(instanceId))
      throw new Error("invalid Composio trigger instance id");
    try {
      await this.#composio.triggerRequest(
        "PATCH",
        `/api/v3.1/trigger_instances/manage/${encodeURIComponent(instanceId)}`,
        {
          body: {
            status: enabled ? "enable" : "disable",
            user_id: this.#composio.userId(),
          },
        },
      );
    } catch (error) {
      // 409 can mean the instance is already in the target enable/disable state.
      if (error instanceof ComposioTriggerError && error.status === 409) {
        const existing = await this.#lookupInstance(instanceId);
        if (
          existing !== undefined &&
          (existing.disabled_at === null) === enabled
        ) {
          this.syncBindings();
          return;
        }
      }
      throw error;
    }
    this.syncBindings();
  }

  async deleteInstance(instanceId: string): Promise<void> {
    if (!SAFE_ID.test(instanceId)) return;
    try {
      await this.#composio.triggerRequest(
        "DELETE",
        `/api/v3.1/trigger_instances/manage/${encodeURIComponent(instanceId)}`,
      );
    } catch (error) {
      // Deleting an already-removed instance should stay idempotent.
      if (
        error instanceof ComposioTriggerError &&
        (error.status === 404 || error.status === 409 || error.status === 410)
      ) {
        this.syncBindings();
        return;
      }
      throw error;
    }
    this.syncBindings();
  }

  async #resolveAccount(
    sourceSlug: string,
    explicitAccountId: string | null,
  ): Promise<ComposioConnectedAccount> {
    const res = await this.#composio.connectedAccounts();
    if (res.status === "needs_key")
      throw new Error("Composio API key is not configured");
    if (res.status === "key_rejected")
      throw new Error("Composio refused the API key");
    if (res.status !== "ready")
      throw new Error("could not read connected accounts from Composio");

    const matching = res.accounts.filter((a) => a.slug === sourceSlug);
    if (explicitAccountId !== null) {
      const exact = matching.find(
        (a) => a.connectedAccountId === explicitAccountId,
      );
      if (exact === undefined)
        throw new Error(
          `connected account ${explicitAccountId} is not active for ${sourceSlug}`,
        );
      return exact;
    }
    if (matching.length === 0)
      throw new Error(
        `no active connected account for ${sourceSlug}; connect it first`,
      );
    if (matching.length > 1)
      throw new Error(
        `multiple active connected accounts for ${sourceSlug}; specify accountId (${matching.map((a) => a.connectedAccountId).join(", ")})`,
      );
    return matching[0]!;
  }

  async #findInstanceId(
    triggerSlug: string,
    connectedAccountId: string,
  ): Promise<string | null> {
    const query = new URLSearchParams({
      user_ids: this.#composio.userId(),
      trigger_names: triggerSlug,
      connected_account_ids: connectedAccountId,
      show_disabled: "true",
      limit: String(TRIGGERS_PAGE_LIMIT),
    });
    const body = await this.#composio.triggerRequest(
      "GET",
      `/api/v3.1/trigger_instances/active?${query}`,
    );
    if (!isPlain(body) || !Array.isArray(body.items)) return null;
    for (const item of body.items) {
      if (!isPlain(item)) continue;
      const id = nonEmpty(item.id);
      if (id !== null && SAFE_ID.test(id)) return id;
    }
    return null;
  }

  async #lookupInstance(
    instanceId: string,
  ): Promise<Record<string, unknown> | undefined> {
    let cursor: string | null = null;
    for (let page = 1; page <= MAX_ACTIVE_PAGES; page++) {
      const query = new URLSearchParams({
        user_ids: this.#composio.userId(),
        trigger_ids: instanceId,
        show_disabled: "true",
        limit: String(TRIGGERS_PAGE_LIMIT),
      });
      if (cursor !== null) query.set("cursor", cursor);
      const body = await this.#composio.triggerRequest(
        "GET",
        `/api/v3.1/trigger_instances/active?${query}`,
      );
      if (!isPlain(body) || !Array.isArray(body.items)) return undefined;
      for (const item of body.items) {
        if (isPlain(item) && item.id === instanceId) return item;
      }
      const next: unknown = body.next_cursor;
      if (typeof next !== "string" || next === "" || body.items.length === 0)
        return undefined;
      if (next === cursor) return undefined;
      cursor = next;
    }
    return undefined;
  }

  /* ---------------------------------------------------------- WS lifecycle */

  start(host: TriggerProviderHost): void {
    this.#host = host;
    this.#stopped = false;
    this.#started = true;
    this.#unlistenContext?.();
    this.#unlistenContext = this.#composio.onTriggerContextChange((reason) => {
      this.#catalogCache = undefined;
      this.#refused = false;
      this.#lastApiError = undefined;
      if (reason === "auth") {
        this.#streamError = null;
        this.#reconnectAttempt = 0;
        // Tear down any existing socket on key/toggle change so stale credentials never linger.
        this.#disconnectSocket();
        this.syncBindings();
      } else if (
        this.#ws === undefined &&
        !this.#connecting &&
        this.#reconnectTimer === undefined
      ) {
        this.#streamError = null;
        this.syncBindings();
      }
      if (this.#composio.hasKey() && this.#composio.source().enabled) {
        this.#host?.onBindingsChanged();
      }
    });
    this.syncBindings();
  }

  syncBindings(): void {
    if (!this.#started || this.#stopped) return;
    if (!this.#shouldConnect()) {
      this.#disconnectSocket();
      this.#refused = false;
      this.#streamError = null;
      return;
    }
    if (this.#refused) return;
    if (
      this.#ws !== undefined ||
      this.#connecting ||
      this.#reconnectTimer !== undefined
    )
      return;
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#started = false;
    this.#unlistenContext?.();
    this.#unlistenContext = undefined;
    this.#disconnectSocket();
  }

  #shouldConnect(): boolean {
    if (!this.#composio.hasKey() || !this.#composio.source().enabled)
      return false;
    const bindings = this.#host?.bindings() ?? [];
    return bindings.some(
      (b) =>
        b.trigger.provider === this.id && b.enabled && b.instanceId !== null,
    );
  }

  async #connect(): Promise<void> {
    const epoch = ++this.#wsEpoch;
    const composioEpoch = this.#composio.triggerEpoch();
    if (this.#stopped || !this.#shouldConnect() || this.#refused) return;
    this.#connecting = true;

    let creds: {
      pusherKey: string;
      pusherCluster: string;
      projectId: string;
    };
    try {
      const raw = await this.#composio.triggerRequest(
        "GET",
        "/api/v3/internal/sdk/realtime/credentials",
        { redactErrorBody: true },
      );
      if (
        this.#stopped ||
        epoch !== this.#wsEpoch ||
        composioEpoch !== this.#composio.triggerEpoch() ||
        !this.#shouldConnect()
      ) {
        if (epoch === this.#wsEpoch) this.#connecting = false;
        return;
      }
      if (!isPlain(raw))
        throw new Error("Composio returned invalid realtime credentials");
      const pusherKey = nonEmpty(raw.pusher_key);
      const pusherCluster = nonEmpty(raw.pusher_cluster);
      const projectId = nonEmpty(raw.project_id);
      if (
        pusherKey === null ||
        !SAFE_ID.test(pusherKey) ||
        pusherCluster === null ||
        !CLUSTER.test(pusherCluster) ||
        projectId === null ||
        !SAFE_ID.test(projectId)
      ) {
        throw new Error("Composio realtime credentials were incomplete");
      }
      creds = { pusherKey, pusherCluster, projectId };
      this.#activeSecrets = [pusherKey];
    } catch (error) {
      if (epoch === this.#wsEpoch) this.#connecting = false;
      if (
        this.#stopped ||
        epoch !== this.#wsEpoch ||
        composioEpoch !== this.#composio.triggerEpoch()
      ) {
        return;
      }
      const message = this.#sanitize(error);
      this.#streamError = message;
      if (error instanceof ComposioTriggerError && error.status === 401) {
        this.#refused = true;
        this.#warn(`[eta] composio realtime credentials rejected: ${message}`);
        return;
      }
      this.#warn(`[eta] composio realtime credentials failed: ${message}`);
      this.#scheduleReconnect("backoff");
      return;
    }

    const wsUrl = this.#buildPusherUrl(creds.pusherCluster, creds.pusherKey);
    const channelName = `private-${creds.projectId}_triggers`;
    this.#channelName = channelName;

    let ws: WebSocket;
    try {
      ws = new this.#WebSocketImpl(wsUrl);
    } catch (error) {
      if (epoch === this.#wsEpoch) this.#connecting = false;
      const message = this.#sanitize(error);
      this.#streamError = message;
      this.#warn(`[eta] composio WebSocket creation failed: ${message}`);
      this.#scheduleReconnect("backoff");
      return;
    }
    this.#ws = ws;
    if (epoch === this.#wsEpoch) this.#connecting = false;

    ws.addEventListener("message", (event) => {
      if (
        this.#stopped ||
        ws !== this.#ws ||
        epoch !== this.#wsEpoch ||
        composioEpoch !== this.#composio.triggerEpoch()
      ) {
        return;
      }
      const raw = typeof event.data === "string" ? event.data : null;
      if (raw === null) return;
      void this.#onFrame(ws, epoch, composioEpoch, channelName, raw);
    });

    ws.addEventListener("error", () => {
      if (ws !== this.#ws || this.#intentionallyClosed.has(ws)) return;
      this.#streamError = "Composio trigger stream connection error";
    });

    ws.addEventListener("close", (event) => {
      this.#clearHeartbeat();
      this.#clearChunks();
      if (ws === this.#ws) this.#ws = undefined;
      if (
        this.#stopped ||
        this.#intentionallyClosed.has(ws) ||
        epoch !== this.#wsEpoch ||
        composioEpoch !== this.#composio.triggerEpoch()
      ) {
        return;
      }
      if (!this.#shouldConnect()) return;

      const action = classifyPusherCloseCode(event.code);
      if (action === "tls_only" || action === "refused") {
        this.#refused = true;
        this.#streamError =
          action === "tls_only"
            ? `Composio trigger stream requires TLS (WS ${event.code})`
            : `Composio trigger stream refused connection (WS ${event.code})`;
        this.#warn(`[eta] ${this.#streamError}`);
        return;
      }
      this.#streamError =
        this.#streamError ??
        `Composio trigger stream closed (WS ${event.code})`;
      this.#scheduleReconnect(action);
    });
  }

  #buildPusherUrl(cluster: string, pusherKey: string): string {
    if (this.#pusherUrl !== undefined) {
      const url = new URL(this.#pusherUrl);
      if (url.pathname === "" || url.pathname === "/") {
        url.pathname = `/app/${encodeURIComponent(pusherKey)}`;
      }
      url.searchParams.set("protocol", "7");
      url.searchParams.set("client", "js");
      url.searchParams.set("version", "8.6.0");
      url.searchParams.set("flash", "false");
      return url.toString();
    }
    return `wss://ws-${cluster}.pusher.com/app/${encodeURIComponent(pusherKey)}?protocol=7&client=js&version=8.6.0&flash=false`;
  }

  async #onFrame(
    ws: WebSocket,
    epoch: number,
    composioEpoch: number,
    channelName: string,
    raw: string,
  ): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isPlain(frame) || typeof frame.event !== "string") return;

    this.#resetActivityTimer(ws, epoch);

    switch (frame.event) {
      case "pusher:connection_established": {
        const established = parseJsonIfString(frame.data);
        if (!isPlain(established)) return;
        const socketId = nonEmpty(established.socket_id);
        if (socketId === null || socketId.length > 100) return;
        this.#serverActivityMs =
          typeof established.activity_timeout === "number" &&
          Number.isFinite(established.activity_timeout) &&
          established.activity_timeout > 0
            ? established.activity_timeout * 1000
            : DEFAULT_ACTIVITY_TIMEOUT_MS;
        this.#resetActivityTimer(ws, epoch);
        await this.#authorizeAndSubscribe(
          ws,
          epoch,
          composioEpoch,
          channelName,
          socketId,
        );
        return;
      }
      case "pusher_internal:subscription_succeeded":
      case "pusher:subscription_succeeded": {
        if (
          typeof frame.channel === "string" &&
          frame.channel !== channelName
        ) {
          return;
        }
        this.#reconnectAttempt = 0;
        this.#refused = false;
        this.#streamError = null;
        return;
      }
      case "pusher:ping": {
        this.#sendFrame(ws, { event: "pusher:pong", data: {} });
        return;
      }
      case "pusher:pong": {
        this.#clearPongTimer();
        return;
      }
      case "pusher:error": {
        const errData = parseJsonIfString(frame.data);
        const code =
          isPlain(errData) && typeof errData.code === "number"
            ? errData.code
            : null;
        const msg =
          isPlain(errData) && typeof errData.message === "string"
            ? this.#sanitize(errData.message)
            : "Pusher stream error";
        this.#streamError = code === null ? msg : `${msg} (${code})`;
        this.#warn(`[eta] composio pusher error: ${this.#streamError}`);
        if (code !== null) {
          const action = classifyPusherCloseCode(code);
          if (action === "tls_only" || action === "refused") {
            this.#refused = true;
            this.#intentionallyClosed.add(ws);
            try {
              ws.close(4001, "refused");
            } catch {
              // Ignore socket close error.
            }
          }
        }
        return;
      }
      case "trigger_to_client": {
        if (
          typeof frame.channel === "string" &&
          frame.channel !== channelName
        ) {
          return;
        }
        this.#handleTriggerData(frame.data);
        return;
      }
      case "chunked-trigger_to_client": {
        if (
          typeof frame.channel === "string" &&
          frame.channel !== channelName
        ) {
          return;
        }
        this.#handleChunk(frame.data);
        break;
      }
      default:
        break;
    }
  }

  async #authorizeAndSubscribe(
    ws: WebSocket,
    epoch: number,
    composioEpoch: number,
    channelName: string,
    socketId: string,
  ): Promise<void> {
    const stale = () =>
      this.#stopped ||
      ws !== this.#ws ||
      epoch !== this.#wsEpoch ||
      composioEpoch !== this.#composio.triggerEpoch() ||
      !this.#shouldConnect() ||
      ws.readyState !== WebSocket.OPEN;

    if (stale()) return;

    let authResp: unknown;
    try {
      authResp = await this.#composio.triggerRequest(
        "POST",
        "/api/v3/internal/sdk/realtime/auth",
        {
          formBody: new URLSearchParams({
            socket_id: socketId,
            channel_name: channelName,
          }).toString(),
          redactErrorBody: true,
        },
      );
    } catch (error) {
      if (stale()) return;
      const message = this.#sanitize(error);
      this.#streamError = message;
      if (
        error instanceof ComposioTriggerError &&
        (error.status === 401 || error.status === 403)
      ) {
        this.#refused = true;
      }
      this.#warn(`[eta] composio realtime channel auth failed: ${message}`);
      try {
        ws.close(4200, "auth failed");
      } catch {
        // Ignore close error.
      }
      return;
    }

    if (stale()) return;
    if (
      !isPlain(authResp) ||
      typeof authResp.auth !== "string" ||
      authResp.auth === ""
    ) {
      this.#streamError = "Composio returned an invalid realtime channel auth";
      try {
        ws.close(4200, "invalid auth");
      } catch {
        // Ignore close error.
      }
      return;
    }

    // Track auth & channel_data strictly for sanitization only.
    this.#activeSecrets.push(authResp.auth);
    if (
      typeof authResp.channel_data === "string" &&
      authResp.channel_data !== ""
    )
      this.#activeSecrets.push(authResp.channel_data);

    // Strictly forward `channel_data` verbatim whenever Composio returns it.
    const subscribeData: Record<string, unknown> = {
      channel: channelName,
      auth: authResp.auth,
    };
    if (authResp.channel_data !== undefined) {
      subscribeData.channel_data = authResp.channel_data;
    }
    this.#sendFrame(ws, {
      event: "pusher:subscribe",
      data: subscribeData,
    });
  }

  #handleChunk(rawData: unknown): void {
    const chunkObj = parseJsonIfString(rawData);
    if (!isPlain(chunkObj)) return;
    const id = nonEmpty(chunkObj.id);
    const index = chunkObj.index;
    const part = chunkObj.chunk;
    if (
      id === null ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 1000 ||
      typeof part !== "string"
    ) {
      return;
    }

    let buf = this.#chunks.get(id);
    if (buf === undefined) {
      if (this.#chunks.size >= MAX_INCOMPLETE_CHUNKS) {
        const oldestKey = this.#chunks.keys().next().value;
        if (oldestKey !== undefined) this.#dropChunk(oldestKey);
      }
      const timer = setTimeout(() => {
        this.#chunks.delete(id);
      }, this.#chunkTimeoutMs);
      timer.unref?.();
      buf = {
        parts: new Map<number, string>(),
        finalIndex: undefined,
        bytes: 0,
        timer,
      };
      this.#chunks.set(id, buf);
    } else {
      clearTimeout(buf.timer);
      buf.timer = setTimeout(() => {
        this.#chunks.delete(id);
      }, this.#chunkTimeoutMs);
      buf.timer.unref?.();
    }

    const partBytes = Buffer.byteLength(part, "utf8");
    const prevPart = buf.parts.get(index);
    const prevBytes =
      prevPart === undefined ? 0 : Buffer.byteLength(prevPart, "utf8");
    const nextBytes = buf.bytes - prevBytes + partBytes;
    if (nextBytes > MAX_CHUNK_BYTES) {
      this.#dropChunk(id);
      this.#warn("[eta] dropped oversized chunked composio trigger payload");
      return;
    }
    buf.bytes = nextBytes;
    buf.parts.set(index, part);
    if (chunkObj.final === true) {
      buf.finalIndex = index;
    }

    if (buf.finalIndex === undefined || buf.parts.size < buf.finalIndex + 1) {
      return;
    }

    const ordered: string[] = [];
    for (let i = 0; i <= buf.finalIndex; i++) {
      const piece = buf.parts.get(i);
      if (piece === undefined) return;
      ordered.push(piece);
    }
    this.#dropChunk(id);
    const assembled = ordered.join("");
    try {
      const parsed = JSON.parse(assembled) as unknown;
      this.#handleTriggerData(parsed);
    } catch {
      this.#warn(
        "[eta] failed to parse assembled chunked composio trigger payload",
      );
    }
  }

  #dropChunk(id: string): void {
    const buf = this.#chunks.get(id);
    if (buf === undefined) return;
    clearTimeout(buf.timer);
    this.#chunks.delete(id);
  }

  #clearChunks(): void {
    for (const buf of this.#chunks.values()) clearTimeout(buf.timer);
    this.#chunks.clear();
  }

  #handleTriggerData(rawData: unknown): void {
    const parsed = parseComposioTriggerEvent(rawData, this.#now());
    if (parsed === null) return;

    // Because `private-${project_id}_triggers` is project-wide, filter out events belonging to
    // another host `user_id` unless the trigger instance id explicitly matches one of ours.
    const bindings = this.#host?.bindings() ?? [];
    const matchedByInstance =
      parsed.instanceId !== null &&
      bindings.some(
        (b) =>
          b.trigger.provider === this.id && b.instanceId === parsed.instanceId,
      );
    if (
      !matchedByInstance &&
      parsed.userId !== null &&
      parsed.userId !== this.#composio.userId()
    ) {
      return;
    }

    this.#host?.onEvent({
      provider: this.id,
      instanceId: parsed.instanceId,
      triggerSlug: parsed.triggerSlug,
      source: parsed.source,
      accountId: parsed.accountId,
      eventId: parsed.eventId,
      occurredAt: parsed.occurredAt,
      payload: parsed.payload,
    });
  }

  #resetActivityTimer(ws: WebSocket, epoch: number): void {
    if (this.#activityTimer !== undefined) clearTimeout(this.#activityTimer);
    const baseMs =
      this.#activityTimeoutOverrideMs ??
      Math.min(DEFAULT_ACTIVITY_TIMEOUT_MS, this.#serverActivityMs);
    const delayMs = Math.max(25, baseMs);
    const timer = setTimeout(() => {
      this.#activityTimer = undefined;
      if (
        this.#stopped ||
        ws !== this.#ws ||
        epoch !== this.#wsEpoch ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      this.#sendFrame(ws, { event: "pusher:ping", data: {} });
      this.#clearPongTimer();
      const pongTimer = setTimeout(() => {
        this.#pongTimer = undefined;
        if (this.#stopped || ws !== this.#ws || epoch !== this.#wsEpoch) return;
        this.#warn("[eta] composio trigger stream pong timeout; reconnecting");
        this.#streamError = "Composio trigger stream pong timeout";
        try {
          ws.close(4200, "pong timeout");
        } catch {
          // Ignore close errors.
        }
      }, this.#pongTimeoutMs);
      pongTimer.unref?.();
      this.#pongTimer = pongTimer;
    }, delayMs);
    timer.unref?.();
    this.#activityTimer = timer;
  }

  #clearPongTimer(): void {
    if (this.#pongTimer !== undefined) {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = undefined;
    }
  }

  #clearHeartbeat(): void {
    if (this.#activityTimer !== undefined) {
      clearTimeout(this.#activityTimer);
      this.#activityTimer = undefined;
    }
    this.#clearPongTimer();
  }

  #scheduleReconnect(action: "retry" | "backoff"): void {
    if (this.#stopped || this.#refused || !this.#shouldConnect()) return;
    if (this.#reconnectTimer !== undefined) return;
    const attempt = this.#reconnectAttempt++;
    let delayMs: number;
    if (action === "retry" && attempt === 0) {
      delayMs = 0;
    } else {
      const exp = Math.min(
        this.#reconnectMaxMs,
        this.#reconnectBaseMs * 2 ** Math.min(attempt, 10),
      );
      delayMs = Math.max(10, Math.round(exp * (0.75 + 0.5 * Math.random())));
    }
    const timer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.syncBindings();
    }, delayMs);
    timer.unref?.();
    this.#reconnectTimer = timer;
  }

  #disconnectSocket(): void {
    this.#wsEpoch++;
    this.#connecting = false;
    this.#serverActivityMs = DEFAULT_ACTIVITY_TIMEOUT_MS;
    this.#clearHeartbeat();
    this.#clearChunks();
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const ws = this.#ws;
    this.#ws = undefined;
    this.#channelName = undefined;
    this.#activeSecrets = [];
    if (ws !== undefined) {
      this.#intentionallyClosed.add(ws);
      try {
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close(1000, "client stopped");
        }
      } catch {
        // Ignore close errors.
      }
    }
  }

  #sendFrame(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Close/error listeners handle socket faults.
    }
  }

  #sanitize(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    let text = redactText(raw);
    for (const secret of this.#activeSecrets) {
      if (secret !== "") text = text.split(secret).join("…");
    }
    if (this.#channelName !== undefined) {
      text = text.split(this.#channelName).join("private-…_triggers");
    }
    const clean = text.trim();
    return clean.length <= 300 ? clean : `${clean.slice(0, 299)}…`;
  }
}

/* ------------------------------------------------------------------ helpers */

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseTimestamp(value: unknown, fallbackMs: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallbackMs;
}

function modeOf(value: unknown): "webhook" | "poll" | null {
  return value === "webhook" || value === "poll" ? value : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function groupAccountsBySlug(
  accounts: readonly ComposioConnectedAccount[],
): Map<string, TriggerCatalogAccount[]> {
  const grouped = new Map<string, TriggerCatalogAccount[]>();
  for (const account of accounts) {
    const list = grouped.get(account.slug) ?? [];
    list.push({
      id: account.connectedAccountId,
      label: account.connectedAccountId,
    });
    grouped.set(account.slug, list);
  }
  return grouped;
}

function catalogItemOf(
  entry: unknown,
  toolkitNames: Map<string, string>,
): Omit<TriggerCatalogItem, "accounts"> | null {
  if (!isPlain(entry)) return null;
  const slug = nonEmpty(entry.slug);
  if (slug === null || !TRIGGER_SLUG.test(slug)) return null;
  const toolkitObj = isPlain(entry.toolkit) ? entry.toolkit : null;
  const source =
    (toolkitObj ? nonEmpty(toolkitObj.slug) : null) ??
    nonEmpty(entry.toolkit_slug);
  if (source === null || !SLUG.test(source)) return null;

  const sourceName =
    toolkitNames.get(source) ??
    (toolkitObj ? nonEmpty(toolkitObj.name) : null) ??
    source;
  const name = nonEmpty(entry.name) ?? slug;
  const description =
    typeof entry.description === "string" ? entry.description.trim() : "";

  const typesList = Array.isArray(entry.types)
    ? entry.types.map(modeOf).filter((m): m is "webhook" | "poll" => m !== null)
    : [];
  const legacyMode = modeOf(entry.type);
  const modes =
    typesList.length > 0
      ? [...new Set(typesList)]
      : legacyMode !== null
        ? [legacyMode]
        : [];
  const version = nonEmpty(entry.version);
  const instructions = nonEmpty(entry.instructions);

  return {
    provider: "composio",
    source,
    sourceName,
    trigger: slug,
    name,
    description,
    ...(instructions === null ? {} : { instructions }),
    modes,
    ...(entry.requires_webhook_endpoint_setup === true
      ? { requiresWebhookSetup: true }
      : {}),
    configSchema: isPlain(entry.config) ? entry.config : {},
    payloadSchema: isPlain(entry.payload) ? entry.payload : {},
    ...(version === null ? {} : { version }),
  };
}
