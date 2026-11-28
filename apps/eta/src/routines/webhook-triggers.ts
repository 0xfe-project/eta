/**
 * Built-in Inbound Webhook `TriggerProvider` (`provider = "webhook"`).
 *
 * - Exposes a single source (`http`: "Inbound Webhook") and trigger (`WEBHOOK_RECEIVED`) so the
 *   editor's single-option auto-selection and folding work seamlessly.
 * - Stores `tokenHash = sha256(token)` alongside AES-256-GCM sealed `token` and `secret` in
 *   `SettingStore` (`webhook.trigger.<routineId>`). Credentials never enter `routine_trigger.config_json`
 *   or eager `routines` wire broadcasts.
 * - Mounts `POST /hooks/<token>` on `product.fetch` with strict `/hooks/` prefix handling (never
 *   falling back to the web app), 256 KiB payload cap, per-routine in-memory sliding-window rate
 *   limiting, 3 auth modes (`none`, `header`, `hmac-sha256`), safe header filtering, delivery ID
 *   deduplication, keyword filtering, and immediate `202 Accepted` responses.
 */
import type {
  RoutineTrigger,
  TriggerCatalogItem,
  TriggerProviderStatus,
  WebhookAuthMode,
  WebhookTriggerInfo,
} from "@eta/client-contracts";
import type { SettingStore } from "../settings/store";
import type {
  TriggerProvider,
  TriggerProviderHost,
  TriggerProvisionResult,
} from "./triggers";
import { Buffer } from "node:buffer";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { decodeBody } from "@searxng-js/sex-egress";
import { seal, unseal } from "../secret";

const WEBHOOK_PROVIDER_ID = "webhook";
const WEBHOOK_SOURCE_SLUG = "http";
const WEBHOOK_SOURCE_NAME = "Inbound Webhook";
const WEBHOOK_TRIGGER_SLUG = "WEBHOOK_RECEIVED";
const HOOKS_PREFIX = "/hooks/";
const SETTING_KEY_PREFIX = "webhook.trigger.";

const DEFAULT_HEADER_AUTH_NAME = "Authorization";
const DEFAULT_HMAC_HEADER_NAME = "X-Hub-Signature-256";
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_RATE_LIMIT_MAX = 30;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_NORMALIZED_BODY_CHARS = 16_000;
const MAX_HEADER_VALUE_CHARS = 512;
const MAX_HEADERS = 32;
const MAX_QUERY_VALUE_CHARS = 512;
const MAX_QUERY_PARAMS = 32;
const MAX_EVENT_ID_CHARS = 256;
const MAX_SECRET_BYTES = 4_096;

const HEADER_TOKEN_RE = /^[!#$%&'*+.^`|~\w-]+$/;
const DELIVERY_ID_HEADERS = [
  "x-github-delivery",
  "x-delivery-id",
  "x-webhook-id",
  "idempotency-key",
] as const;

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-eta-token",
  "x-webhook-secret",
  "x-api-key",
  "x-auth-token",
  "x-secret",
  "webhook-secret",
  "stripe-signature",
  "svix-signature",
  "x-slack-signature",
  "linear-signature",
]);

const SENSITIVE_HEADER_PART_RE =
  /(?:^|-)(?:auth|authorization|cookie|secret|token|signature|sig|api-key|credential|password)(?:-|$)/i;

const SAFE_EXACT_HEADERS = new Set([
  "content-type",
  "user-agent",
  "idempotency-key",
]);

const SAFE_HEADER_PREFIXES = ["x-", "ce-"] as const;

interface WebhookEventPayload {
  method: "POST";
  contentType: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  truncated: boolean;
}

export interface WebhookTriggerProviderOptions {
  settings: SettingStore;
  secretKey: Buffer;
  publicUrl?: string | undefined;
  now?: (() => number) | undefined;
  maxBodyBytes?: number | undefined;
  rateLimitMax?: number | undefined;
  rateLimitWindowMs?: number | undefined;
  warn?: ((message: string) => void) | undefined;
}

interface ParsedWebhookConfig {
  authMode: WebhookAuthMode;
  headerName: string | null;
  includeKeywords: string[];
  excludeKeywords: string[];
}

interface PersistedWebhookState {
  tokenHash: string;
  sealedToken: string;
  sealedSecret: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ArmedWebhookBinding {
  routineId: string;
  instanceId: string;
  enabled: boolean;
  config: ParsedWebhookConfig;
  token: string;
  tokenHash: string;
  secret: string | null;
}

const WEBHOOK_CATALOG_ITEM: TriggerCatalogItem = {
  provider: WEBHOOK_PROVIDER_ID,
  source: WEBHOOK_SOURCE_SLUG,
  sourceName: WEBHOOK_SOURCE_NAME,
  trigger: WEBHOOK_TRIGGER_SLUG,
  name: "Webhook received",
  description:
    "Triggers when an external service sends an HTTP POST request to this routine's dedicated webhook URL.",
  modes: ["webhook"],
  configSchema: {
    type: "object",
    required: ["authMode"],
    properties: {
      authMode: {
        type: "string",
        title: "Authentication",
        description:
          "How incoming requests are verified in addition to the secret URL token.",
        enum: ["none", "header", "hmac-sha256"],
        enumNames: [
          "URL token only (none)",
          "Shared secret header",
          "HMAC-SHA256 signature",
        ],
        default: "none",
      },
      headerName: {
        type: "string",
        title: "Header name",
        description:
          "Optional HTTP header name (defaults to Authorization for header auth, or X-Hub-Signature-256 for HMAC-SHA256).",
        examples: ["X-Webhook-Secret"],
      },
      includeKeywords: {
        type: "string",
        title: "Include keywords",
        description:
          "Optional comma-separated keywords (case-insensitive). Payload text must match at least one.",
        examples: ["deploy, release"],
      },
      excludeKeywords: {
        type: "string",
        title: "Exclude keywords",
        description:
          "Optional comma-separated keywords (case-insensitive). Skip requests matching any keyword.",
        examples: ["ping, healthcheck"],
      },
    },
  },
  payloadSchema: {
    type: "object",
    properties: {
      method: { type: "string" },
      contentType: { type: "string" },
      headers: { type: "object" },
      query: { type: "object" },
      body: {},
      truncated: { type: "boolean" },
    },
  },
  accounts: [],
};

export class WebhookTriggerProvider implements TriggerProvider {
  readonly id = WEBHOOK_PROVIDER_ID;

  readonly #settings: SettingStore;
  readonly #secretKey: Buffer;
  readonly #publicOrigin: string | null;
  readonly #now: () => number;
  readonly #maxBodyBytes: number;
  readonly #rateLimitMax: number;
  readonly #rateLimitWindowMs: number;
  readonly #warn: (message: string) => void;

  #host: TriggerProviderHost | undefined;
  #started = false;
  #stopped = false;

  readonly #byRoutine = new Map<string, ArmedWebhookBinding>();
  readonly #byTokenHash = new Map<string, ArmedWebhookBinding>();
  readonly #rateWindows = new Map<string, number[]>();

  constructor(options: WebhookTriggerProviderOptions) {
    this.#settings = options.settings;
    this.#secretKey = options.secretKey;
    this.#publicOrigin = originOf(options.publicUrl);
    this.#now = options.now ?? Date.now;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#rateLimitMax = options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
    this.#rateLimitWindowMs =
      options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  status(): TriggerProviderStatus {
    return { provider: this.id, status: "ready" };
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
      sourceFilter !== WEBHOOK_SOURCE_SLUG
    ) {
      return [];
    }
    const query = filter?.query?.trim().toLowerCase();
    if (query !== undefined && query !== "") {
      const haystack = [
        WEBHOOK_CATALOG_ITEM.provider,
        WEBHOOK_CATALOG_ITEM.source,
        WEBHOOK_CATALOG_ITEM.sourceName,
        WEBHOOK_CATALOG_ITEM.trigger,
        WEBHOOK_CATALOG_ITEM.name,
        WEBHOOK_CATALOG_ITEM.description,
      ]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(query)) return [];
    }
    return [WEBHOOK_CATALOG_ITEM];
  }

  async provision(input: {
    routineId: string;
    trigger: RoutineTrigger;
    enabled: boolean;
    existingInstanceId: string | null;
  }): Promise<TriggerProvisionResult> {
    const config = parseWebhookConfig(input.trigger);
    this.#ensureCredentials(input.routineId, config);
    const instanceId = instanceIdOf(input.routineId);
    this.syncBindings();
    return {
      instanceId,
      accountId: null,
      mode: "webhook",
      pollingIntervalMinutes: null,
      fallbackReason: null,
      active: input.enabled,
    };
  }

  async setEnabled(instanceId: string, enabled: boolean): Promise<void> {
    const routineId = routineIdOf(instanceId);
    if (routineId !== null) {
      const binding = this.#host
        ?.bindings()
        .find(
          (item) =>
            item.routineId === routineId && item.trigger.provider === this.id,
        );
      if (binding !== undefined) {
        try {
          const config = parseWebhookConfig(binding.trigger);
          if (enabled || this.#loadUnsealedState(routineId) !== undefined) {
            this.#ensureCredentials(routineId, config);
          }
        } catch (error) {
          this.#warn(
            `[eta] webhook binding ${routineId} has invalid config: ${errorMessage(error)}`,
          );
        }
      }
    }
    this.syncBindings();
  }

  async deleteInstance(instanceId: string): Promise<void> {
    const routineId = routineIdOf(instanceId);
    if (routineId === null) return;
    this.#settings.delete(settingKey(routineId));
    this.#evictRoutine(routineId);
    this.#rateWindows.delete(routineId);
  }

  start(host: TriggerProviderHost): void {
    this.#host = host;
    this.#stopped = false;
    this.#started = true;
    this.syncBindings();
  }

  syncBindings(): void {
    if (!this.#started || this.#stopped) return;
    const bindings = this.#host?.bindings() ?? [];
    const nextByRoutine = new Map<string, ArmedWebhookBinding>();
    const nextByTokenHash = new Map<string, ArmedWebhookBinding>();

    for (const binding of bindings) {
      if (binding.trigger.provider !== this.id) continue;
      let config: ParsedWebhookConfig;
      try {
        config = parseWebhookConfig(binding.trigger);
      } catch (error) {
        this.#warn(
          `[eta] webhook binding ${binding.routineId} has invalid config: ${errorMessage(error)}`,
        );
        continue;
      }

      const loaded = this.#loadUnsealedState(binding.routineId);
      if (loaded === undefined) continue;

      const armed: ArmedWebhookBinding = {
        routineId: binding.routineId,
        instanceId: binding.instanceId ?? instanceIdOf(binding.routineId),
        enabled: binding.enabled,
        config,
        token: loaded.token,
        tokenHash: loaded.tokenHash,
        secret: loaded.secret,
      };
      nextByRoutine.set(armed.routineId, armed);
      nextByTokenHash.set(armed.tokenHash, armed);
    }

    this.#byRoutine.clear();
    this.#byTokenHash.clear();
    for (const [id, entry] of nextByRoutine) this.#byRoutine.set(id, entry);
    for (const [hash, entry] of nextByTokenHash) {
      this.#byTokenHash.set(hash, entry);
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#started = false;
    this.#byRoutine.clear();
    this.#byTokenHash.clear();
    this.#rateWindows.clear();
  }

  /** Returns the endpoint path, publicUrl (if configured), and decrypted credentials for the UI. */
  info(routineId: string, trigger: RoutineTrigger): WebhookTriggerInfo {
    const config = parseWebhookConfig(trigger);
    const creds = this.#ensureCredentials(routineId, config);
    this.syncBindings();
    return this.#formatInfo(routineId, config, creds.token, creds.secret);
  }

  /** Rotates the URL token and/or authentication secret, invalidating old credentials immediately. */
  rotate(
    routineId: string,
    trigger: RoutineTrigger,
    options: { rotateToken?: boolean; rotateSecret?: boolean } = {},
  ): WebhookTriggerInfo {
    const config = parseWebhookConfig(trigger);
    const rotateToken =
      options.rotateToken ?? options.rotateSecret === undefined;
    const rotateSecret =
      options.rotateSecret ??
      (options.rotateToken === undefined ? config.authMode !== "none" : false);

    if (!rotateToken && !rotateSecret) {
      return this.info(routineId, trigger);
    }

    const current = this.#ensureCredentials(routineId, config);
    const now = this.#now();
    const nextToken = rotateToken ? generateToken() : current.token;
    const nextTokenHash = sha256Hex(nextToken);
    let nextSecret = current.secret;
    if (config.authMode === "none") {
      nextSecret = null;
    } else if (rotateSecret || nextSecret === null) {
      nextSecret = generateSecret();
    }

    this.#saveState(routineId, {
      tokenHash: nextTokenHash,
      sealedToken: this.#sealText(nextToken),
      sealedSecret: nextSecret === null ? null : this.#sealText(nextSecret),
      createdAt: current.createdAt,
      updatedAt: now,
    });
    this.#evictRoutine(routineId);
    this.syncBindings();
    return this.#formatInfo(routineId, config, nextToken, nextSecret);
  }

  /** Stores a user-supplied webhook verification secret (e.g. GitHub/Stripe/Linear secret). */
  setSecret(
    routineId: string,
    trigger: RoutineTrigger,
    rawSecret: string,
  ): WebhookTriggerInfo {
    const config = parseWebhookConfig(trigger);
    if (config.authMode === "none") {
      throw new Error(
        "Enable header or hmac-sha256 authentication before setting a webhook secret",
      );
    }
    const secret = rawSecret.trim();
    if (secret === "") {
      throw new Error("Webhook secret cannot be empty");
    }
    if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
      throw new Error(
        `Webhook secret exceeds maximum length of ${MAX_SECRET_BYTES} bytes`,
      );
    }

    const current = this.#ensureCredentials(routineId, config);
    const now = this.#now();
    this.#saveState(routineId, {
      tokenHash: current.tokenHash,
      sealedToken: this.#sealText(current.token),
      sealedSecret: this.#sealText(secret),
      createdAt: current.createdAt,
      updatedAt: now,
    });
    this.syncBindings();
    return this.#formatInfo(routineId, config, current.token, secret);
  }

  /**
   * HTTP handler for `product.fetch`: handles every `/hooks/*` path strictly without falling back
   * to the web page.
   */
  async route(request: Request): Promise<Response | undefined> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return undefined;
    }
    if (!url.pathname.startsWith(HOOKS_PREFIX)) return undefined;

    if (request.method !== "POST") {
      return jsonResponse(
        405,
        { ok: false, error: "method not allowed" },
        { allow: "POST" },
      );
    }

    const rawSegment = url.pathname.slice(HOOKS_PREFIX.length);
    if (rawSegment === "" || rawSegment.includes("/")) {
      return jsonResponse(404, { ok: false, error: "not found" });
    }
    let token: string;
    try {
      token = decodeURIComponent(rawSegment);
    } catch {
      return jsonResponse(404, { ok: false, error: "not found" });
    }
    if (token === "") {
      return jsonResponse(404, { ok: false, error: "not found" });
    }

    const entry = this.#byTokenHash.get(sha256Hex(token));
    if (entry === undefined || !safeEqualText(token, entry.token)) {
      return jsonResponse(404, { ok: false, error: "not found" });
    }

    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength.trim());
      if (Number.isFinite(parsedLength) && parsedLength > this.#maxBodyBytes) {
        return jsonResponse(413, { ok: false, error: "payload too large" });
      }
    }

    let rawBody: Uint8Array;
    try {
      rawBody = await readLimitedBody(request, this.#maxBodyBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return jsonResponse(413, { ok: false, error: "payload too large" });
      }
      return jsonResponse(400, { ok: false, error: "unable to read body" });
    }

    const retryAfterSec = this.#checkRateLimit(entry.routineId);
    if (retryAfterSec !== undefined) {
      return jsonResponse(
        429,
        { ok: false, error: "rate limit exceeded" },
        { "retry-after": String(retryAfterSec) },
      );
    }

    if (!this.#verifyAuth(request, entry, rawBody)) {
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }

    if (!entry.enabled) {
      return jsonResponse(202, {
        ok: true,
        accepted: false,
        reason: "disabled",
      });
    }

    const rawContentType = request.headers.get("content-type") ?? "";
    const parsedBody = parseWebhookBody(rawBody, rawContentType);
    if (!parsedBody.ok) {
      return jsonResponse(400, { ok: false, error: parsedBody.error });
    }

    const authHeader = effectiveHeaderName(entry.config);
    const headers = extractSafeHeaders(request.headers, authHeader);
    const query = extractSafeQuery(url.searchParams);
    const normalized = normalizeBody(parsedBody.body);
    const payload: WebhookEventPayload = {
      method: "POST",
      contentType: parsedBody.mediaType || "text/plain",
      headers,
      query,
      body: normalized.body,
      truncated: normalized.truncated,
    };

    if (!matchesWebhookKeywords(payload, entry.config)) {
      return jsonResponse(202, {
        ok: true,
        accepted: false,
        reason: "filtered",
      });
    }

    const eventId = extractEventId(request.headers);
    this.#host?.onEvent({
      provider: WEBHOOK_PROVIDER_ID,
      instanceId: entry.instanceId,
      routineId: entry.routineId,
      triggerSlug: WEBHOOK_TRIGGER_SLUG,
      source: WEBHOOK_SOURCE_SLUG,
      accountId: null,
      eventId,
      occurredAt: this.#now(),
      payload,
    });

    return jsonResponse(202, { ok: true, accepted: true, eventId });
  }

  #verifyAuth(
    request: Request,
    entry: ArmedWebhookBinding,
    rawBody: Uint8Array,
  ): boolean {
    const authMode = entry.config.authMode;
    if (authMode === "none") return true;
    const secret = entry.secret;
    const headerName = effectiveHeaderName(entry.config);
    if (!secret || !headerName) return false;
    const headerVal = request.headers.get(headerName);
    if (headerVal === null || headerVal.trim() === "") return false;

    if (authMode === "header") {
      const trimmed = headerVal.trim();
      if (safeEqualText(trimmed, secret)) return true;
      const bearer = /^Bearer[ \t]+(\S.*)$/i.exec(trimmed);
      if (bearer !== null && safeEqualText(bearer[1]!.trim(), secret)) {
        return true;
      }
      return false;
    }

    // hmac-sha256
    const trimmed = headerVal.trim();
    const sigHex = /^sha256=/i.test(trimmed)
      ? trimmed.slice(7).trim()
      : trimmed;
    if (!/^[0-9a-f]{64}$/i.test(sigHex)) return false;
    const expectedHex = createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    return timingSafeEqual(
      Buffer.from(sigHex.toLowerCase(), "hex"),
      Buffer.from(expectedHex, "hex"),
    );
  }

  #checkRateLimit(routineId: string): number | undefined {
    const now = this.#now();
    const cutoff = now - this.#rateLimitWindowMs;
    const hits = (this.#rateWindows.get(routineId) ?? []).filter(
      (ts) => ts > cutoff,
    );
    if (hits.length >= this.#rateLimitMax) {
      this.#rateWindows.set(routineId, hits);
      return Math.max(
        1,
        Math.ceil((hits[0]! + this.#rateLimitWindowMs - now) / 1000),
      );
    }
    hits.push(now);
    this.#rateWindows.set(routineId, hits);
    return undefined;
  }

  #ensureCredentials(
    routineId: string,
    config: ParsedWebhookConfig,
  ): {
    token: string;
    tokenHash: string;
    secret: string | null;
    createdAt: number;
  } {
    const now = this.#now();
    const loaded = this.#loadUnsealedState(routineId);
    if (loaded !== undefined) {
      let secret = loaded.secret;
      let changed = false;
      if (config.authMode === "none" && secret !== null) {
        secret = null;
        changed = true;
      } else if (config.authMode !== "none" && secret === null) {
        secret = generateSecret();
        changed = true;
      }
      if (changed) {
        this.#saveState(routineId, {
          tokenHash: loaded.tokenHash,
          sealedToken: this.#sealText(loaded.token),
          sealedSecret: secret === null ? null : this.#sealText(secret),
          createdAt: loaded.createdAt,
          updatedAt: now,
        });
      }
      return {
        token: loaded.token,
        tokenHash: loaded.tokenHash,
        secret,
        createdAt: loaded.createdAt,
      };
    }

    const token = generateToken();
    const tokenHash = sha256Hex(token);
    const secret = config.authMode === "none" ? null : generateSecret();
    this.#saveState(routineId, {
      tokenHash,
      sealedToken: this.#sealText(token),
      sealedSecret: secret === null ? null : this.#sealText(secret),
      createdAt: now,
      updatedAt: now,
    });
    return { token, tokenHash, secret, createdAt: now };
  }

  #loadUnsealedState(routineId: string):
    | {
        token: string;
        tokenHash: string;
        secret: string | null;
        createdAt: number;
      }
    | undefined {
    const raw = this.#settings.get(settingKey(routineId));
    if (!isPersistedState(raw)) return undefined;
    const token = this.#unsealText(raw.sealedToken);
    if (token === undefined || token === "") return undefined;
    if (!safeEqualText(sha256Hex(token), raw.tokenHash)) return undefined;

    let secret: string | null = null;
    if (raw.sealedSecret !== null) {
      const unsealed = this.#unsealText(raw.sealedSecret);
      if (unsealed !== undefined && unsealed !== "") secret = unsealed;
    }
    return {
      token,
      tokenHash: raw.tokenHash,
      secret,
      createdAt: raw.createdAt,
    };
  }

  #saveState(routineId: string, state: PersistedWebhookState): void {
    this.#settings.set(settingKey(routineId), state);
  }

  #sealText(plaintext: string): string {
    return seal(this.#secretKey, plaintext).toString("base64");
  }

  #unsealText(encoded: string): string | undefined {
    try {
      return unseal(this.#secretKey, Buffer.from(encoded, "base64"));
    } catch {
      return undefined;
    }
  }

  #evictRoutine(routineId: string): void {
    const existing = this.#byRoutine.get(routineId);
    if (existing !== undefined) {
      this.#byRoutine.delete(routineId);
      if (this.#byTokenHash.get(existing.tokenHash) === existing) {
        this.#byTokenHash.delete(existing.tokenHash);
      }
    }
  }

  #formatInfo(
    routineId: string,
    config: ParsedWebhookConfig,
    token: string,
    secret: string | null,
  ): WebhookTriggerInfo {
    const path = `${HOOKS_PREFIX}${token}`;
    return {
      routineId,
      path,
      publicUrl:
        this.#publicOrigin === null ? null : `${this.#publicOrigin}${path}`,
      authMode: config.authMode,
      headerName: effectiveHeaderName(config),
      hasSecret: secret !== null,
      secret,
    };
  }
}

/* ----------------------------------------------------------- config & state */

function parseWebhookConfig(trigger: RoutineTrigger): ParsedWebhookConfig {
  if (trigger.source !== WEBHOOK_SOURCE_SLUG) {
    throw new Error(`Webhook trigger source must be "${WEBHOOK_SOURCE_SLUG}"`);
  }
  if (trigger.trigger !== WEBHOOK_TRIGGER_SLUG) {
    throw new Error(`Webhook trigger slug must be "${WEBHOOK_TRIGGER_SLUG}"`);
  }
  if (
    trigger.mode !== undefined &&
    trigger.mode !== null &&
    trigger.mode !== "webhook"
  ) {
    throw new Error('Webhook trigger only supports "webhook" mode');
  }
  if (
    trigger.pollingIntervalMinutes !== undefined &&
    trigger.pollingIntervalMinutes !== null
  ) {
    throw new Error("Webhook trigger does not support pollingIntervalMinutes");
  }

  const cfg = isPlain(trigger.config) ? trigger.config : {};
  if (cfg.secret !== undefined || cfg.token !== undefined) {
    throw new Error("Webhook credentials must not be stored in trigger.config");
  }

  const rawAuthMode = cfg.authMode ?? "none";
  if (
    rawAuthMode !== "none" &&
    rawAuthMode !== "header" &&
    rawAuthMode !== "hmac-sha256"
  ) {
    throw new TypeError(
      'Webhook config.authMode must be "none", "header", or "hmac-sha256"',
    );
  }

  let headerName: string | null = null;
  if (cfg.headerName !== undefined && cfg.headerName !== null) {
    if (typeof cfg.headerName !== "string") {
      throw new TypeError("Webhook config.headerName must be a string");
    }
    const trimmed = cfg.headerName.trim();
    if (trimmed !== "") {
      if (!HEADER_TOKEN_RE.test(trimmed)) {
        throw new TypeError(
          "Webhook config.headerName must be a valid HTTP header name",
        );
      }
      headerName = trimmed;
    }
  }

  return {
    authMode: rawAuthMode,
    headerName,
    includeKeywords: parseKeywords(cfg.includeKeywords, "includeKeywords"),
    excludeKeywords: parseKeywords(cfg.excludeKeywords, "excludeKeywords"),
  };
}

function effectiveHeaderName(config: ParsedWebhookConfig): string | null {
  if (config.authMode === "none") return null;
  if (config.headerName !== null) return config.headerName;
  return config.authMode === "header"
    ? DEFAULT_HEADER_AUTH_NAME
    : DEFAULT_HMAC_HEADER_NAME;
}

function parseKeywords(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string") {
    throw new TypeError(`Webhook config.${field} must be a string`);
  }
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
}

function isPersistedState(value: unknown): value is PersistedWebhookState {
  return (
    isPlain(value) &&
    typeof value.tokenHash === "string" &&
    value.tokenHash !== "" &&
    typeof value.sealedToken === "string" &&
    value.sealedToken !== "" &&
    (value.sealedSecret === null || typeof value.sealedSecret === "string") &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function settingKey(routineId: string): string {
  return `${SETTING_KEY_PREFIX}${routineId}`;
}

function instanceIdOf(routineId: string): string {
  return `${WEBHOOK_PROVIDER_ID}:${routineId}`;
}

function routineIdOf(instanceId: string): string | null {
  const prefix = `${WEBHOOK_PROVIDER_ID}:`;
  if (!instanceId.startsWith(prefix)) return null;
  const id = instanceId.slice(prefix.length).trim();
  return id === "" ? null : id;
}

/* ----------------------------------------------------------- HTTP & crypto */

class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large");
  }
}

async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function parseWebhookBody(
  rawBody: Uint8Array,
  rawContentType: string,
):
  | { ok: true; mediaType: string; body: unknown }
  | { ok: false; error: string } {
  const mediaType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (rawBody.byteLength === 0) {
    return { ok: true, mediaType, body: null };
  }

  let text: string;
  try {
    text = decodeBody(rawBody, rawContentType);
  } catch {
    text = new TextDecoder("utf-8", { fatal: false }).decode(rawBody);
  }

  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    try {
      return { ok: true, mediaType, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, error: "invalid JSON body" };
    }
  }

  if (mediaType === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams(text);
    const form: Record<string, string | string[]> = {};
    for (const [key, value] of params.entries()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      const existing = form[key];
      if (existing === undefined) {
        form[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        form[key] = [existing, value];
      }
    }
    return { ok: true, mediaType, body: form };
  }

  if (mediaType === "text/plain" || mediaType.startsWith("text/")) {
    return { ok: true, mediaType, body: text };
  }

  if (mediaType === "") {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return {
          ok: true,
          mediaType: "application/json",
          body: JSON.parse(trimmed) as unknown,
        };
      } catch {
        // Fall through to plain text when no explicit JSON content-type was sent.
      }
    }
    return { ok: true, mediaType: "text/plain", body: text };
  }

  return {
    ok: true,
    mediaType,
    body: {
      _rawText: text.slice(0, MAX_NORMALIZED_BODY_CHARS),
      _bytes: rawBody.byteLength,
    },
  };
}

function normalizeBody(body: unknown): { body: unknown; truncated: boolean } {
  if (body === null || body === undefined) {
    return { body: body ?? null, truncated: false };
  }
  if (typeof body === "string") {
    if (body.length <= MAX_NORMALIZED_BODY_CHARS) {
      return { body, truncated: false };
    }
    return {
      body: `${body.slice(0, MAX_NORMALIZED_BODY_CHARS)}…`,
      truncated: true,
    };
  }
  try {
    const serialized = JSON.stringify(body);
    if (serialized === undefined) return { body: null, truncated: false };
    if (serialized.length <= MAX_NORMALIZED_BODY_CHARS) {
      return { body, truncated: false };
    }
    return {
      body: {
        _truncated: true,
        preview: `${serialized.slice(0, MAX_NORMALIZED_BODY_CHARS)}…`,
      },
      truncated: true,
    };
  } catch {
    return {
      body: String(body).slice(0, MAX_NORMALIZED_BODY_CHARS),
      truncated: true,
    };
  }
}

function extractSafeHeaders(
  headers: Headers,
  configuredAuthHeader: string | null,
): Record<string, string> {
  const blockedAuth = configuredAuthHeader?.toLowerCase();
  const out: Record<string, string> = {};
  let count = 0;

  headers.forEach((value, rawName) => {
    if (count >= MAX_HEADERS) return;
    const name = rawName.toLowerCase();
    if (name === blockedAuth) return;
    if (isSensitiveHeader(name)) return;
    if (!isAllowedMetadataHeader(name)) return;
    out[name] =
      value.length <= MAX_HEADER_VALUE_CHARS
        ? value
        : `${value.slice(0, MAX_HEADER_VALUE_CHARS)}…`;
    count++;
  });

  return out;
}

function isSensitiveHeader(name: string): boolean {
  if (SENSITIVE_HEADER_NAMES.has(name)) return true;
  if (name.startsWith("x-hub-signature")) return true;
  if (name === "idempotency-key") return false;
  return SENSITIVE_HEADER_PART_RE.test(name);
}

function isAllowedMetadataHeader(name: string): boolean {
  if (SAFE_EXACT_HEADERS.has(name)) return true;
  return SAFE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function extractSafeQuery(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of params.entries()) {
    if (count >= MAX_QUERY_PARAMS) break;
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    out[key] =
      value.length <= MAX_QUERY_VALUE_CHARS
        ? value
        : `${value.slice(0, MAX_QUERY_VALUE_CHARS)}…`;
    count++;
  }
  return out;
}

function extractEventId(headers: Headers): string {
  for (const name of DELIVERY_ID_HEADERS) {
    const raw = headers.get(name)?.trim() ?? "";
    if (raw !== "") {
      return raw.slice(0, MAX_EVENT_ID_CHARS);
    }
  }
  return crypto.randomUUID();
}

function matchesWebhookKeywords(
  payload: WebhookEventPayload,
  config: ParsedWebhookConfig,
): boolean {
  if (
    config.includeKeywords.length === 0 &&
    config.excludeKeywords.length === 0
  ) {
    return true;
  }
  const bodyText =
    typeof payload.body === "string"
      ? payload.body
      : JSON.stringify(payload.body ?? "");
  const headerText = Object.values(payload.headers).join("\n");
  const queryText = Object.entries(payload.query)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const haystack = `${bodyText}\n${headerText}\n${queryText}`.toLowerCase();

  if (
    config.includeKeywords.length > 0 &&
    !config.includeKeywords.some((kw) => haystack.includes(kw))
  ) {
    return false;
  }
  if (
    config.excludeKeywords.length > 0 &&
    config.excludeKeywords.some((kw) => haystack.includes(kw))
  ) {
    return false;
  }
  return true;
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqualText(a: string, b: string): boolean {
  return timingSafeEqual(sha256Digest(a), sha256Digest(b));
}

function originOf(text: string | undefined): string | null {
  if (text === undefined || text.trim() === "") return null;
  try {
    const url = new URL(text.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
