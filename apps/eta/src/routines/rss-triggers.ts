/**
 * Built-in RSS 2.0 / Atom 1.0 / JSON Feed 1.1 polling `TriggerProvider` (`provider = "rss"`).
 *
 * - Zero new dependencies: lightweight stack-based XML parser + JSON Feed 1.1 parser producing a
 *   normalized, HTML-stripped payload within `runPrompt`'s single-event character budget.
 * - Baseline seeding on `provision()`: validates URL & feed format immediately and records
 *   existing entry IDs (`seeded: true`) into `SettingStore` (`rss.trigger.<routineId>`) so
 *   historical articles never fire on creation or after `eta-host` restarts.
 * - SSRF-guarded via `@searxng-js/sex-egress` (`safeFetch`) with live `web.privateNetwork`
 *   updates (`setPrivateNetwork`), conditional HTTP (`ETag` / `Last-Modified`), 2 MiB & 15s caps,
 *   per-routine exponential backoff, and a single `unref()`ed timer for the next due poll.
 */
import type {
  PrivateNetworkConfig,
  RoutineTrigger,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type { PrivateNetworkAccess } from "@searxng-js/sex-egress";
import type { SettingStore } from "../settings/store";
import type {
  TriggerProvider,
  TriggerProviderHost,
  TriggerProvisionResult,
} from "./triggers";
import { createHash } from "node:crypto";
import {
  AppError,
  decodeBody,
  parseHttpUrl,
  safeFetch,
} from "@searxng-js/sex-egress";
import pLimit from "p-limit";
import { blockedHere, privateNetworkAccessOf, proxyFor } from "../web/service";

const RSS_PROVIDER_ID = "rss";
const RSS_SOURCE_SLUG = "feed";
const RSS_SOURCE_NAME = "RSS / Atom / JSON Feed";
const RSS_TRIGGER_SLUG = "RSS_NEW_ITEM";

const DEFAULT_POLL_MINUTES = 15;
const MIN_POLL_MINUTES = 1;
const MAX_POLL_MINUTES = 1440;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SEEN_IDS = 500;
const MAX_SUMMARY_CHARS = 1_500;
const MAX_SLEEP_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 6 * 60 * 60_000;
const POLL_CONCURRENCY = 4;
const SETTING_KEY_PREFIX = "rss.trigger.";
const USER_AGENT = "eta (+https://github.com/0xfe-project/eta)";
const FEED_ACCEPT =
  "application/feed+json, application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5";

export interface RssFeedItemPayload {
  feedTitle: string | null;
  feedUrl: string;
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  summary: string;
}

interface RssParsedItem {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  occurredAt: number | null;
  summary: string;
}

export interface ParsedRssFeed {
  format: "rss" | "atom" | "json";
  title: string | null;
  items: RssParsedItem[];
}

export type RssFetch = (
  url: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface RssTriggerProviderOptions {
  settings: SettingStore;
  fetch?: RssFetch | undefined;
  allowPrivateNetwork?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  now?: (() => number) | undefined;
  timer?: boolean | undefined;
  backoffBaseMs?: number | undefined;
  backoffMaxMs?: number | undefined;
  warn?: ((message: string) => void) | undefined;
}

export interface RssPollSnapshot {
  nextPollAt: number;
  consecutiveFailures: number;
  lastError: string | null;
}

interface ParsedRssConfig {
  url: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  pollingIntervalMinutes: number;
}

interface PersistedRssState {
  feedUrl: string;
  seeded: boolean;
  seenIds: string[];
  etag: string | null;
  lastModified: string | null;
  lastPolledAt: number;
}

interface ArmedRoutine {
  routineId: string;
  instanceId: string;
  key: string;
  config: ParsedRssConfig;
  intervalMs: number;
  nextPollAt: number;
  consecutiveFailures: number;
  lastError: string | null;
  generation: number;
}

const RSS_CATALOG_ITEM: TriggerCatalogItem = {
  provider: RSS_PROVIDER_ID,
  source: RSS_SOURCE_SLUG,
  sourceName: RSS_SOURCE_NAME,
  trigger: RSS_TRIGGER_SLUG,
  name: "New feed item",
  description:
    "Triggers when a new entry is published to an RSS 2.0, Atom 1.0, or JSON Feed 1.1 feed.",
  modes: ["poll"],
  configSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        format: "uri",
        title: "Feed URL",
        description: "RSS 2.0, Atom 1.0, or JSON Feed 1.1 URL (http/https).",
        examples: ["https://example.com/feed.xml"],
      },
      includeKeywords: {
        type: "string",
        title: "Include keywords",
        description:
          "Optional comma-separated keywords (case-insensitive). Item title or summary must match at least one.",
        examples: ["release, security"],
      },
      excludeKeywords: {
        type: "string",
        title: "Exclude keywords",
        description:
          "Optional comma-separated keywords (case-insensitive). Skip items matching any keyword.",
        examples: ["sponsored, digest"],
      },
    },
  },
  payloadSchema: {
    type: "object",
    properties: {
      feedTitle: { type: ["string", "null"] },
      feedUrl: { type: "string" },
      id: { type: "string" },
      title: { type: "string" },
      url: { type: ["string", "null"] },
      author: { type: ["string", "null"] },
      publishedAt: { type: ["string", "null"] },
      summary: { type: "string" },
    },
  },
  accounts: [],
};

export class RssTriggerProvider implements TriggerProvider {
  readonly id = RSS_PROVIDER_ID;

  readonly #settings: SettingStore;
  readonly #customFetch: RssFetch | undefined;
  readonly #allowPrivateNetworkOverride: boolean;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #timed: boolean;
  readonly #backoffBaseMs: number | undefined;
  readonly #backoffMaxMs: number | undefined;
  readonly #warn: (message: string) => void;
  readonly #pollLimit = pLimit(POLL_CONCURRENCY);

  #host: TriggerProviderHost | undefined;
  #started = false;
  #stopped = false;
  #stopController = new AbortController();
  #privateNetwork: PrivateNetworkAccess = false;
  #privateNetworkKey = JSON.stringify(undefined);
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;

  readonly #armed = new Map<string, ArmedRoutine>();
  readonly #inFlightRoutines = new Set<string>();
  readonly #inFlightPromises = new Set<Promise<void>>();

  constructor(options: RssTriggerProviderOptions) {
    this.#settings = options.settings;
    this.#customFetch = options.fetch;
    this.#allowPrivateNetworkOverride = options.allowPrivateNetwork === true;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? MAX_FEED_BYTES;
    this.#now = options.now ?? Date.now;
    this.#timed = options.timer ?? true;
    this.#backoffBaseMs = options.backoffBaseMs;
    this.#backoffMaxMs = options.backoffMaxMs;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  status(): TriggerProviderStatus {
    return { provider: this.id, status: "ready" };
  }

  /** Updates the `web.privateNetwork` allowlist applied to outgoing RSS fetches. */
  setPrivateNetwork(config: PrivateNetworkConfig | undefined): void {
    const next = privateNetworkAccessOf(config);
    if (next.key === this.#privateNetworkKey) return;
    this.#privateNetworkKey = next.key;
    this.#privateNetwork = next.access;
  }

  /** Current in-memory poll schedule and error state for one routine (for diagnostics/tests). */
  pollState(routineId: string): RssPollSnapshot | undefined {
    const armed = this.#armed.get(routineId);
    if (armed === undefined) return undefined;
    return {
      nextPollAt: armed.nextPollAt,
      consecutiveFailures: armed.consecutiveFailures,
      lastError: armed.lastError,
    };
  }

  async listTriggers(filter?: {
    source?: string;
    query?: string;
    refresh?: boolean;
  }): Promise<TriggerCatalogItem[]> {
    const sourceFilter = filter?.source?.trim();
    if (
      sourceFilter !== undefined &&
      sourceFilter !== "" &&
      sourceFilter !== RSS_SOURCE_SLUG
    ) {
      return [];
    }
    const query = filter?.query?.trim().toLowerCase();
    if (query !== undefined && query !== "") {
      const haystack = [
        RSS_CATALOG_ITEM.provider,
        RSS_CATALOG_ITEM.source,
        RSS_CATALOG_ITEM.sourceName,
        RSS_CATALOG_ITEM.trigger,
        RSS_CATALOG_ITEM.name,
        RSS_CATALOG_ITEM.description,
      ]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(query)) return [];
    }
    return [RSS_CATALOG_ITEM];
  }

  async provision(input: {
    routineId: string;
    trigger: RoutineTrigger;
    enabled: boolean;
    existingInstanceId: string | null;
  }): Promise<TriggerProvisionResult> {
    const config = parseRssConfig(input.trigger);
    const fetched = await this.#fetchFeed(config.url);
    if (fetched.status < 200 || fetched.status >= 300) {
      throw new Error(`Feed returned HTTP ${fetched.status}`);
    }
    const parsed = parseRssFeed(fetched.body, config.url, fetched.contentType);
    const presentIds = parsed.items.map((item) => item.id);

    const existing = this.#readState(input.routineId);
    const baseSeen =
      input.existingInstanceId !== null &&
      existing !== undefined &&
      existing.seeded &&
      existing.feedUrl === config.url
        ? existing.seenIds
        : [];
    const seenIds = mergeSeenIds(baseSeen, presentIds);

    this.#writeState(input.routineId, {
      feedUrl: config.url,
      seeded: true,
      seenIds,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      lastPolledAt: this.#now(),
    });

    const instanceId = instanceIdOf(input.routineId);
    // Drop any previous armed entry so recovery via `provision()` clears backoff/error state.
    this.#armed.delete(input.routineId);
    this.syncBindings();
    return {
      instanceId,
      accountId: null,
      mode: "poll",
      pollingIntervalMinutes: config.pollingIntervalMinutes,
      fallbackReason: null,
      active: input.enabled,
    };
  }

  async setEnabled(instanceId: string, enabled: boolean): Promise<void> {
    const routineId = routineIdOf(instanceId);
    if (routineId === null) return;
    if (!enabled) {
      this.#armed.delete(routineId);
      this.#scheduleTimer();
      return;
    }
    const state = this.#readState(routineId);
    if (state === undefined || !state.seeded) {
      throw new Error("RSS trigger state is missing; re-provisioning");
    }
    const armed = this.#armed.get(routineId);
    if (armed !== undefined) {
      armed.consecutiveFailures = 0;
      armed.lastError = null;
      armed.nextPollAt = nextPollTime(
        state.lastPolledAt,
        armed.intervalMs,
        this.#now(),
      );
    }
    this.syncBindings();
  }

  async deleteInstance(instanceId: string): Promise<void> {
    const routineId = routineIdOf(instanceId);
    if (routineId === null) return;
    this.#settings.delete(settingKey(routineId));
    this.#armed.delete(routineId);
    this.#inFlightRoutines.delete(routineId);
    this.#scheduleTimer();
  }

  start(host: TriggerProviderHost): void {
    this.#host = host;
    this.#stopped = false;
    this.#started = true;
    this.#stopController = new AbortController();
    this.syncBindings();
  }

  syncBindings(): void {
    if (!this.#started || this.#stopped) return;
    const now = this.#now();
    const bindings = this.#host?.bindings() ?? [];
    const live = new Set<string>();

    for (const binding of bindings) {
      if (
        binding.trigger.provider !== this.id ||
        !binding.enabled ||
        binding.instanceId === null
      ) {
        continue;
      }
      let config: ParsedRssConfig;
      try {
        config = parseRssConfig(binding.trigger);
      } catch (error) {
        this.#warn(
          `[eta] rss binding ${binding.routineId} has invalid config: ${errorMessage(error)}`,
        );
        continue;
      }
      live.add(binding.routineId);
      const intervalMs = config.pollingIntervalMinutes * 60_000;
      const key = JSON.stringify([
        binding.instanceId,
        config.url,
        config.includeKeywords,
        config.excludeKeywords,
        config.pollingIntervalMinutes,
      ]);
      const existing = this.#armed.get(binding.routineId);
      if (existing !== undefined && existing.key === key) continue;

      const persisted = this.#readState(binding.routineId);
      const lastPolledAt =
        persisted !== undefined && persisted.feedUrl === config.url
          ? persisted.lastPolledAt
          : undefined;
      this.#armed.set(binding.routineId, {
        routineId: binding.routineId,
        instanceId: binding.instanceId,
        key,
        config,
        intervalMs,
        nextPollAt: nextPollTime(lastPolledAt, intervalMs, now),
        consecutiveFailures: 0,
        lastError: null,
        generation: ++this.#generation,
      });
    }

    for (const routineId of this.#armed.keys()) {
      if (!live.has(routineId)) this.#armed.delete(routineId);
    }
    this.#scheduleTimer(now);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#started = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#stopController.abort(new Error("RSS trigger provider stopped"));
    await Promise.allSettled([...this.#inFlightPromises]);
    this.#armed.clear();
    this.#inFlightRoutines.clear();
  }

  /** Polls any currently due bindings once and re-arms the single timer. */
  async tick(): Promise<void> {
    if (!this.#started || this.#stopped) return;
    const now = this.#now();
    const due: ArmedRoutine[] = [];
    for (const armed of this.#armed.values()) {
      if (
        armed.nextPollAt <= now &&
        !this.#inFlightRoutines.has(armed.routineId)
      ) {
        due.push(armed);
      }
    }
    if (due.length > 0) {
      await Promise.allSettled(
        due.map((entry) => {
          this.#inFlightRoutines.add(entry.routineId);
          const task = this.#pollLimit(() => this.#pollOne(entry)).finally(
            () => {
              this.#inFlightRoutines.delete(entry.routineId);
              this.#inFlightPromises.delete(task);
            },
          );
          this.#inFlightPromises.add(task);
          return task;
        }),
      );
    }
    if (!this.#stopped && this.#started) this.#scheduleTimer();
  }

  async #pollOne(entry: ArmedRoutine): Promise<void> {
    const { routineId, generation, config, intervalMs } = entry;
    if (this.#stopped || !this.#isCurrent(routineId, generation)) return;
    const persisted = this.#readState(routineId);
    const sameUrl =
      persisted !== undefined && persisted.feedUrl === config.url
        ? persisted
        : undefined;

    try {
      const fetched = await this.#fetchFeed(config.url, {
        etag: sameUrl?.etag ?? null,
        lastModified: sameUrl?.lastModified ?? null,
      });
      if (this.#stopped || !this.#isCurrent(routineId, generation)) return;

      const now = this.#now();
      if (fetched.status === 304) {
        if (sameUrl !== undefined) {
          this.#writeState(routineId, {
            ...sameUrl,
            etag: fetched.etag ?? sameUrl.etag,
            lastModified: fetched.lastModified ?? sameUrl.lastModified,
            lastPolledAt: now,
          });
        }
        entry.consecutiveFailures = 0;
        entry.lastError = null;
        entry.nextPollAt = now + intervalMs;
        this.#host?.onTriggerRecovered?.(routineId);
        return;
      }

      if (fetched.status < 200 || fetched.status >= 300) {
        throw new Error(`Feed returned HTTP ${fetched.status}`);
      }

      const parsed = parseRssFeed(
        fetched.body,
        config.url,
        fetched.contentType,
      );
      if (this.#stopped || !this.#isCurrent(routineId, generation)) return;

      const presentIds = parsed.items.map((item) => item.id);
      const wasSeeded = sameUrl?.seeded === true;
      const seenSet = new Set(wasSeeded ? sameUrl.seenIds : []);
      const unseenNewestFirst = wasSeeded
        ? parsed.items.filter((item) => !seenSet.has(item.id))
        : [];
      const nextSeenIds = mergeSeenIds(
        wasSeeded ? sameUrl.seenIds : [],
        presentIds,
      );

      this.#writeState(routineId, {
        feedUrl: config.url,
        seeded: true,
        seenIds: nextSeenIds,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        lastPolledAt: now,
      });

      // Emit oldest unseen items first so `RoutineStore` preserves chronological order.
      for (const item of [...unseenNewestFirst].reverse()) {
        if (this.#stopped || !this.#isCurrent(routineId, generation)) return;
        if (
          !matchesKeywords(item, config.includeKeywords, config.excludeKeywords)
        ) {
          continue;
        }
        const payload: RssFeedItemPayload = {
          feedTitle: parsed.title,
          feedUrl: config.url,
          id: item.id,
          title: item.title,
          url: item.url,
          author: item.author,
          publishedAt: item.publishedAt,
          summary: item.summary,
        };
        this.#host?.onEvent({
          provider: RSS_PROVIDER_ID,
          instanceId: entry.instanceId,
          routineId,
          triggerSlug: RSS_TRIGGER_SLUG,
          source: RSS_SOURCE_SLUG,
          accountId: null,
          eventId: item.id,
          occurredAt: item.occurredAt ?? now,
          payload,
        });
      }

      entry.consecutiveFailures = 0;
      entry.lastError = null;
      entry.nextPollAt = now + intervalMs;
      this.#host?.onTriggerRecovered?.(routineId);
    } catch (error) {
      if (this.#stopped || this.#stopController.signal.aborted) return;
      if (!this.#isCurrent(routineId, generation)) return;

      const now = this.#now();
      const message = errorMessage(error);
      entry.consecutiveFailures += 1;
      entry.lastError = message;
      entry.nextPollAt =
        now +
        backoffDelayMs(
          entry.consecutiveFailures,
          intervalMs,
          this.#backoffBaseMs,
          this.#backoffMaxMs,
        );
      this.#warn(
        `[eta] rss poll failed for routine ${routineId} (${config.url}): ${message}`,
      );
      this.#host?.onTriggerError?.(routineId, message);
    }
  }

  #isCurrent(routineId: string, generation: number): boolean {
    return this.#armed.get(routineId)?.generation === generation;
  }

  #scheduleTimer(now = this.#now()): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#started || this.#stopped || !this.#timed) return;

    let soonest = Infinity;
    for (const armed of this.#armed.values()) {
      if (this.#inFlightRoutines.has(armed.routineId)) continue;
      if (armed.nextPollAt < soonest) soonest = armed.nextPollAt;
    }
    if (!Number.isFinite(soonest)) return;

    const wait = Math.min(MAX_SLEEP_MS, Math.max(1, soonest - now));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.tick().catch((error: unknown) => {
        this.#warn(`[eta] rss polling loop failed: ${errorMessage(error)}`);
        this.#scheduleTimer();
      });
    }, wait);
    this.#timer.unref?.();
  }

  async #fetchFeed(
    rawUrl: string,
    conditional?: { etag?: string | null; lastModified?: string | null },
  ): Promise<{
    status: number;
    contentType: string;
    body: Uint8Array;
    etag: string | null;
    lastModified: string | null;
  }> {
    const parsedUrl = parseHttpUrl(rawUrl);
    const headers: Record<string, string> = {
      accept: FEED_ACCEPT,
    };
    if (conditional?.etag) headers["if-none-match"] = conditional.etag;
    if (conditional?.lastModified) {
      headers["if-modified-since"] = conditional.lastModified;
    }

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([
      timeoutSignal,
      this.#stopController.signal,
    ]);

    if (this.#customFetch !== undefined) {
      const abortError = (): Error => {
        if (
          timeoutSignal.aborted &&
          timeoutSignal.reason instanceof Error &&
          timeoutSignal.reason.name === "TimeoutError"
        ) {
          return new Error(`Timed out while fetching ${parsedUrl.href}`);
        }
        return signal.reason instanceof Error
          ? signal.reason
          : new Error(`Aborted while fetching ${parsedUrl.href}`);
      };
      try {
        const response = await raceAbort(
          this.#customFetch(parsedUrl.href, {
            headers: {
              "user-agent": USER_AGENT,
              ...headers,
            },
            signal,
          }),
          signal,
          abortError,
        );
        const body =
          response.status === 304
            ? new Uint8Array()
            : await raceAbort(
                readLimitedBody(response, signal, this.#maxBytes),
                signal,
                abortError,
              );
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          body,
          etag: headerValue(response.headers, "etag"),
          lastModified: headerValue(response.headers, "last-modified"),
        };
      } catch (error) {
        if (signal.aborted) throw abortError();
        throw error;
      }
    }

    try {
      const response = await safeFetch(parsedUrl.href, {
        headers,
        signal,
        allowPrivateNetwork: this.#allowPrivateNetworkOverride
          ? true
          : this.#privateNetwork,
        proxy: proxyFor(parsedUrl.href),
        userAgent: USER_AGENT,
        maxBodyBytes: this.#maxBytes,
      });
      return {
        status: response.status,
        contentType: response.contentType,
        body: response.body,
        etag: headerValue(response.headers, "etag"),
        lastModified: headerValue(response.headers, "last-modified"),
      };
    } catch (error) {
      throw blockedHere(error);
    }
  }

  #readState(routineId: string): PersistedRssState | undefined {
    const raw = this.#settings.get(settingKey(routineId));
    if (!isPlain(raw)) return undefined;
    if (typeof raw.feedUrl !== "string" || raw.feedUrl === "") return undefined;
    const seenIds = Array.isArray(raw.seenIds)
      ? raw.seenIds
          .filter(
            (item): item is string => typeof item === "string" && item !== "",
          )
          .slice(-MAX_SEEN_IDS)
      : [];
    return {
      feedUrl: raw.feedUrl,
      seeded: raw.seeded === true,
      seenIds,
      etag: typeof raw.etag === "string" && raw.etag !== "" ? raw.etag : null,
      lastModified:
        typeof raw.lastModified === "string" && raw.lastModified !== ""
          ? raw.lastModified
          : null,
      lastPolledAt:
        typeof raw.lastPolledAt === "number" &&
        Number.isFinite(raw.lastPolledAt)
          ? raw.lastPolledAt
          : this.#now(),
    };
  }

  #writeState(routineId: string, state: PersistedRssState): void {
    this.#settings.set(settingKey(routineId), state);
  }
}

/* ---------------------------------------------------------- config & state */

function parseRssConfig(trigger: RoutineTrigger): ParsedRssConfig {
  if (trigger.source !== RSS_SOURCE_SLUG) {
    throw new Error(`RSS trigger source must be "${RSS_SOURCE_SLUG}"`);
  }
  if (trigger.trigger !== RSS_TRIGGER_SLUG) {
    throw new Error(`RSS trigger slug must be "${RSS_TRIGGER_SLUG}"`);
  }
  if (
    trigger.mode !== undefined &&
    trigger.mode !== null &&
    trigger.mode !== "poll"
  ) {
    throw new Error('RSS trigger only supports "poll" mode');
  }

  const rawPolling = trigger.pollingIntervalMinutes;
  let pollingIntervalMinutes = DEFAULT_POLL_MINUTES;
  if (rawPolling !== undefined && rawPolling !== null) {
    if (
      typeof rawPolling !== "number" ||
      !Number.isInteger(rawPolling) ||
      rawPolling < MIN_POLL_MINUTES ||
      rawPolling > MAX_POLL_MINUTES
    ) {
      throw new Error(
        `RSS pollingIntervalMinutes must be an integer between ${MIN_POLL_MINUTES} and ${MAX_POLL_MINUTES}`,
      );
    }
    pollingIntervalMinutes = rawPolling;
  }

  const cfg = isPlain(trigger.config) ? trigger.config : {};
  const rawUrl = typeof cfg.url === "string" ? cfg.url.trim() : "";
  if (rawUrl === "") {
    throw new Error("RSS feed URL is required (config.url)");
  }
  const validatedUrl = parseHttpUrl(rawUrl).href;

  return {
    url: validatedUrl,
    includeKeywords: parseKeywords(cfg.includeKeywords, "includeKeywords"),
    excludeKeywords: parseKeywords(cfg.excludeKeywords, "excludeKeywords"),
    pollingIntervalMinutes,
  };
}

function parseKeywords(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string") {
    throw new TypeError(`RSS config.${field} must be a string`);
  }
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
}

function matchesKeywords(
  item: RssParsedItem,
  includeKeywords: readonly string[],
  excludeKeywords: readonly string[],
): boolean {
  const haystack = `${item.title}\n${item.summary}`.toLowerCase();
  if (
    includeKeywords.length > 0 &&
    !includeKeywords.some((kw) => haystack.includes(kw))
  ) {
    return false;
  }
  if (
    excludeKeywords.length > 0 &&
    excludeKeywords.some((kw) => haystack.includes(kw))
  ) {
    return false;
  }
  return true;
}

function mergeSeenIds(
  existing: readonly string[],
  presentNewestFirst: readonly string[],
  cap = MAX_SEEN_IDS,
): string[] {
  const presentUnique: string[] = [];
  const presentSet = new Set<string>();
  for (const id of presentNewestFirst) {
    if (id === "" || presentSet.has(id)) continue;
    presentSet.add(id);
    presentUnique.push(id);
  }
  // Keep items still present in the feed at the newest end of the window so pinned entries stay seen.
  const retainedOld = existing.filter((id) => id !== "" && !presentSet.has(id));
  const presentOldestFirst = [...presentUnique].reverse();
  const combined = [...retainedOld, ...presentOldestFirst];
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function nextPollTime(
  lastPolledAt: number | undefined,
  intervalMs: number,
  now: number,
): number {
  if (lastPolledAt === undefined || !Number.isFinite(lastPolledAt)) {
    return now + intervalMs;
  }
  const clamped = Math.min(lastPolledAt, now);
  return Math.max(now, clamped + intervalMs);
}

function backoffDelayMs(
  failures: number,
  intervalMs: number,
  baseOverride?: number,
  maxOverride?: number,
): number {
  const base = baseOverride ?? intervalMs * 2;
  const max = maxOverride ?? Math.max(intervalMs, DEFAULT_BACKOFF_MAX_MS);
  const scaled = base * 2 ** Math.max(0, failures - 1);
  return Math.min(max, Math.max(1, scaled));
}

function settingKey(routineId: string): string {
  return `${SETTING_KEY_PREFIX}${routineId}`;
}

function instanceIdOf(routineId: string): string {
  return `${RSS_PROVIDER_ID}:${routineId}`;
}

function routineIdOf(instanceId: string): string | null {
  const prefix = `${RSS_PROVIDER_ID}:`;
  if (!instanceId.startsWith(prefix)) return null;
  const id = instanceId.slice(prefix.length).trim();
  return id === "" ? null : id;
}

/* ----------------------------------------------------------- HTTP helpers */

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  makeError: () => Error,
): Promise<T> {
  if (signal.aborted) throw makeError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(makeError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readLimitedBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError(
          "RESPONSE_TOO_LARGE",
          `Response body exceeds ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function headerValue(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim() ?? "";
  return value === "" ? null : value;
}

/* ------------------------------------------------------------ feed parsing */

/** Parses RSS 2.0, Atom 1.0, or JSON Feed 1.1 into normalized feed items. */
export function parseRssFeed(
  rawBody: Uint8Array | string,
  feedUrl: string,
  contentType = "",
): ParsedRssFeed {
  const text =
    typeof rawBody === "string"
      ? stripBom(rawBody)
      : decodeFeedBody(rawBody, contentType);
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("Feed response is empty");
  }

  const looksJson = /json/i.test(contentType) || trimmed.startsWith("{");
  if (looksJson) {
    return parseJsonFeed(trimmed, feedUrl);
  }

  const root = parseXml(trimmed);
  const rootName = root.localName.toLowerCase();
  if (rootName === "rss") {
    return parseRssXmlFeed(root, feedUrl);
  }
  if (rootName === "feed") {
    return parseAtomXmlFeed(root, feedUrl);
  }
  if (rootName === "rdf" && directChild(root, "channel") !== undefined) {
    return parseRssXmlFeed(root, feedUrl);
  }
  throw new Error("Response is not a valid RSS, Atom, or JSON Feed");
}

function decodeFeedBody(body: Uint8Array, contentType: string): string {
  let effectiveType = contentType;
  if (!/charset=/i.test(effectiveType)) {
    const head = new TextDecoder("latin1").decode(body.subarray(0, 512));
    const xmlEnc = /<\?xml[^>]+encoding=["']([\w-]+)["']/i.exec(head)?.[1];
    if (xmlEnc) effectiveType = `${effectiveType}; charset=${xmlEnc}`;
  }
  return stripBom(decodeBody(body, effectiveType));
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function parseJsonFeed(text: string, feedUrl: string): ParsedRssFeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON Feed payload");
  }
  if (!isPlain(parsed)) {
    throw new TypeError("Response is not a valid JSON Feed");
  }
  if (parsed.version !== undefined) {
    if (typeof parsed.version !== "string") {
      throw new TypeError("JSON Feed version must be a string");
    }
    if (!/jsonfeed\.org\/version\//i.test(parsed.version)) {
      throw new Error("Unsupported JSON Feed version");
    }
  } else if (typeof parsed.title !== "string") {
    throw new TypeError("Response is not a valid JSON Feed");
  }
  if (!Array.isArray(parsed.items)) {
    throw new TypeError("JSON Feed is missing items array");
  }

  const feedTitle =
    typeof parsed.title === "string"
      ? cleanHtmlText(parsed.title) || null
      : null;
  const feedAuthor = jsonFeedAuthors(parsed.authors, parsed.author);
  const items: RssParsedItem[] = [];
  const seen = new Set<string>();

  for (const entry of parsed.items) {
    if (!isPlain(entry)) {
      throw new Error("JSON Feed contains a non-object item");
    }
    const title =
      typeof entry.title === "string" ? cleanHtmlText(entry.title) : "";
    const explicitId =
      typeof entry.id === "string"
        ? entry.id.trim()
        : typeof entry.id === "number"
          ? String(entry.id)
          : "";
    const rawUrl =
      nonEmptyString(entry.url) ?? nonEmptyString(entry.external_url) ?? "";
    const url = resolveHttpUrl(rawUrl, feedUrl);
    const author =
      jsonFeedAuthors(entry.authors, entry.author) ?? feedAuthor ?? null;
    const rawDate =
      nonEmptyString(entry.date_published) ??
      nonEmptyString(entry.date_modified) ??
      "";
    const { publishedAt, occurredAt } = normalizeDate(rawDate);
    const rawSummary =
      nonEmptyString(entry.summary) ??
      nonEmptyString(entry.content_text) ??
      nonEmptyString(entry.content_html) ??
      "";
    const summary = truncateSummary(cleanHtmlText(rawSummary));
    const id = itemDedupeId(explicitId, url ?? rawUrl, title, publishedAt);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      title,
      url,
      author,
      publishedAt,
      occurredAt,
      summary,
    });
  }

  return { format: "json", title: feedTitle, items };
}

function jsonFeedAuthors(
  authorsRaw: unknown,
  authorRaw: unknown,
): string | null {
  const names: string[] = [];
  if (Array.isArray(authorsRaw)) {
    for (const entry of authorsRaw) {
      if (isPlain(entry) && typeof entry.name === "string") {
        const cleaned = cleanHtmlText(entry.name);
        if (cleaned !== "") names.push(cleaned);
      }
    }
  }
  if (
    names.length === 0 &&
    isPlain(authorRaw) &&
    typeof authorRaw.name === "string"
  ) {
    const cleaned = cleanHtmlText(authorRaw.name);
    if (cleaned !== "") names.push(cleaned);
  }
  return names.length > 0 ? names.join(", ") : null;
}

function parseRssXmlFeed(root: XmlNode, feedUrl: string): ParsedRssFeed {
  const channel = directChild(root, "channel");
  if (channel === undefined) {
    throw new Error("RSS feed is missing <channel>");
  }
  const titleNode = directChild(channel, "title");
  const feedTitle =
    titleNode !== undefined ? cleanHtmlText(nodeText(titleNode)) || null : null;

  const rawItems = [
    ...directChildren(channel, "item"),
    ...(root.localName.toLowerCase() === "rdf"
      ? directChildren(root, "item")
      : []),
  ];
  const items: RssParsedItem[] = [];
  const seen = new Set<string>();

  for (const itemNode of rawItems) {
    const title = cleanHtmlText(childText(itemNode, "title"));
    const guidNode = directChild(itemNode, "guid");
    const guid = guidNode ? nodeText(guidNode).trim() : "";
    const isPermaLink = guidNode?.attrs.isPermaLink?.toLowerCase() !== "false";

    const rawLink =
      childText(itemNode, "link").trim() || atomEntryLink(itemNode);
    const fallbackLink =
      rawLink === "" && guid !== "" && isPermaLink && /^https?:\/\//i.test(guid)
        ? guid
        : "";
    const linkCandidate = rawLink || fallbackLink;
    const url = resolveHttpUrl(linkCandidate, feedUrl);

    const creatorText = cleanHtmlText(
      childTextByExactOrLocal(itemNode, "dc:creator", "creator"),
    );
    const authorNode = directChild(itemNode, "author");
    const authorNameNode = authorNode
      ? directChild(authorNode, "name")
      : undefined;
    const authorText = cleanHtmlText(
      authorNameNode
        ? nodeText(authorNameNode)
        : authorNode
          ? nodeText(authorNode)
          : "",
    );
    const author = creatorText || authorText || null;

    const rawDate = (
      childText(itemNode, "pubDate") ||
      childTextByExactOrLocal(itemNode, "dc:date", "date") ||
      childText(itemNode, "published") ||
      childText(itemNode, "updated")
    ).trim();
    const { publishedAt, occurredAt } = normalizeDate(rawDate);

    const cleanedSummary =
      cleanHtmlText(
        childTextByExactOrLocal(itemNode, "content:encoded", "encoded"),
      ) ||
      cleanHtmlText(childText(itemNode, "description")) ||
      cleanHtmlText(childText(itemNode, "summary"));
    const summary = truncateSummary(cleanedSummary);
    const id = itemDedupeId(guid, url ?? linkCandidate, title, publishedAt);

    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      title,
      url,
      author,
      publishedAt,
      occurredAt,
      summary,
    });
  }

  return { format: "rss", title: feedTitle, items };
}

function parseAtomXmlFeed(root: XmlNode, feedUrl: string): ParsedRssFeed {
  const xmlns = root.attrs.xmlns?.toLowerCase() ?? "";
  if (xmlns.includes("xhtml")) {
    throw new Error("Response is XHTML, not an Atom feed");
  }
  const titleNode = directChild(root, "title");
  const feedTitle =
    titleNode !== undefined ? cleanHtmlText(nodeText(titleNode)) || null : null;
  const feedAuthor = atomAuthors(root);

  const items: RssParsedItem[] = [];
  const seen = new Set<string>();

  for (const entryNode of directChildren(root, "entry")) {
    const title = cleanHtmlText(childText(entryNode, "title"));
    const explicitId = childText(entryNode, "id").trim();
    const rawHref = atomEntryLink(entryNode);
    const url = resolveHttpUrl(rawHref, feedUrl);
    const author =
      atomAuthors(entryNode) ??
      (cleanHtmlText(
        childTextByExactOrLocal(entryNode, "dc:creator", "creator"),
      ) ||
        null) ??
      feedAuthor;

    const rawDate = (
      childText(entryNode, "published") || childText(entryNode, "updated")
    ).trim();
    const { publishedAt, occurredAt } = normalizeDate(rawDate);

    const cleanedSummary =
      cleanHtmlText(childText(entryNode, "summary")) ||
      cleanHtmlText(childText(entryNode, "content"));
    const summary = truncateSummary(cleanedSummary);
    const id = itemDedupeId(explicitId, url ?? rawHref, title, publishedAt);

    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      title,
      url,
      author,
      publishedAt,
      occurredAt,
      summary,
    });
  }

  return { format: "atom", title: feedTitle, items };
}

function atomAuthors(parent: XmlNode): string | null {
  const names: string[] = [];
  for (const authorNode of directChildren(parent, "author")) {
    const nameNode = directChild(authorNode, "name");
    const raw = nameNode ? nodeText(nameNode) : nodeText(authorNode);
    const cleaned = cleanHtmlText(raw);
    if (cleaned !== "") names.push(cleaned);
  }
  return names.length > 0 ? names.join(", ") : null;
}

function atomEntryLink(entryNode: XmlNode): string {
  const links = directChildren(entryNode, "link").filter(
    (link) => (link.attrs.href?.trim() ?? "") !== "",
  );
  if (links.length === 0) return "";
  const alternates = links.filter(
    (link) =>
      link.attrs.rel === undefined ||
      link.attrs.rel.trim() === "" ||
      link.attrs.rel.trim().toLowerCase() === "alternate",
  );
  const htmlAlt = alternates.find((link) =>
    /html/i.test(link.attrs.type ?? ""),
  );
  if (htmlAlt?.attrs.href) return htmlAlt.attrs.href.trim();
  if (alternates[0]?.attrs.href) return alternates[0].attrs.href.trim();
  const nonSelf = links.find(
    (link) => link.attrs.rel?.trim().toLowerCase() !== "self",
  );
  return (nonSelf ?? links[0])?.attrs.href?.trim() ?? "";
}

function itemDedupeId(
  explicitId: string,
  url: string,
  title: string,
  publishedAt: string | null,
): string {
  const first = explicitId.trim();
  if (first !== "") return first;
  const second = url.trim();
  if (second !== "") return second;
  return createHash("sha256")
    .update(`${title}${publishedAt ?? ""}`)
    .digest("hex");
}

function normalizeDate(raw: string): {
  publishedAt: string | null;
  occurredAt: number | null;
} {
  if (raw === "") return { publishedAt: null, occurredAt: null };
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) {
    return { publishedAt: new Date(ms).toISOString(), occurredAt: ms };
  }
  return { publishedAt: raw, occurredAt: null };
}

function resolveHttpUrl(raw: string, baseUrl: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ lightweight XML DOM */

interface XmlNode {
  name: string;
  localName: string;
  attrs: Record<string, string>;
  parts: Array<string | XmlNode>;
  children: XmlNode[];
}

const BLOCK_XML_TAGS = new Set([
  "p",
  "div",
  "br",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "tr",
  "td",
  "th",
  "section",
  "article",
  "header",
  "footer",
  "hr",
]);

function parseXml(xml: string): XmlNode {
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let pos = 0;

  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    if (lt === -1) {
      const trailing = xml.slice(pos);
      if (trailing.trim() !== "") {
        if (stack.length === 0) {
          throw new Error("Invalid XML feed: unexpected trailing text");
        }
        appendText(stack[stack.length - 1]!, decodeXmlEntities(trailing));
      }
      break;
    }

    if (lt > pos) {
      const chunk = xml.slice(pos, lt);
      if (stack.length === 0) {
        if (chunk.trim() !== "") {
          throw new Error("Invalid XML feed: unexpected text outside root");
        }
      } else {
        appendText(stack[stack.length - 1]!, decodeXmlEntities(chunk));
      }
    }

    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new Error("Invalid XML feed: unclosed CDATA");
      if (stack.length === 0) {
        throw new Error("Invalid XML feed: CDATA outside root element");
      }
      appendText(stack[stack.length - 1]!, xml.slice(lt + 9, end));
      pos = end + 3;
      continue;
    }

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new Error("Invalid XML feed: unclosed comment");
      pos = end + 3;
      continue;
    }

    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) {
        throw new Error("Invalid XML feed: unclosed processing instruction");
      }
      pos = end + 2;
      continue;
    }

    if (xml.startsWith("<!", lt)) {
      pos = skipDeclaration(xml, lt);
      continue;
    }

    if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) throw new Error("Invalid XML feed: unclosed end tag");
      const closeName = xml.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (top === undefined || top.name !== closeName) {
        throw new Error(
          `Invalid XML feed: mismatched closing tag </${closeName}>`,
        );
      }
      pos = end + 1;
      continue;
    }

    if (root !== undefined && stack.length === 0) {
      throw new Error("Invalid XML feed: multiple root elements");
    }

    const parsedTag = parseStartTag(xml, lt);
    const node: XmlNode = {
      name: parsedTag.name,
      localName: localNameOf(parsedTag.name),
      attrs: parsedTag.attrs,
      parts: [],
      children: [],
    };
    if (stack.length > 0) {
      const parent = stack[stack.length - 1]!;
      parent.parts.push(node);
      parent.children.push(node);
    } else {
      root = node;
    }
    if (!parsedTag.selfClosing) stack.push(node);
    pos = parsedTag.nextPos;
  }

  if (root === undefined || stack.length > 0) {
    throw new Error("Invalid or truncated XML feed");
  }
  return root;
}

function skipDeclaration(xml: string, start: number): number {
  let i = start + 2;
  let quote: string | null = null;
  let bracketDepth = 0;
  while (i < xml.length) {
    const ch = xml[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      if (bracketDepth > 0) bracketDepth--;
    } else if (ch === ">" && bracketDepth === 0) {
      return i + 1;
    }
    i++;
  }
  throw new Error("Invalid XML feed: unclosed declaration");
}

function parseStartTag(
  xml: string,
  start: number,
): {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  nextPos: number;
} {
  let i = start + 1;
  while (i < xml.length && !/[\s/>]/.test(xml[i]!)) i++;
  const name = xml.slice(start + 1, i);
  if (!/^[a-z_][\w:.-]*$/i.test(name)) {
    throw new Error(`Invalid XML tag name near offset ${start}`);
  }

  const attrs: Record<string, string> = {};
  let selfClosing = false;

  while (i < xml.length) {
    while (i < xml.length && /\s/.test(xml[i]!)) i++;
    if (i >= xml.length) break;
    if (xml[i] === ">")
      return { name, attrs, selfClosing: false, nextPos: i + 1 };
    if (xml.startsWith("/>", i)) {
      selfClosing = true;
      return { name, attrs, selfClosing, nextPos: i + 2 };
    }

    const attrStart = i;
    while (i < xml.length && !/[\s=/>]/.test(xml[i]!)) i++;
    const attrName = xml.slice(attrStart, i);
    if (attrName === "") {
      throw new Error(`Invalid XML attribute near offset ${attrStart}`);
    }

    while (i < xml.length && /\s/.test(xml[i]!)) i++;
    if (xml[i] !== "=") {
      attrs[attrName] = "";
      continue;
    }
    i++; // '='
    while (i < xml.length && /\s/.test(xml[i]!)) i++;

    const quote = xml[i];
    if (quote === '"' || quote === "'") {
      i++;
      const valStart = i;
      const close = xml.indexOf(quote, i);
      if (close === -1) throw new Error("Invalid XML feed: unclosed attribute");
      attrs[attrName] = decodeXmlEntities(xml.slice(valStart, close));
      i = close + 1;
    } else {
      const valStart = i;
      while (i < xml.length && !/[\s/>]/.test(xml[i]!)) i++;
      attrs[attrName] = decodeXmlEntities(xml.slice(valStart, i));
    }
  }

  throw new Error("Invalid XML feed: unclosed start tag");
}

function appendText(node: XmlNode, text: string): void {
  if (text === "") return;
  const last = node.parts[node.parts.length - 1];
  if (typeof last === "string") node.parts[node.parts.length - 1] = last + text;
  else node.parts.push(text);
}

function localNameOf(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

const SKIP_XML_TEXT_TAGS = new Set(["script", "style", "noscript"]);

function directChild(parent: XmlNode, localName: string): XmlNode | undefined {
  const target = localName.toLowerCase();
  return (
    parent.children.find((c) => c.name.toLowerCase() === target) ??
    parent.children.find((c) => c.localName.toLowerCase() === target)
  );
}

function directChildren(parent: XmlNode, localName: string): XmlNode[] {
  const target = localName.toLowerCase();
  return parent.children.filter((c) => c.localName.toLowerCase() === target);
}

function childText(parent: XmlNode, localName: string): string {
  const child = directChild(parent, localName);
  return child === undefined ? "" : nodeText(child);
}

function childTextByExactOrLocal(
  parent: XmlNode,
  exactName: string,
  localName: string,
): string {
  const exact = exactName.toLowerCase();
  const byExact = parent.children.find((c) => c.name.toLowerCase() === exact);
  if (byExact !== undefined) return nodeText(byExact);
  return childText(parent, localName);
}

function nodeText(node: XmlNode): string {
  const out: string[] = [];
  for (const part of node.parts) {
    if (typeof part === "string") {
      out.push(part);
    } else {
      const tag = part.localName.toLowerCase();
      if (SKIP_XML_TEXT_TAGS.has(tag)) continue;
      const isBlock = BLOCK_XML_TAGS.has(tag);
      if (isBlock) out.push(" ");
      out.push(nodeText(part));
      if (isBlock) out.push(" ");
    }
  }
  return out.join("");
}

/* --------------------------------------------------- HTML & entity cleaning */

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const HTML_ENTITIES: Record<string, string> = {
  ...XML_ENTITIES,
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  times: "×",
  divide: "÷",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
};

function decodeEntities(raw: string, map: Record<string, string>): string {
  return raw.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (full, token: string) => {
      if (token.startsWith("#")) {
        const isHex = token[1]?.toLowerCase() === "x";
        const code = Number.parseInt(
          isHex ? token.slice(2) : token.slice(1),
          isHex ? 16 : 10,
        );
        if (
          Number.isInteger(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          (code < 0xd800 || code > 0xdfff)
        ) {
          return String.fromCodePoint(code);
        }
        return full;
      }
      return map[token.toLowerCase()] ?? full;
    },
  );
}

function decodeXmlEntities(raw: string): string {
  return decodeEntities(raw, XML_ENTITIES);
}

function cleanHtmlText(raw: string): string {
  if (raw === "") return "";
  const stripped = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<\/?(?:br|p|div|li|ul|ol|h[1-6]|blockquote|pre|tr|td|th|section|article|header|footer|aside|nav|figure|figcaption|hr)(?=\s|\/?>)(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?\/?>/gi,
      " ",
    )
    .replace(
      /<\/?[a-z][a-z0-9:-]*(?=\s|\/?>)(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?\/?>/gi,
      "",
    );
  return decodeEntities(stripped, HTML_ENTITIES).replace(/\s+/g, " ").trim();
}

function truncateSummary(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  let end = MAX_SUMMARY_CHARS - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
