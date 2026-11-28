/**
 * Built-in Webpage / JSON API change-monitoring `TriggerProvider` (`provider = "web-monitor"`).
 *
 * - Zero new dependencies: lightweight HTML DOM + CSS selector engine and JSONPath evaluator
 *   producing a canonical content digest (`sha256`) and bounded excerpt payload.
 * - Baseline seeding on `provision()`: validates URL, selector/jsonPath, method, and headers,
 *   performs an initial fetch, and persists the baseline digest into `SettingStore`
 *   (`web-monitor.trigger.<routineId>`) without firing an event on creation.
 * - SSRF-guarded via `@searxng-js/sex-egress` (`safeFetch`) with live `web.privateNetwork`
 *   updates (`setPrivateNetwork`), conditional HTTP (`ETag` / `Last-Modified` for GET),
 *   2 MiB & 15s caps, per-routine exponential backoff, and a single `unref()`ed timer.
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
  MARKUP_TYPE,
  parseHttpUrl,
  safeFetch,
} from "@searxng-js/sex-egress";
import pLimit from "p-limit";
import { blockedHere, privateNetworkAccessOf, proxyFor } from "../web/service";

const WEB_MONITOR_PROVIDER_ID = "web-monitor";
const WEB_MONITOR_SOURCE_SLUG = "http";
const WEB_MONITOR_SOURCE_NAME = "Web / JSON Monitor";
const WEB_MONITOR_TRIGGER_SLUG = "WEB_CONTENT_CHANGED";

const DEFAULT_POLL_MINUTES = 15;
const MIN_POLL_MINUTES = 1;
const MAX_POLL_MINUTES = 7 * 24 * 60;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_TEXT_CHARS = 3_000;
const MAX_SLEEP_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 6 * 60 * 60_000;
const POLL_CONCURRENCY = 4;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE_CHARS = 2_048;
const SETTING_KEY_PREFIX = "web-monitor.trigger.";
const USER_AGENT = "eta (+https://github.com/0xfe-project/eta)";
const DEFAULT_ACCEPT =
  "text/html, application/xhtml+xml, application/json, text/plain;q=0.9, */*;q=0.5";

const HEADER_TOKEN_RE = /^[!#$%&'*+.^`|~\w-]+$/;
const FORBIDDEN_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
]);

type WebMonitorMethod = "GET" | "POST";

export interface WebMonitorEventPayload {
  url: string;
  method: WebMonitorMethod;
  status: number;
  contentType: string;
  selector: string | null;
  jsonPath: string | null;
  content: string;
  truncated: boolean;
  digest: string;
  previousDigest: string | null;
  checkedAt: string;
}

export type WebMonitorFetch = (
  url: string,
  init: {
    method: WebMonitorMethod;
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface WebMonitorTriggerProviderOptions {
  settings: SettingStore;
  fetch?: WebMonitorFetch | undefined;
  allowPrivateNetwork?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  now?: (() => number) | undefined;
  timer?: boolean | undefined;
  backoffBaseMs?: number | undefined;
  backoffMaxMs?: number | undefined;
  warn?: ((message: string) => void) | undefined;
}

export interface WebMonitorPollSnapshot {
  nextPollAt: number;
  consecutiveFailures: number;
  lastError: string | null;
}

interface ParsedWebMonitorConfig {
  url: string;
  selector: string | null;
  jsonPath: string | null;
  method: WebMonitorMethod;
  headers: Record<string, string>;
  pollingIntervalMinutes: number;
  fingerprint: string;
}

interface PersistedWebMonitorState {
  configFingerprint: string;
  url: string;
  seeded: boolean;
  lastDigest: string | null;
  etag: string | null;
  lastModified: string | null;
  lastPolledAt: number;
  lastChangedAt: number | null;
}

interface ArmedRoutine {
  routineId: string;
  instanceId: string;
  key: string;
  config: ParsedWebMonitorConfig;
  intervalMs: number;
  nextPollAt: number;
  consecutiveFailures: number;
  lastError: string | null;
  generation: number;
}

const WEB_MONITOR_CATALOG_ITEM: TriggerCatalogItem = {
  provider: WEB_MONITOR_PROVIDER_ID,
  source: WEB_MONITOR_SOURCE_SLUG,
  sourceName: WEB_MONITOR_SOURCE_NAME,
  trigger: WEB_MONITOR_TRIGGER_SLUG,
  name: "Web / JSON content changed",
  description:
    "Polls an HTTP/HTTPS webpage or JSON API and triggers when extracted content changes.",
  modes: ["poll"],
  configSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        format: "uri",
        title: "URL",
        description: "HTTP or HTTPS URL to monitor.",
        examples: ["https://example.com/status"],
      },
      selector: {
        type: "string",
        title: "CSS selector",
        description:
          "Optional CSS selector for HTML pages (leave empty when using JSON path or monitoring the whole page).",
        examples: ["main .status, #version"],
      },
      jsonPath: {
        type: "string",
        title: "JSON path",
        description:
          "Optional JSON path for JSON APIs (e.g. $.data.version or items[0].title).",
        examples: ["$.data.version"],
      },
      method: {
        type: "string",
        title: "HTTP method",
        description: "HTTP method used when polling the target URL.",
        enum: ["GET", "POST"],
        default: "GET",
      },
      headers: {
        type: "object",
        title: "Request headers",
        description:
          "Optional plain-text HTTP headers as a JSON object (secrets are not supported).",
        additionalProperties: { type: "string" },
        examples: ['{"Accept": "application/json"}'],
      },
    },
  },
  payloadSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      method: { type: "string" },
      status: { type: "integer" },
      contentType: { type: "string" },
      selector: { type: ["string", "null"] },
      jsonPath: { type: ["string", "null"] },
      content: { type: "string" },
      truncated: { type: "boolean" },
      digest: { type: "string" },
      previousDigest: { type: ["string", "null"] },
      checkedAt: { type: "string" },
    },
  },
  accounts: [],
};

export class WebMonitorTriggerProvider implements TriggerProvider {
  readonly id = WEB_MONITOR_PROVIDER_ID;

  readonly #settings: SettingStore;
  readonly #customFetch: WebMonitorFetch | undefined;
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

  constructor(options: WebMonitorTriggerProviderOptions) {
    this.#settings = options.settings;
    this.#customFetch = options.fetch;
    this.#allowPrivateNetworkOverride = options.allowPrivateNetwork === true;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
    this.#now = options.now ?? Date.now;
    this.#timed = options.timer ?? true;
    this.#backoffBaseMs = options.backoffBaseMs;
    this.#backoffMaxMs = options.backoffMaxMs;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  status(): TriggerProviderStatus {
    return { provider: this.id, status: "ready" };
  }

  /** Updates the `web.privateNetwork` allowlist applied to outgoing fetches. */
  setPrivateNetwork(config: PrivateNetworkConfig | undefined): void {
    const next = privateNetworkAccessOf(config);
    if (next.key === this.#privateNetworkKey) return;
    this.#privateNetworkKey = next.key;
    this.#privateNetwork = next.access;
  }

  /** Current in-memory poll schedule and error state for one routine (for diagnostics/tests). */
  pollState(routineId: string): WebMonitorPollSnapshot | undefined {
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
      sourceFilter !== WEB_MONITOR_SOURCE_SLUG
    ) {
      return [];
    }
    const query = filter?.query?.trim().toLowerCase();
    if (query !== undefined && query !== "") {
      const haystack = [
        WEB_MONITOR_CATALOG_ITEM.provider,
        WEB_MONITOR_CATALOG_ITEM.source,
        WEB_MONITOR_CATALOG_ITEM.sourceName,
        WEB_MONITOR_CATALOG_ITEM.trigger,
        WEB_MONITOR_CATALOG_ITEM.name,
        WEB_MONITOR_CATALOG_ITEM.description,
      ]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(query)) return [];
    }
    return [WEB_MONITOR_CATALOG_ITEM];
  }

  async provision(input: {
    routineId: string;
    trigger: RoutineTrigger;
    enabled: boolean;
    existingInstanceId: string | null;
  }): Promise<TriggerProvisionResult> {
    const config = parseWebMonitorConfig(input.trigger);
    let checkedAt: number;
    let fetched: {
      status: number;
      contentType: string;
      body: Uint8Array;
      etag: string | null;
      lastModified: string | null;
    };
    try {
      fetched = await this.#fetchTarget(config);
      checkedAt = this.#now();
    } catch (error) {
      checkedAt = this.#now();
      this.#host?.onTriggerChecked?.(input.routineId, checkedAt);
      throw error;
    }

    if (fetched.status < 200 || fetched.status >= 300) {
      this.#host?.onTriggerChecked?.(input.routineId, checkedAt);
      throw new Error(`Target returned HTTP ${fetched.status}`);
    }

    let extracted: ExtractedContent;
    try {
      extracted = extractWebMonitorContent(fetched.body, fetched.contentType, {
        selector: config.selector,
        jsonPath: config.jsonPath,
      });
    } catch (error) {
      this.#host?.onTriggerChecked?.(input.routineId, checkedAt);
      throw error;
    }

    const existing = this.#readState(input.routineId);
    const sameConfig =
      input.existingInstanceId !== null &&
      existing !== undefined &&
      existing.seeded &&
      existing.configFingerprint === config.fingerprint;

    this.#writeState(input.routineId, {
      configFingerprint: config.fingerprint,
      url: config.url,
      seeded: true,
      lastDigest: extracted.digest,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      lastPolledAt: checkedAt,
      lastChangedAt: sameConfig ? existing.lastChangedAt : null,
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
      lastCheckedAt: checkedAt,
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
      throw new Error("Web Monitor trigger state is missing; re-provisioning");
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
      let config: ParsedWebMonitorConfig;
      try {
        config = parseWebMonitorConfig(binding.trigger);
      } catch (error) {
        this.#warn(
          `[eta] web-monitor binding ${binding.routineId} has invalid config: ${errorMessage(error)}`,
        );
        continue;
      }
      live.add(binding.routineId);
      const intervalMs = config.pollingIntervalMinutes * 60_000;
      const key = JSON.stringify([
        binding.instanceId,
        config.fingerprint,
        config.pollingIntervalMinutes,
      ]);
      const existing = this.#armed.get(binding.routineId);
      if (existing !== undefined && existing.key === key) continue;

      const persisted = this.#readState(binding.routineId);
      const lastPolledAt =
        persisted !== undefined &&
        persisted.configFingerprint === config.fingerprint
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
    this.#stopController.abort(
      new Error("Web Monitor trigger provider stopped"),
    );
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
    const sameConfig =
      persisted !== undefined &&
      persisted.seeded &&
      persisted.configFingerprint === config.fingerprint
        ? persisted
        : undefined;

    try {
      const fetched = await this.#fetchTarget(
        config,
        sameConfig !== undefined && config.method === "GET"
          ? {
              etag: sameConfig.etag,
              lastModified: sameConfig.lastModified,
            }
          : undefined,
      );
      if (this.#stopped || !this.#isCurrent(routineId, generation)) return;

      const now = this.#now();
      if (fetched.status === 304) {
        if (sameConfig !== undefined) {
          this.#writeState(routineId, {
            ...sameConfig,
            etag: fetched.etag ?? sameConfig.etag,
            lastModified: fetched.lastModified ?? sameConfig.lastModified,
            lastPolledAt: now,
          });
        }
        entry.consecutiveFailures = 0;
        entry.lastError = null;
        entry.nextPollAt = now + intervalMs;
        this.#host?.onTriggerChecked?.(routineId, now);
        this.#host?.onTriggerRecovered?.(routineId);
        return;
      }

      if (fetched.status < 200 || fetched.status >= 300) {
        throw new Error(`Target returned HTTP ${fetched.status}`);
      }

      const extracted = extractWebMonitorContent(
        fetched.body,
        fetched.contentType,
        {
          selector: config.selector,
          jsonPath: config.jsonPath,
        },
      );
      if (this.#stopped || !this.#isCurrent(routineId, generation)) return;

      const previousDigest = sameConfig?.lastDigest ?? null;
      const changed =
        sameConfig !== undefined && previousDigest !== extracted.digest;

      this.#writeState(routineId, {
        configFingerprint: config.fingerprint,
        url: config.url,
        seeded: true,
        lastDigest: extracted.digest,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        lastPolledAt: now,
        lastChangedAt: changed ? now : (sameConfig?.lastChangedAt ?? null),
      });

      if (changed) {
        const eventId = createHash("sha256")
          .update(
            `${routineId}:${previousDigest ?? ""}:${extracted.digest}:${now}`,
          )
          .digest("hex")
          .slice(0, 32);
        const payload: WebMonitorEventPayload = {
          url: config.url,
          method: config.method,
          status: fetched.status,
          contentType: fetched.contentType || "text/plain",
          selector: config.selector,
          jsonPath: config.jsonPath,
          content: extracted.content,
          truncated: extracted.truncated,
          digest: extracted.digest,
          previousDigest,
          checkedAt: new Date(now).toISOString(),
        };
        this.#host?.onEvent({
          provider: WEB_MONITOR_PROVIDER_ID,
          instanceId: entry.instanceId,
          routineId,
          triggerSlug: WEB_MONITOR_TRIGGER_SLUG,
          source: WEB_MONITOR_SOURCE_SLUG,
          accountId: null,
          eventId,
          occurredAt: now,
          payload,
        });
      }

      entry.consecutiveFailures = 0;
      entry.lastError = null;
      entry.nextPollAt = now + intervalMs;
      this.#host?.onTriggerChecked?.(routineId, now);
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
      if (sameConfig !== undefined) {
        this.#writeState(routineId, {
          ...sameConfig,
          lastPolledAt: now,
        });
      }
      this.#warn(
        `[eta] web-monitor poll failed for routine ${routineId} (${config.url}): ${message}`,
      );
      this.#host?.onTriggerChecked?.(routineId, now);
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
        this.#warn(
          `[eta] web-monitor polling loop failed: ${errorMessage(error)}`,
        );
        this.#scheduleTimer();
      });
    }, wait);
    this.#timer.unref?.();
  }

  async #fetchTarget(
    config: ParsedWebMonitorConfig,
    conditional?: { etag?: string | null; lastModified?: string | null },
  ): Promise<{
    status: number;
    contentType: string;
    body: Uint8Array;
    etag: string | null;
    lastModified: string | null;
  }> {
    const parsedUrl = parseHttpUrl(config.url);
    const headers: Record<string, string> = {
      accept: DEFAULT_ACCEPT,
      ...config.headers,
    };
    const hasHeader = (lower: string) =>
      Object.keys(headers).some((key) => key.toLowerCase() === lower);
    if (conditional?.etag && !hasHeader("if-none-match")) {
      headers["if-none-match"] = conditional.etag;
    }
    if (conditional?.lastModified && !hasHeader("if-modified-since")) {
      headers["if-modified-since"] = conditional.lastModified;
    }

    let userAgent = USER_AGENT;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "user-agent") {
        userAgent = value;
        delete headers[key];
      }
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
            method: config.method,
            headers: {
              "user-agent": userAgent,
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
        method: config.method,
        headers,
        signal,
        allowPrivateNetwork: this.#allowPrivateNetworkOverride
          ? true
          : this.#privateNetwork,
        proxy: proxyFor(parsedUrl.href),
        userAgent,
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

  #readState(routineId: string): PersistedWebMonitorState | undefined {
    const raw = this.#settings.get(settingKey(routineId));
    if (!isPlain(raw)) return undefined;
    if (
      typeof raw.configFingerprint !== "string" ||
      raw.configFingerprint === ""
    ) {
      return undefined;
    }
    if (typeof raw.url !== "string" || raw.url === "") return undefined;
    return {
      configFingerprint: raw.configFingerprint,
      url: raw.url,
      seeded: raw.seeded === true,
      lastDigest:
        typeof raw.lastDigest === "string" && raw.lastDigest !== ""
          ? raw.lastDigest
          : null,
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
      lastChangedAt:
        typeof raw.lastChangedAt === "number" &&
        Number.isFinite(raw.lastChangedAt)
          ? raw.lastChangedAt
          : null,
    };
  }

  #writeState(routineId: string, state: PersistedWebMonitorState): void {
    this.#settings.set(settingKey(routineId), state);
  }
}

/* ---------------------------------------------------------- config & state */

function parseWebMonitorConfig(
  trigger: RoutineTrigger,
): ParsedWebMonitorConfig {
  if (trigger.source !== WEB_MONITOR_SOURCE_SLUG) {
    throw new Error(
      `Web Monitor trigger source must be "${WEB_MONITOR_SOURCE_SLUG}"`,
    );
  }
  if (trigger.trigger !== WEB_MONITOR_TRIGGER_SLUG) {
    throw new Error(
      `Web Monitor trigger slug must be "${WEB_MONITOR_TRIGGER_SLUG}"`,
    );
  }
  if (
    trigger.mode !== undefined &&
    trigger.mode !== null &&
    trigger.mode !== "poll"
  ) {
    throw new Error('Web Monitor trigger only supports "poll" mode');
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
        `Web Monitor pollingIntervalMinutes must be an integer between ${MIN_POLL_MINUTES} and ${MAX_POLL_MINUTES}`,
      );
    }
    pollingIntervalMinutes = rawPolling;
  }

  const cfg = isPlain(trigger.config) ? trigger.config : {};
  const rawUrl = typeof cfg.url === "string" ? cfg.url.trim() : "";
  if (rawUrl === "") {
    throw new Error("Target URL is required (config.url)");
  }
  const url = parseHttpUrl(rawUrl).href;

  const selector = optionalTrimmedString(cfg.selector, "config.selector");
  const jsonPath = optionalTrimmedString(cfg.jsonPath, "config.jsonPath");
  if (selector !== null && jsonPath !== null) {
    throw new Error('Specify either CSS "selector" or "jsonPath", not both');
  }
  if (selector !== null) parseCssSelector(selector);
  if (jsonPath !== null) parseJsonPath(jsonPath);

  const rawMethod = cfg.method ?? "GET";
  if (typeof rawMethod !== "string") {
    throw new TypeError("Web Monitor config.method must be a string");
  }
  const method = rawMethod.trim().toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error('Web Monitor config.method must be "GET" or "POST"');
  }

  const headers = parseHeaders(cfg.headers);
  const sortedHeaders = Object.entries(headers).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([url, selector, jsonPath, method, sortedHeaders]))
    .digest("hex");

  return {
    url,
    selector,
    jsonPath,
    method,
    headers,
    pollingIntervalMinutes,
    fingerprint,
  };
}

function optionalTrimmedString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isPlain(raw)) {
    throw new TypeError(
      "Web Monitor config.headers must be a plain JSON object of string key-value pairs",
    );
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_HEADERS) {
    throw new Error(
      `Web Monitor config.headers may have at most ${MAX_HEADERS} entries`,
    );
  }
  const out: Record<string, string> = {};
  const seenLower = new Set<string>();
  for (const [rawKey, rawValue] of entries) {
    const name = rawKey.trim();
    if (name === "" || !HEADER_TOKEN_RE.test(name)) {
      throw new Error(`Invalid HTTP header name "${rawKey}"`);
    }
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADER_NAMES.has(lower)) {
      throw new Error(`HTTP header "${name}" cannot be overridden`);
    }
    if (seenLower.has(lower)) {
      throw new Error(`Duplicate HTTP header "${name}"`);
    }
    seenLower.add(lower);
    if (typeof rawValue !== "string") {
      throw new TypeError(`HTTP header "${name}" value must be a string`);
    }
    if (/[\r\n\0]/.test(rawValue)) {
      throw new Error(`HTTP header "${name}" contains invalid line breaks`);
    }
    if (rawValue.length > MAX_HEADER_VALUE_CHARS) {
      throw new Error(
        `HTTP header "${name}" exceeds ${MAX_HEADER_VALUE_CHARS} characters`,
      );
    }
    out[name] = rawValue;
  }
  return out;
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
  return `${WEB_MONITOR_PROVIDER_ID}:${routineId}`;
}

function routineIdOf(instanceId: string): string | null {
  const prefix = `${WEB_MONITOR_PROVIDER_ID}:`;
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

/* --------------------------------------------------- extraction & digest */

export interface ExtractedContent {
  mode: "html" | "json" | "text";
  content: string;
  truncated: boolean;
  digest: string;
}

/** Extracts normalized content from HTML (CSS selector), JSON (JSONPath), or whole response. */
export function extractWebMonitorContent(
  rawBody: Uint8Array | string,
  contentType = "",
  options: { selector?: string | null; jsonPath?: string | null } = {},
): ExtractedContent {
  const selector = options.selector?.trim() || null;
  const jsonPath = options.jsonPath?.trim() || null;
  if (selector !== null && jsonPath !== null) {
    throw new Error('Specify either CSS "selector" or "jsonPath", not both');
  }

  const text = stripBom(
    typeof rawBody === "string" ? rawBody : decodeBody(rawBody, contentType),
  );

  if (jsonPath !== null) {
    const parsedJson = parseJsonResponse(text);
    const extracted = evaluateJsonPath(parsedJson, jsonPath);
    return finalizeJsonContent(extracted);
  }

  if (selector !== null) {
    const doc = parseHtml(text);
    const matches = queryCssSelector(doc, selector);
    if (matches.length === 0) {
      throw new Error(`CSS selector "${selector}" matched no elements`);
    }
    const parts = matches.map(elementText);
    const nonEmpty = parts.filter((part) => part !== "");
    const normalized = nonEmpty.length > 0 ? nonEmpty.join("\n") : "";
    return finalizeTextContent("html", normalized);
  }

  const trimmed = text.trim();
  const looksJson =
    /json/i.test(contentType) ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (looksJson && trimmed !== "") {
    try {
      const parsedJson = JSON.parse(trimmed) as unknown;
      return finalizeJsonContent(parsedJson);
    } catch {
      if (/json/i.test(contentType)) {
        throw new Error("Response declared JSON but could not be parsed");
      }
    }
  }

  const looksHtml =
    MARKUP_TYPE.test(contentType) ||
    /^<(?:!doctype|html|head|body|main|div|section|article|p|h[1-6]|ul|ol|table)\b/i.test(
      trimmed,
    );
  if (looksHtml) {
    const doc = parseHtml(text);
    const normalized = elementText(doc);
    return finalizeTextContent("html", normalized);
  }

  const normalizedText = text.replace(/\r\n/g, "\n").trim();
  return finalizeTextContent("text", normalizedText);
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("JSON response is empty");
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("Response is not valid JSON");
  }
}

function finalizeJsonContent(value: unknown): ExtractedContent {
  const canonical = canonicalJson(value);
  const canonicalText = JSON.stringify(canonical);
  const digest = sha256Hex(`json:${canonicalText}`);
  const pretty =
    typeof canonical === "string"
      ? canonical
      : JSON.stringify(canonical, null, 2);
  const bounded = truncateText(pretty, MAX_PAYLOAD_TEXT_CHARS);
  return {
    mode: "json",
    content: bounded.text,
    truncated: bounded.truncated,
    digest,
  };
}

function finalizeTextContent(
  mode: "html" | "text",
  normalized: string,
): ExtractedContent {
  const digest = sha256Hex(`${mode}:${normalized}`);
  const bounded = truncateText(normalized, MAX_PAYLOAD_TEXT_CHARS);
  return {
    mode,
    content: bounded.text,
    truncated: bounded.truncated,
    digest,
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalJson(value[key]);
    }
    return out;
  }
  return value;
}

function truncateText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: `${text.slice(0, end).trimEnd()}…`, truncated: true };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/* --------------------------------------------------------------- JSONPath */

type JsonPathSegment =
  | { kind: "prop"; key: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" };

interface ParsedJsonPath {
  segments: JsonPathSegment[];
  hasWildcard: boolean;
}

export function parseJsonPath(raw: string): ParsedJsonPath {
  const input = raw.trim();
  if (input === "") {
    throw new Error("JSON path cannot be empty");
  }

  let pos = 0;
  if (input.startsWith("$")) {
    pos = 1;
    if (pos === input.length) {
      return { segments: [], hasWildcard: false };
    }
    if (input[pos] !== "." && input[pos] !== "[") {
      throw new Error(
        `Invalid JSON path "${raw}": expected "." or "[" after "$"`,
      );
    }
  }

  const segments: JsonPathSegment[] = [];
  let hasWildcard = false;

  while (pos < input.length) {
    const ch = input[pos]!;
    if (ch === ".") {
      pos++;
      if (pos >= input.length || input[pos] === ".") {
        throw new Error(`Invalid JSON path "${raw}" near offset ${pos}`);
      }
      if (input[pos] === "*") {
        pos++;
        if (pos < input.length && input[pos] !== "." && input[pos] !== "[") {
          throw new Error(`Invalid JSON path "${raw}" after "*"`);
        }
        segments.push({ kind: "wildcard" });
        hasWildcard = true;
        continue;
      }
      const start = pos;
      while (pos < input.length && input[pos] !== "." && input[pos] !== "[") {
        if (/\s/.test(input[pos]!)) {
          throw new Error(
            `Invalid whitespace in JSON path "${raw}"; use ['key'] for spaced keys`,
          );
        }
        pos++;
      }
      const key = input.slice(start, pos);
      if (key === "") {
        throw new Error(`Invalid JSON path "${raw}" near offset ${start}`);
      }
      segments.push({ kind: "prop", key });
      continue;
    }

    if (ch === "[") {
      pos++;
      while (pos < input.length && /\s/.test(input[pos]!)) pos++;
      if (pos >= input.length) {
        throw new Error(`Unclosed "[" in JSON path "${raw}"`);
      }
      const quote = input[pos];
      if (quote === "'" || quote === '"') {
        pos++;
        let key = "";
        let closed = false;
        while (pos < input.length) {
          const cur = input[pos]!;
          if (cur === "\\") {
            pos++;
            if (pos >= input.length) {
              throw new Error(`Unterminated escape in JSON path "${raw}"`);
            }
            key += input[pos]!;
            pos++;
            continue;
          }
          if (cur === quote) {
            pos++;
            closed = true;
            break;
          }
          key += cur;
          pos++;
        }
        if (!closed) {
          throw new Error(`Unclosed quoted key in JSON path "${raw}"`);
        }
        while (pos < input.length && /\s/.test(input[pos]!)) pos++;
        if (input[pos] !== "]") {
          throw new Error(`Expected "]" in JSON path "${raw}"`);
        }
        pos++;
        segments.push({ kind: "prop", key });
        continue;
      }

      const close = input.indexOf("]", pos);
      if (close === -1) {
        throw new Error(`Unclosed "[" in JSON path "${raw}"`);
      }
      const inner = input.slice(pos, close).trim();
      pos = close + 1;
      if (inner === "*") {
        segments.push({ kind: "wildcard" });
        hasWildcard = true;
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ kind: "index", index: Number.parseInt(inner, 10) });
      } else {
        throw new Error(`Invalid JSON path bracket segment "[${inner}]"`);
      }
      continue;
    }

    // Bare root property without leading "$" or "." (e.g., "data.version" or "0")
    if (segments.length === 0) {
      const start = pos;
      while (pos < input.length && input[pos] !== "." && input[pos] !== "[") {
        if (/\s/.test(input[pos]!)) {
          throw new Error(
            `Invalid whitespace in JSON path "${raw}"; use ['key'] for spaced keys`,
          );
        }
        pos++;
      }
      const key = input.slice(start, pos);
      segments.push({ kind: "prop", key });
      continue;
    }

    throw new Error(`Unexpected character "${ch}" in JSON path "${raw}"`);
  }

  return { segments, hasWildcard };
}

function evaluateJsonPath(root: unknown, rawPath: string): unknown {
  const parsed = parseJsonPath(rawPath);
  let current: unknown[] = [root];

  for (const segment of parsed.segments) {
    const next: unknown[] = [];
    for (const node of current) {
      if (segment.kind === "prop") {
        if (isPlain(node) && Object.hasOwn(node, segment.key)) {
          next.push(node[segment.key]);
        }
      } else if (segment.kind === "index") {
        if (Array.isArray(node)) {
          const index =
            segment.index < 0 ? node.length + segment.index : segment.index;
          if (index >= 0 && index < node.length) {
            next.push(node[index]);
          }
        }
      } else {
        if (Array.isArray(node)) {
          next.push(...node);
        } else if (isPlain(node)) {
          next.push(...Object.values(node));
        }
      }
    }
    current = next;
    if (current.length === 0) break;
  }

  if (current.length === 0) {
    throw new Error(`JSON path "${rawPath}" not found`);
  }
  return parsed.hasWildcard ? current : current[0];
}

/* ----------------------------------------------------- lightweight HTML DOM */

interface HtmlNode {
  tagName: string;
  attrs: Record<string, string>;
  parent: HtmlNode | null;
  parts: Array<string | HtmlNode>;
  children: HtmlNode[];
}

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_HTML_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "textarea",
  "title",
]);

const SKIP_HTML_TEXT_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
]);

const BLOCK_HTML_TAGS = new Set([
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
  "aside",
  "nav",
  "figure",
  "figcaption",
  "hr",
  "dt",
  "dd",
]);

function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = {
    tagName: "#document",
    attrs: {},
    parent: null,
    parts: [],
    children: [],
  };
  const stack: HtmlNode[] = [root];
  let pos = 0;

  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      appendHtmlText(
        stack[stack.length - 1]!,
        decodeHtmlEntities(html.slice(pos)),
      );
      break;
    }

    if (lt > pos) {
      appendHtmlText(
        stack[stack.length - 1]!,
        decodeHtmlEntities(html.slice(pos, lt)),
      );
    }

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      pos = end === -1 ? html.length : end + 3;
      continue;
    }

    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9);
      if (end === -1) {
        appendHtmlText(stack[stack.length - 1]!, html.slice(lt + 9));
        break;
      }
      appendHtmlText(stack[stack.length - 1]!, html.slice(lt + 9, end));
      pos = end + 3;
      continue;
    }

    if (html.startsWith("<?", lt)) {
      const end = html.indexOf("?>", lt + 2);
      pos = end === -1 ? html.length : end + 2;
      continue;
    }

    if (html.startsWith("<!", lt)) {
      const end = html.indexOf(">", lt + 2);
      pos = end === -1 ? html.length : end + 1;
      continue;
    }

    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt + 2);
      if (end === -1) break;
      const closeName = html
        .slice(lt + 2, end)
        .trim()
        .toLowerCase();
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]!.tagName === closeName) {
          stack.length = i;
          break;
        }
      }
      pos = end + 1;
      continue;
    }

    const parsedTag = parseHtmlStartTag(html, lt);
    if (parsedTag === null) {
      appendHtmlText(stack[stack.length - 1]!, "<");
      pos = lt + 1;
      continue;
    }

    const parent = stack[stack.length - 1]!;
    const node: HtmlNode = {
      tagName: parsedTag.tagName,
      attrs: parsedTag.attrs,
      parent,
      parts: [],
      children: [],
    };
    parent.parts.push(node);
    parent.children.push(node);

    pos = parsedTag.nextPos;
    if (parsedTag.selfClosing || VOID_HTML_TAGS.has(node.tagName)) {
      continue;
    }

    if (RAW_TEXT_HTML_TAGS.has(node.tagName)) {
      const closeRe = new RegExp(`</${node.tagName}\\s*>`, "i");
      const tail = html.slice(pos);
      const match = closeRe.exec(tail);
      if (match === null) {
        appendHtmlText(node, tail);
        pos = html.length;
      } else {
        const inner = tail.slice(0, match.index);
        appendHtmlText(
          node,
          node.tagName === "title" || node.tagName === "textarea"
            ? decodeHtmlEntities(inner)
            : inner,
        );
        pos += match.index + match[0].length;
      }
      continue;
    }

    stack.push(node);
  }

  return root;
}

function parseHtmlStartTag(
  html: string,
  start: number,
): {
  tagName: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  nextPos: number;
} | null {
  let i = start + 1;
  while (i < html.length && !/[\s/>]/.test(html[i]!)) i++;
  const rawName = html.slice(start + 1, i);
  if (!/^[a-z][\w:-]*$/i.test(rawName)) return null;

  const tagName = rawName.toLowerCase();
  const attrs: Record<string, string> = {};

  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i]!)) i++;
    if (i >= html.length) break;
    if (html[i] === ">") {
      return { tagName, attrs, selfClosing: false, nextPos: i + 1 };
    }
    if (html.startsWith("/>", i)) {
      return { tagName, attrs, selfClosing: true, nextPos: i + 2 };
    }

    const attrStart = i;
    while (i < html.length && !/[\s=/>]/.test(html[i]!)) i++;
    const attrName = html.slice(attrStart, i).toLowerCase();
    if (attrName === "") {
      i++;
      continue;
    }

    while (i < html.length && /\s/.test(html[i]!)) i++;
    if (html[i] !== "=") {
      attrs[attrName] = "";
      continue;
    }
    i++;
    while (i < html.length && /\s/.test(html[i]!)) i++;

    const quote = html[i];
    if (quote === '"' || quote === "'") {
      i++;
      const valStart = i;
      const close = html.indexOf(quote, i);
      if (close === -1) {
        attrs[attrName] = decodeHtmlEntities(html.slice(valStart));
        return { tagName, attrs, selfClosing: false, nextPos: html.length };
      }
      attrs[attrName] = decodeHtmlEntities(html.slice(valStart, close));
      i = close + 1;
    } else {
      const valStart = i;
      while (i < html.length && !/[\s>]/.test(html[i]!)) i++;
      attrs[attrName] = decodeHtmlEntities(html.slice(valStart, i));
    }
  }

  return { tagName, attrs, selfClosing: false, nextPos: html.length };
}

function appendHtmlText(node: HtmlNode, text: string): void {
  if (text === "") return;
  const last = node.parts[node.parts.length - 1];
  if (typeof last === "string") node.parts[node.parts.length - 1] = last + text;
  else node.parts.push(text);
}

function elementText(node: HtmlNode): string {
  return collectNodeText(node).replace(/\s+/g, " ").trim();
}

function collectNodeText(node: HtmlNode): string {
  const out: string[] = [];
  for (const part of node.parts) {
    if (typeof part === "string") {
      out.push(part);
    } else {
      if (SKIP_HTML_TEXT_TAGS.has(part.tagName)) continue;
      const isBlock = BLOCK_HTML_TAGS.has(part.tagName);
      if (isBlock) out.push(" ");
      out.push(collectNodeText(part));
      if (isBlock) out.push(" ");
    }
  }
  return out.join("");
}

/* ----------------------------------------------------------- CSS selectors */

type Combinator = " " | ">" | "+" | "~";
type AttrOperator = "=" | "~=" | "|=" | "^=" | "$=" | "*=" | undefined;

interface AttrSelector {
  name: string;
  operator: AttrOperator;
  value: string;
  caseInsensitive: boolean;
}

type PseudoSelector =
  | { kind: "first-child" }
  | { kind: "last-child" }
  | { kind: "only-child" }
  | { kind: "empty" }
  | { kind: "nth-child"; step: number; offset: number }
  | { kind: "not"; selectors: ComplexSelector[] };

interface CompoundSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: AttrSelector[];
  pseudos: PseudoSelector[];
}

interface ComplexSelectorPart {
  compound: CompoundSelector;
  combinator: Combinator | null;
}

type ComplexSelector = ComplexSelectorPart[];

export function parseCssSelector(raw: string): ComplexSelector[] {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("CSS selector cannot be empty");
  }
  const branches = splitTopLevelCommas(trimmed);
  if (branches.includes("")) {
    throw new Error(`Invalid CSS selector "${raw}": empty selector branch`);
  }
  return branches.map((branch) => parseComplexSelector(branch, raw));
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote !== null) {
      if (ch === "\\" && i + 1 < input.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      if (bracketDepth === 0) throw new Error(`Unexpected "]" in "${input}"`);
      bracketDepth--;
    } else if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      if (parenDepth === 0) throw new Error(`Unexpected ")" in "${input}"`);
      parenDepth--;
    } else if (ch === "," && bracketDepth === 0 && parenDepth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote !== null) throw new Error(`Unclosed string in "${input}"`);
  if (bracketDepth !== 0) throw new Error(`Unclosed "[" in "${input}"`);
  if (parenDepth !== 0) throw new Error(`Unclosed "(" in "${input}"`);
  parts.push(input.slice(start).trim());
  return parts;
}

function parseComplexSelector(
  input: string,
  fullSelector: string,
): ComplexSelector {
  const parts: ComplexSelector = [];
  let pos = 0;

  const skipWs = () => {
    while (pos < input.length && /\s/.test(input[pos]!)) pos++;
  };

  skipWs();
  if (pos >= input.length) {
    throw new Error(`Invalid CSS selector "${fullSelector}"`);
  }
  if (">~+".includes(input[pos]!)) {
    throw new Error(
      `Invalid CSS selector "${fullSelector}": unexpected leading combinator "${input[pos]}"`,
    );
  }

  while (pos < input.length) {
    const { compound, nextPos } = parseCompoundSelector(
      input,
      pos,
      fullSelector,
    );
    pos = nextPos;
    const hadWs = pos < input.length && /\s/.test(input[pos]!);
    skipWs();
    if (pos >= input.length) {
      parts.push({ compound, combinator: null });
      break;
    }
    const ch = input[pos]!;
    let combinator: Combinator | null = null;
    if (ch === ">" || ch === "+" || ch === "~") {
      combinator = ch;
      pos++;
      skipWs();
      if (pos >= input.length || ">+~".includes(input[pos]!)) {
        throw new Error(
          `Invalid CSS selector "${fullSelector}": expected selector after "${combinator}"`,
        );
      }
    } else if (hadWs) {
      combinator = " ";
    } else {
      throw new Error(
        `Invalid CSS selector "${fullSelector}" near "${input.slice(pos)}"`,
      );
    }
    parts.push({ compound, combinator });
  }

  return parts;
}

function parseCompoundSelector(
  input: string,
  start: number,
  fullSelector: string,
): { compound: CompoundSelector; nextPos: number } {
  let pos = start;
  let tag: string | null = null;
  let id: string | null = null;
  const classes: string[] = [];
  const attrs: AttrSelector[] = [];
  const pseudos: PseudoSelector[] = [];

  if (input[pos] === "*") {
    tag = "*";
    pos++;
  } else if (/[a-z_-]/i.test(input[pos] ?? "")) {
    const tagStart = pos;
    while (pos < input.length && /[\w-]/.test(input[pos]!)) pos++;
    tag = input.slice(tagStart, pos).toLowerCase();
  }

  while (pos < input.length && !/[\s>+~]/.test(input[pos]!)) {
    const ch = input[pos]!;
    if (ch === "#") {
      pos++;
      const ident = readCssIdent(input, pos);
      if (ident === null) {
        throw new Error(`Invalid ID selector in "${fullSelector}"`);
      }
      id = ident.value;
      pos = ident.nextPos;
      continue;
    }
    if (ch === ".") {
      pos++;
      const ident = readCssIdent(input, pos);
      if (ident === null) {
        throw new Error(`Invalid class selector in "${fullSelector}"`);
      }
      classes.push(ident.value);
      pos = ident.nextPos;
      continue;
    }
    if (ch === "[") {
      const parsedAttr = parseAttrSelector(input, pos, fullSelector);
      attrs.push(parsedAttr.attr);
      pos = parsedAttr.nextPos;
      continue;
    }
    if (ch === ":") {
      if (input[pos + 1] === ":") {
        throw new Error(
          `Unsupported pseudo-element in CSS selector "${fullSelector}"`,
        );
      }
      pos++;
      const ident = readCssIdent(input, pos);
      if (ident === null) {
        throw new Error(`Invalid pseudo-class in "${fullSelector}"`);
      }
      const pseudoName = ident.value.toLowerCase();
      pos = ident.nextPos;
      if (input[pos] === "(") {
        const argEnd = findMatchingParen(input, pos, fullSelector);
        const rawArg = input.slice(pos + 1, argEnd).trim();
        pos = argEnd + 1;
        if (pseudoName === "nth-child") {
          const nth = parseNthExpression(rawArg, fullSelector);
          pseudos.push({
            kind: "nth-child",
            step: nth.step,
            offset: nth.offset,
          });
        } else if (pseudoName === "not") {
          if (rawArg === "") {
            throw new Error(`Empty :not() in "${fullSelector}"`);
          }
          pseudos.push({
            kind: "not",
            selectors: parseCssSelector(rawArg),
          });
        } else {
          throw new Error(
            `Unsupported pseudo-class ":${pseudoName}()" in "${fullSelector}"`,
          );
        }
      } else if (
        pseudoName === "first-child" ||
        pseudoName === "last-child" ||
        pseudoName === "only-child" ||
        pseudoName === "empty"
      ) {
        pseudos.push({ kind: pseudoName });
      } else {
        throw new Error(
          `Unsupported pseudo-class ":${pseudoName}" in "${fullSelector}"`,
        );
      }
      continue;
    }

    throw new Error(
      `Unexpected token "${ch}" in CSS selector "${fullSelector}"`,
    );
  }

  if (
    tag === null &&
    id === null &&
    classes.length === 0 &&
    attrs.length === 0 &&
    pseudos.length === 0
  ) {
    throw new Error(`Empty selector segment in "${fullSelector}"`);
  }

  return {
    compound: { tag, id, classes, attrs, pseudos },
    nextPos: pos,
  };
}

function readCssIdent(
  input: string,
  start: number,
): { value: string; nextPos: number } | null {
  let pos = start;
  while (pos < input.length && /[\w:-]/.test(input[pos]!)) pos++;
  if (pos === start) return null;
  return { value: input.slice(start, pos), nextPos: pos };
}

function findMatchingParen(
  input: string,
  openPos: number,
  fullSelector: string,
): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openPos; i < input.length; i++) {
    const ch = input[i]!;
    if (quote !== null) {
      if (ch === "\\" && i + 1 < input.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unclosed "(" in CSS selector "${fullSelector}"`);
}

function parseAttrSelector(
  input: string,
  openPos: number,
  fullSelector: string,
): { attr: AttrSelector; nextPos: number } {
  let pos = openPos + 1;
  const skipWs = () => {
    while (pos < input.length && /\s/.test(input[pos]!)) pos++;
  };
  skipWs();
  const ident = readCssIdent(input, pos);
  if (ident === null) {
    throw new Error(`Invalid attribute name in "${fullSelector}"`);
  }
  const name = ident.value.toLowerCase();
  pos = ident.nextPos;
  skipWs();

  if (input[pos] === "]") {
    return {
      attr: { name, operator: undefined, value: "", caseInsensitive: false },
      nextPos: pos + 1,
    };
  }

  let operator: AttrOperator;
  if (input[pos] === "=") {
    operator = "=";
    pos++;
  } else if ("~|^$*".includes(input[pos] ?? "") && input[pos + 1] === "=") {
    operator = input.slice(pos, pos + 2) as AttrOperator;
    pos += 2;
  } else {
    throw new Error(`Invalid attribute operator in "${fullSelector}"`);
  }

  skipWs();
  let value = "";
  const quote = input[pos];
  if (quote === '"' || quote === "'") {
    pos++;
    let closed = false;
    while (pos < input.length) {
      const ch = input[pos]!;
      if (ch === "\\" && pos + 1 < input.length) {
        value += input[pos + 1]!;
        pos += 2;
        continue;
      }
      if (ch === quote) {
        pos++;
        closed = true;
        break;
      }
      value += ch;
      pos++;
    }
    if (!closed) {
      throw new Error(`Unclosed attribute value in "${fullSelector}"`);
    }
  } else {
    const valStart = pos;
    while (pos < input.length && !/[\s\]]/.test(input[pos]!)) pos++;
    value = input.slice(valStart, pos);
    if (value === "") {
      throw new Error(`Missing attribute value in "${fullSelector}"`);
    }
  }

  skipWs();
  let caseInsensitive = false;
  if (input[pos] === "i" || input[pos] === "I") {
    caseInsensitive = true;
    pos++;
    skipWs();
  } else if (input[pos] === "s" || input[pos] === "S") {
    pos++;
    skipWs();
  }
  if (input[pos] !== "]") {
    throw new Error(`Unclosed "[" in CSS selector "${fullSelector}"`);
  }
  return {
    attr: { name, operator, value, caseInsensitive },
    nextPos: pos + 1,
  };
}

function parseNthExpression(
  raw: string,
  fullSelector: string,
): { step: number; offset: number } {
  const normalized = raw.replace(/\s+/g, "").toLowerCase();
  if (normalized === "odd") return { step: 2, offset: 1 };
  if (normalized === "even") return { step: 2, offset: 0 };
  if (/^[+-]?\d+$/.test(normalized)) {
    return { step: 0, offset: Number.parseInt(normalized, 10) };
  }
  const match = /^([+-]?\d*)n([+-]\d+)?$/.exec(normalized);
  if (match === null) {
    throw new Error(
      `Invalid :nth-child(${raw}) expression in "${fullSelector}"`,
    );
  }
  const stepRaw = match[1]!;
  const step =
    stepRaw === "" || stepRaw === "+"
      ? 1
      : stepRaw === "-"
        ? -1
        : Number.parseInt(stepRaw, 10);
  const offset = match[2] ? Number.parseInt(match[2], 10) : 0;
  return { step, offset };
}

function queryCssSelector(root: HtmlNode, rawSelector: string): HtmlNode[] {
  const selectors = parseCssSelector(rawSelector);
  const allElements: HtmlNode[] = [];
  const collect = (node: HtmlNode) => {
    for (const child of node.children) {
      allElements.push(child);
      collect(child);
    }
  };
  collect(root);

  return allElements.filter((el) =>
    selectors.some((complex) => matchesComplex(el, complex)),
  );
}

function matchesComplex(el: HtmlNode, complex: ComplexSelector): boolean {
  return matchesComplexAt(el, complex, complex.length - 1);
}

function matchesComplexAt(
  el: HtmlNode,
  complex: ComplexSelector,
  index: number,
): boolean {
  const part = complex[index]!;
  if (!matchesCompound(el, part.compound)) return false;
  if (index === 0) return true;

  const prevCombinator = complex[index - 1]!.combinator;
  if (prevCombinator === ">") {
    return (
      el.parent !== null &&
      el.parent.tagName !== "#document" &&
      matchesComplexAt(el.parent, complex, index - 1)
    );
  }
  if (prevCombinator === " ") {
    let ancestor = el.parent;
    while (ancestor !== null && ancestor.tagName !== "#document") {
      if (matchesComplexAt(ancestor, complex, index - 1)) return true;
      ancestor = ancestor.parent;
    }
    return false;
  }
  if (prevCombinator === "+") {
    const siblings = el.parent?.children ?? [];
    const idx = siblings.indexOf(el);
    return idx > 0 && matchesComplexAt(siblings[idx - 1]!, complex, index - 1);
  }
  if (prevCombinator === "~") {
    const siblings = el.parent?.children ?? [];
    const idx = siblings.indexOf(el);
    for (let i = idx - 1; i >= 0; i--) {
      if (matchesComplexAt(siblings[i]!, complex, index - 1)) return true;
    }
    return false;
  }
  return false;
}

function matchesCompound(el: HtmlNode, compound: CompoundSelector): boolean {
  if (
    compound.tag !== null &&
    compound.tag !== "*" &&
    el.tagName !== compound.tag
  ) {
    return false;
  }
  if (compound.id !== null && el.attrs.id !== compound.id) {
    return false;
  }
  if (compound.classes.length > 0) {
    const classList = (el.attrs.class ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const cls of compound.classes) {
      if (!classList.includes(cls)) return false;
    }
  }
  for (const attr of compound.attrs) {
    if (!matchesAttr(el, attr)) return false;
  }
  for (const pseudo of compound.pseudos) {
    if (!matchesPseudo(el, pseudo)) return false;
  }
  return true;
}

function matchesAttr(el: HtmlNode, attr: AttrSelector): boolean {
  if (!Object.hasOwn(el.attrs, attr.name)) return false;
  if (attr.operator === undefined) return true;
  const rawActual = el.attrs[attr.name]!;
  const actual = attr.caseInsensitive ? rawActual.toLowerCase() : rawActual;
  const expected = attr.caseInsensitive ? attr.value.toLowerCase() : attr.value;
  switch (attr.operator) {
    case "=":
      return actual === expected;
    case "~=":
      return expected !== "" && actual.trim().split(/\s+/).includes(expected);
    case "|=":
      return actual === expected || actual.startsWith(`${expected}-`);
    case "^=":
      return expected !== "" && actual.startsWith(expected);
    case "$=":
      return expected !== "" && actual.endsWith(expected);
    case "*=":
      return expected !== "" && actual.includes(expected);
  }
}

function matchesPseudo(el: HtmlNode, pseudo: PseudoSelector): boolean {
  const siblings = el.parent?.children ?? [];
  const index = siblings.indexOf(el);
  switch (pseudo.kind) {
    case "first-child":
      return index === 0;
    case "last-child":
      return index >= 0 && index === siblings.length - 1;
    case "only-child":
      return index === 0 && siblings.length === 1;
    case "empty":
      return (
        el.children.length === 0 &&
        el.parts.every((p) => typeof p === "string" && p === "")
      );
    case "nth-child": {
      if (index < 0) return false;
      const position = index + 1;
      if (pseudo.step === 0) return position === pseudo.offset;
      const diff = position - pseudo.offset;
      return diff / pseudo.step >= 0 && diff % pseudo.step === 0;
    }
    case "not":
      return !pseudo.selectors.some((complex) => matchesComplex(el, complex));
  }
}

/* ----------------------------------------------------------- HTML entities */

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
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

function decodeHtmlEntities(raw: string): string {
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
      return HTML_ENTITIES[token.toLowerCase()] ?? full;
    },
  );
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
