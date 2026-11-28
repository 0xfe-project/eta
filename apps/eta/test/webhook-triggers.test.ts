/**
 * Tests for built-in Inbound Webhook trigger provider (`WebhookTriggerProvider`):
 * - Catalog metadata, filtering (`source`, `query`), and config validation
 * - Encrypted persistence (`SettingStore` via `seal`/`unseal`), no plaintext secret in
 *   `routine_trigger.config_json` or eager `routines` wire state, restart recovery, and revocation
 * - Token & secret rotation (`routines.webhookRotate`) and custom secret (`routines.webhookSetSecret`)
 * - HTTP route `POST /hooks/<token>`: 405, 404, 413 (>256 KiB), 429 rate limit, 401 auth (`none`,
 *   `header` Bearer/raw + custom header, `hmac-sha256` sha256=/raw + custom header + tampered body),
 *   token-gate exemption, `cache-control: no-store` & `referrer-policy: no-referrer`
 * - JSON / form-urlencoded / text/plain parsing, truncation, sensitive header stripping,
 *   keyword filtering, delivery ID priority & idempotency dedupe, disabled routine 202 response,
 *   and end-to-end execution via `TriggerHub` + `RoutineRunner`
 */
import type {
  RoutineArgs,
  RoutineSummary,
  RunView,
  TriggerCatalogItem,
  TriggerProviderStatus,
  WebhookTriggerInfo,
} from "@eta/client-contracts";
import type { HostOptions } from "../src/host";
import type { IncomingTriggerEvent } from "../src/routines/triggers";
import type { Request as ModelRequest } from "./support/models";
import { createHmac, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db";
import {
  TRIGGER_EVENTS_CLOSE,
  TRIGGER_EVENTS_OPEN,
} from "../src/routines/prompts";
import { WebhookTriggerProvider } from "../src/routines/webhook-triggers";
import { SettingStore } from "../src/settings/store";
import { connect, until } from "./support/client";
import { tempDir, testHost } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const isRun = (request: ModelRequest): boolean =>
  (request.transcript[0] ?? "").includes("<routine-run>");
const step = (request: ModelRequest): number =>
  request.transcript.filter((line) => line.startsWith("assistant:")).length;
const report = (title: string, body: string) => call("report", { title, body });

function makeMemorySettings(): SettingStore {
  const db = openDatabase(":memory:");
  db.exec(
    "CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  return new SettingStore(db);
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("webhook trigger provider unit behavior", () => {
  const providers: WebhookTriggerProvider[] = [];
  afterEach(() => {
    for (const provider of providers.splice(0)) provider.stop();
  });

  it("exposes ready status, catalog filtering, and config validation", async () => {
    const provider = new WebhookTriggerProvider({
      settings: makeMemorySettings(),
      secretKey: randomBytes(32),
      warn: () => undefined,
    });
    providers.push(provider);

    expect(provider.status()).toEqual({ provider: "webhook", status: "ready" });
    const all = await provider.listTriggers();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      provider: "webhook",
      source: "http",
      sourceName: "Inbound Webhook",
      trigger: "WEBHOOK_RECEIVED",
      modes: ["webhook"],
      accounts: [],
    });
    expect(await provider.listTriggers({ source: "other" })).toEqual([]);
    expect(await provider.listTriggers({ query: "inbound webhook" })).toEqual(
      all,
    );
    expect(await provider.listTriggers({ query: "nonexistent" })).toEqual([]);

    await expect(
      provider.provision({
        routineId: "r-bad-mode",
        trigger: {
          provider: "webhook",
          source: "http",
          trigger: "WEBHOOK_RECEIVED",
          mode: "poll",
        },
        enabled: true,
        existingInstanceId: null,
      }),
    ).rejects.toThrow(/webhook/i);

    await expect(
      provider.provision({
        routineId: "r-bad-auth",
        trigger: {
          provider: "webhook",
          source: "http",
          trigger: "WEBHOOK_RECEIVED",
          config: { authMode: "oauth" },
        },
        enabled: true,
        existingInstanceId: null,
      }),
    ).rejects.toThrow(/authMode/);

    await expect(
      provider.provision({
        routineId: "r-bad-hdr",
        trigger: {
          provider: "webhook",
          source: "http",
          trigger: "WEBHOOK_RECEIVED",
          config: { authMode: "header", headerName: "Bad Header\r\n" },
        },
        enabled: true,
        existingInstanceId: null,
      }),
    ).rejects.toThrow(/headerName/);

    await expect(
      provider.provision({
        routineId: "r-secret-in-cfg",
        trigger: {
          provider: "webhook",
          source: "http",
          trigger: "WEBHOOK_RECEIVED",
          config: { authMode: "header", secret: "leaked" },
        },
        enabled: true,
        existingInstanceId: null,
      }),
    ).rejects.toThrow(/credentials/i);
  });

  it("enforces HTTP method, 404, 413 body limit, 429 rate limit, auth modes, parsing, header stripping, keywords, and disabled status", async () => {
    const settings = makeMemorySettings();
    const secretKey = randomBytes(32);
    let currentTime = 1_700_000_000_000;
    const events: IncomingTriggerEvent[] = [];

    const trigger = {
      provider: "webhook",
      source: "http",
      trigger: "WEBHOOK_RECEIVED",
      mode: "webhook" as const,
      config: {
        authMode: "hmac-sha256",
        includeKeywords: "deploy, release",
        excludeKeywords: "dry-run",
      },
    };

    const provider = new WebhookTriggerProvider({
      settings,
      secretKey,
      publicUrl: "https://hooks.example.com/base",
      now: () => currentTime,
      rateLimitMax: 3,
      rateLimitWindowMs: 60_000,
      warn: () => undefined,
    });
    providers.push(provider);

    let enabled = true;
    provider.start({
      bindings: () => [
        {
          routineId: "r1",
          enabled,
          trigger,
          instanceId: "webhook:r1",
        },
      ],
      onEvent: (event) => events.push(event),
      onBindingsChanged: () => undefined,
    });

    await provider.provision({
      routineId: "r1",
      trigger,
      enabled: true,
      existingInstanceId: null,
    });

    const info = provider.info("r1", trigger);
    expect(info.path).toMatch(/^\/hooks\/[\w-]{32}$/);
    expect(info.publicUrl).toBe(`https://hooks.example.com${info.path}`);
    expect(info.authMode).toBe("hmac-sha256");
    expect(info.headerName).toBe("X-Hub-Signature-256");
    expect(info.hasSecret).toBe(true);
    expect(info.secret).toMatch(/^[0-9a-f]{64}$/);

    // Stored record in SettingStore does not contain plaintext token or secret.
    const rawSetting = JSON.stringify(settings.get("webhook.trigger.r1"));
    const token = info.path.slice("/hooks/".length);
    expect(rawSetting).not.toContain(token);
    expect(rawSetting).not.toContain(info.secret!);

    // Non-POST -> 405 with security headers
    const getResp = await provider.route(
      new Request(`http://localhost${info.path}`, { method: "GET" }),
    );
    expect(getResp?.status).toBe(405);
    expect(getResp?.headers.get("allow")).toBe("POST");
    expect(getResp?.headers.get("cache-control")).toBe("no-store");
    expect(getResp?.headers.get("referrer-policy")).toBe("no-referrer");

    // Unknown token -> 404
    const unknownResp = await provider.route(
      new Request("http://localhost/hooks/does-not-exist", { method: "POST" }),
    );
    expect(unknownResp?.status).toBe(404);
    expect(unknownResp?.headers.get("cache-control")).toBe("no-store");
    expect(unknownResp?.headers.get("referrer-policy")).toBe("no-referrer");

    // >256 KiB -> 413 (chunked stream without Content-Length)
    const oversized = new Uint8Array(256 * 1024 + 1);
    oversized.fill(0x61);
    const largeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const largeResp = await provider.route(
      new Request(`http://localhost${info.path}`, {
        method: "POST",
        body: largeStream,
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(largeResp?.status).toBe(413);

    // Bad HMAC -> 401 (consumes 1 of 3 rate limit slots)
    const body1 = JSON.stringify({ action: "deploy", tag: "v1.0" });
    const badHmacResp = await provider.route(
      new Request(`http://localhost${info.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        body: body1,
      }),
    );
    expect(badHmacResp?.status).toBe(401);

    // Valid HMAC with sha256= prefix + sensitive headers stripped -> 202 accepted: true
    const okResp = await provider.route(
      new Request(`http://localhost${info.path}?env=prod`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${hmacHex(info.secret!, body1)}`,
          "x-hub-signature": "sha1=legacy",
          authorization: "Bearer top-secret",
          cookie: "session=secret",
          "x-webhook-secret": "should-strip",
          "x-github-event": "deployment",
          "x-github-delivery": "gh-deliv-1",
          "x-delivery-id": "fallback-deliv",
        },
        body: body1,
      }),
    );
    expect(okResp?.status).toBe(202);
    expect(await okResp?.json()).toEqual({
      ok: true,
      accepted: true,
      eventId: "gh-deliv-1",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe("gh-deliv-1");
    expect(events[0]!.payload).toEqual({
      method: "POST",
      contentType: "application/json",
      headers: {
        "content-type": "application/json",
        "x-github-event": "deployment",
        "x-github-delivery": "gh-deliv-1",
        "x-delivery-id": "fallback-deliv",
      },
      query: { env: "prod" },
      body: { action: "deploy", tag: "v1.0" },
      truncated: false,
    });

    // Keyword filtering (excludeKeywords "dry-run") -> 202 accepted: false, reason: "filtered"
    const excludedBody = JSON.stringify({ action: "deploy", note: "dry-run" });
    const filteredResp = await provider.route(
      new Request(`http://localhost${info.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": hmacHex(info.secret!, excludedBody),
        },
        body: excludedBody,
      }),
    );
    expect(filteredResp?.status).toBe(202);
    expect(await filteredResp?.json()).toEqual({
      ok: true,
      accepted: false,
      reason: "filtered",
    });
    expect(events).toHaveLength(1);

    // 4th request within 60s window -> 429 rate limited
    const rateLimitedResp = await provider.route(
      new Request(`http://localhost${info.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${hmacHex(info.secret!, body1)}`,
        },
        body: body1,
      }),
    );
    expect(rateLimitedResp?.status).toBe(429);
    expect(rateLimitedResp?.headers.get("retry-after")).toBe("60");

    // Advance clock past window & test disabled state
    currentTime += 61_000;
    enabled = false;
    provider.syncBindings();
    const disabledResp = await provider.route(
      new Request(`http://localhost${info.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${hmacHex(info.secret!, body1)}`,
        },
        body: body1,
      }),
    );
    expect(disabledResp?.status).toBe(202);
    expect(await disabledResp?.json()).toEqual({
      ok: true,
      accepted: false,
      reason: "disabled",
    });

    // deleteInstance revokes token immediately
    await provider.deleteInstance("webhook:r1");
    expect(settings.get("webhook.trigger.r1")).toBeUndefined();
    const afterDeleteResp = await provider.route(
      new Request(`http://localhost${info.path}`, { method: "POST" }),
    );
    expect(afterDeleteResp?.status).toBe(404);
  });

  it("rejects missing/tampered HMAC, enforces includeKeywords & default Authorization header, and sets truncated=true on >16k payloads", async () => {
    const settings = makeMemorySettings();
    const secretKey = randomBytes(32);
    const events: IncomingTriggerEvent[] = [];

    const hmacTrigger = {
      provider: "webhook",
      source: "http",
      trigger: "WEBHOOK_RECEIVED",
      mode: "webhook" as const,
      config: {
        authMode: "hmac-sha256",
        includeKeywords: "deploy, release",
      },
    };
    const headerTrigger = {
      provider: "webhook",
      source: "http",
      trigger: "WEBHOOK_RECEIVED",
      mode: "webhook" as const,
      config: { authMode: "header" },
    };

    const provider = new WebhookTriggerProvider({
      settings,
      secretKey,
      warn: () => undefined,
    });
    providers.push(provider);

    provider.start({
      bindings: () => [
        {
          routineId: "r-hmac",
          enabled: true,
          trigger: hmacTrigger,
          instanceId: "webhook:r-hmac",
        },
        {
          routineId: "r-hdr",
          enabled: true,
          trigger: headerTrigger,
          instanceId: "webhook:r-hdr",
        },
      ],
      onEvent: (event) => events.push(event),
      onBindingsChanged: () => undefined,
    });

    await provider.provision({
      routineId: "r-hmac",
      trigger: hmacTrigger,
      enabled: true,
      existingInstanceId: null,
    });
    await provider.provision({
      routineId: "r-hdr",
      trigger: headerTrigger,
      enabled: true,
      existingInstanceId: null,
    });

    const hmacInfo = provider.info("r-hmac", hmacTrigger);
    const hdrInfo = provider.info("r-hdr", headerTrigger);
    expect(hdrInfo.headerName).toBe("Authorization");

    // Missing HMAC signature header -> 401
    const missingSigResp = await provider.route(
      new Request(`http://localhost${hmacInfo.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "deploy" }),
      }),
    );
    expect(missingSigResp?.status).toBe(401);

    // Valid signature computed for original body, sent with tampered body -> 401
    const originalBody = JSON.stringify({ action: "deploy", env: "staging" });
    const validSigForOriginal = `sha256=${hmacHex(hmacInfo.secret!, originalBody)}`;
    const tamperedResp = await provider.route(
      new Request(`http://localhost${hmacInfo.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": validSigForOriginal,
        },
        body: JSON.stringify({ action: "deploy", env: "production" }),
      }),
    );
    expect(tamperedResp?.status).toBe(401);

    // includeKeywords mismatch -> 202 { accepted: false, reason: "filtered" }
    const mismatchBody = JSON.stringify({ action: "ping" });
    const mismatchResp = await provider.route(
      new Request(`http://localhost${hmacInfo.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${hmacHex(hmacInfo.secret!, mismatchBody)}`,
        },
        body: mismatchBody,
      }),
    );
    expect(mismatchResp?.status).toBe(202);
    expect(await mismatchResp?.json()).toEqual({
      ok: true,
      accepted: false,
      reason: "filtered",
    });

    // Large JSON body (>16,000 chars, <256 KiB) -> accepted with truncated: true
    const largeBody = JSON.stringify({
      action: "deploy",
      blob: "x".repeat(20_000),
    });
    const largeOkResp = await provider.route(
      new Request(`http://localhost${hmacInfo.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${hmacHex(hmacInfo.secret!, largeBody)}`,
        },
        body: largeBody,
      }),
    );
    expect(largeOkResp?.status).toBe(202);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      truncated: true,
      body: { _truncated: true },
    });

    // Default Authorization: Bearer <secret> header auth
    const badBearer = await provider.route(
      new Request(`http://localhost${hdrInfo.path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-secret",
          "content-type": "text/plain",
        },
        body: "hi",
      }),
    );
    expect(badBearer?.status).toBe(401);

    const goodBearer = await provider.route(
      new Request(`http://localhost${hdrInfo.path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${hdrInfo.secret!}`,
          "content-type": "text/plain",
        },
        body: "hi",
      }),
    );
    expect(goodBearer?.status).toBe(202);
    expect(events).toHaveLength(2);
  });
});

describe("inbound webhook end-to-end with eta-host", () => {
  it("exempts /hooks/<token> from the host access token gate while enforcing webhook auth", async () => {
    const dir = await tempDir("eta-webhook-gate-");
    const gateToken = "host-gate-secret-token-value";
    const tokenPath = join(dir, "access-token");
    await writeFile(tokenPath, `${gateToken}\n`, { mode: 0o600 });

    const host = await testHost({
      dataDir: dir,
      tokenFile: tokenPath,
      captain: true,
    });
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`, {
      authorization: `Bearer ${gateToken}`,
    });
    await client.hello();
    const origin = `http://127.0.0.1:${host.port}`;
    try {
      const { routine } = (await client.call("routines", "create", {
        name: "Gated Webhook",
        brief: "Process gated webhook.",
        schedule: null,
        trigger: {
          provider: "webhook",
          source: "http",
          trigger: "WEBHOOK_RECEIVED",
          mode: "webhook",
          config: { authMode: "none" },
        },
        timezone: "UTC",
        enabled: true,
      })) as { routine: RoutineSummary };

      const info = (await client.call("routines", "webhookInfo", {
        routineId: routine.id,
      })) as WebhookTriggerInfo;

      // Normal page remains behind the access gate (401 without host token),
      // while POST /hooks/<token> passes through without the host access token.
      expect((await fetch(`${origin}/`)).status).toBe(401);
      const hookResp = await fetch(`${origin}${info.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      });
      expect(hookResp.status).toBe(202);
    } finally {
      client.close();
      await host.close();
    }
  });

  it("supports 3 auth modes, form/text parsing, rotation, custom secret, restart persistence, dedupe, and TriggerHub routine run", async () => {
    const dir = await tempDir("eta-webhook-e2e-");
    const models = scriptedModels((request) => {
      if (!isRun(request)) return say("ok");
      return step(request) === 0
        ? report("Webhook received", "Processed inbound webhook event.")
        : say("done");
    });

    const hostOptions: Partial<HostOptions> = {
      dataDir: dir,
      captain: true,
      models: models.models,
      routines: { timer: false, coalesceMs: 10 },
    };

    const w1 = await world(hostOptions);
    const origin1 = `http://127.0.0.1:${w1.host.port}`;
    try {
      const catalog = (await w1.client.call("routines", "triggers", {
        provider: "webhook",
      })) as {
        triggers: TriggerCatalogItem[];
        providers: TriggerProviderStatus[];
      };
      expect(catalog.providers).toEqual([
        { provider: "webhook", status: "ready" },
      ]);
      expect(catalog.triggers).toHaveLength(1);
      expect(catalog.triggers[0]!.trigger).toBe("WEBHOOK_RECEIVED");

      // 1. Create header-auth webhook routine (custom header X-Webhook-Secret)
      const { routine: headerRoutine } = (await w1.client.call(
        "routines",
        "create",
        {
          name: "Header Hook",
          brief: "Inspect webhook event and report.",
          schedule: null,
          trigger: {
            provider: "webhook",
            source: "http",
            trigger: "WEBHOOK_RECEIVED",
            mode: "webhook",
            config: {
              authMode: "header",
              headerName: "X-Webhook-Secret",
            },
          },
          timezone: "UTC",
          enabled: true,
        } satisfies RoutineArgs["create"],
      )) as { routine: RoutineSummary };

      // Secret is never in routine.trigger.config or DB config_json
      expect(headerRoutine.trigger?.config).toEqual({
        authMode: "header",
        headerName: "X-Webhook-Secret",
      });
      const dbRow = w1.host.db
        .query<{ config_json: string }, [string]>(
          "SELECT config_json FROM routine_trigger WHERE routine_id = ?",
        )
        .get(headerRoutine.id);
      expect(dbRow?.config_json).not.toContain("secret");

      const headerInfo = (await w1.client.call("routines", "webhookInfo", {
        routineId: headerRoutine.id,
      })) as WebhookTriggerInfo;
      expect(headerInfo.authMode).toBe("header");
      expect(headerInfo.headerName).toBe("X-Webhook-Secret");
      expect(headerInfo.hasSecret).toBe(true);
      expect(headerInfo.secret).toBeTruthy();

      // Token-gated host: POST /hooks/<token> does not require host access token,
      // but still enforces webhook header secret -> 401 when missing/wrong.
      const unauthorized = await fetch(`${origin1}${headerInfo.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false }),
      });
      expect(unauthorized.status).toBe(401);

      // Update secret via routines.webhookSetSecret & verify old secret fails, new secret succeeds
      const updatedSecretInfo = (await w1.client.call(
        "routines",
        "webhookSetSecret",
        {
          routineId: headerRoutine.id,
          secret: "custom-github-secret-123",
        },
      )) as WebhookTriggerInfo;
      expect(updatedSecretInfo.secret).toBe("custom-github-secret-123");

      const oldSecretResp = await fetch(`${origin1}${headerInfo.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-webhook-secret": headerInfo.secret!,
        },
        body: "event=push&repo=eta",
      });
      expect(oldSecretResp.status).toBe(401);

      // Send form-urlencoded payload with duplicate delivery IDs -> only 1 run triggers
      const formHeaders = {
        "content-type": "application/x-www-form-urlencoded",
        "x-webhook-secret": "custom-github-secret-123",
        "idempotency-key": "idem-key-1",
      };
      const formResp1 = await fetch(`${origin1}${headerInfo.path}`, {
        method: "POST",
        headers: formHeaders,
        body: "event=push&repo=eta",
      });
      expect(formResp1.status).toBe(202);
      expect(await formResp1.json()).toEqual({
        ok: true,
        accepted: true,
        eventId: "idem-key-1",
      });

      const formResp2 = await fetch(`${origin1}${headerInfo.path}`, {
        method: "POST",
        headers: formHeaders,
        body: "event=push&repo=eta",
      });
      expect(formResp2.status).toBe(202);

      // Wait for TriggerHub + RoutineRunner to complete the run
      w1.client.subscribe(`routines.${headerRoutine.id}`);
      await until(() => {
        const runs =
          w1.client.section<RunView[]>(
            `routines.${headerRoutine.id}`,
            "runs",
          ) ?? [];
        return runs.length === 1 && runs[0]!.status === "sent";
      });

      const runRequests = models.requests.filter(
        (req) => isRun(req) && step(req) === 0,
      );
      expect(runRequests).toHaveLength(1);
      expect(
        w1.host.product.routines.store.runs(headerRoutine.id, 10),
      ).toHaveLength(1);
      const firstPrompt = runRequests[0]!.transcript[0]!;
      expect(firstPrompt).toContain(TRIGGER_EVENTS_OPEN);
      expect(firstPrompt).toContain(TRIGGER_EVENTS_CLOSE);
      expect(firstPrompt).toContain("idem-key-1");
      expect(firstPrompt).toContain('"event": "push"');
      expect(firstPrompt).not.toContain("custom-github-secret-123");

      // Rotate token + secret -> old token immediately returns 404, new token works
      const rotated = (await w1.client.call("routines", "webhookRotate", {
        routineId: headerRoutine.id,
      })) as WebhookTriggerInfo;
      expect(rotated.path).not.toBe(headerInfo.path);
      expect(rotated.secret).not.toBe("custom-github-secret-123");

      const staleTokenResp = await fetch(`${origin1}${headerInfo.path}`, {
        method: "POST",
        headers: { "x-webhook-secret": rotated.secret! },
        body: "hello",
      });
      expect(staleTokenResp.status).toBe(404);

      const rotatedOkResp = await fetch(`${origin1}${rotated.path}`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-webhook-secret": `Bearer ${rotated.secret!}`,
          "x-delivery-id": "deliv-after-rotate",
        },
        body: "plain text webhook body",
      });
      expect(rotatedOkResp.status).toBe(202);
      expect(await rotatedOkResp.json()).toEqual({
        ok: true,
        accepted: true,
        eventId: "deliv-after-rotate",
      });

      await until(() => {
        const runs =
          w1.client.section<RunView[]>(
            `routines.${headerRoutine.id}`,
            "runs",
          ) ?? [];
        return runs.length === 2 && runs.every((r) => r.status === "sent");
      });

      // Restart host with same dataDir and verify persisted token & secret still work
      w1.client.close();
      await w1.host.close();

      const w2 = await world(hostOptions);
      const origin2 = `http://127.0.0.1:${w2.host.port}`;
      try {
        const afterRestartResp = await fetch(`${origin2}${rotated.path}`, {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "x-webhook-secret": rotated.secret!,
            "x-webhook-id": "wh-after-restart",
          },
          body: "after restart",
        });
        expect(afterRestartResp.status).toBe(202);
        expect(await afterRestartResp.json()).toEqual({
          ok: true,
          accepted: true,
          eventId: "wh-after-restart",
        });

        // Deleting routine removes its webhook credentials immediately
        await w2.client.call("routines", "delete", {
          routineId: headerRoutine.id,
        });
        const afterDeleteResp = await fetch(`${origin2}${rotated.path}`, {
          method: "POST",
          headers: { "x-webhook-secret": rotated.secret! },
          body: "after delete",
        });
        expect(afterDeleteResp.status).toBe(404);
      } finally {
        w2.client.close();
        await w2.host.close();
      }
    } catch (error) {
      w1.client.close();
      await w1.host.close();
      throw error;
    }
  });

  it("regenerates/clears secret across pause -> authMode edit -> resume without calling webhookInfo, and cleans credentials on disabled delete/switch", async () => {
    const dir = await tempDir("eta-webhook-regressions-");
    const w = await world({
      dataDir: dir,
      captain: true,
      routines: { timer: false, coalesceMs: 10 },
    });
    const origin = `http://127.0.0.1:${w.host.port}`;
    const settings = new SettingStore(w.host.db);

    try {
      // Regression 1: enabled (none) -> pause -> edit to hmac-sha256 -> re-enable -> secret exists immediately
      const { routine: r1 } = (await w.client.call("routines", "create", {
        name: "Pause Edit Auth",
        brief: "Watch deploys.",
        schedule: null,
        trigger: {
          provider: "webhook",
          source: "http",
          trigger: "WEBHOOK_RECEIVED",
          mode: "webhook",
          config: { authMode: "none" },
        },
        timezone: "UTC",
        enabled: true,
      } satisfies RoutineArgs["create"])) as { routine: RoutineSummary };

      const storedInitial = settings.get(`webhook.trigger.${r1.id}`) as {
        sealedSecret: string | null;
      };
      expect(storedInitial.sealedSecret).toBeNull();

      await w.client.call("routines", "update", {
        routineId: r1.id,
        enabled: false,
      });
      await w.client.call("routines", "update", {
        routineId: r1.id,
        trigger: {
          provider: "webhook",
          source: "http",
          trigger: "WEBHOOK_RECEIVED",
          mode: "webhook",
          config: { authMode: "hmac-sha256" },
        },
      });
      const enabledAgain = (await w.client.call("routines", "update", {
        routineId: r1.id,
        enabled: true,
      })) as { routine: RoutineSummary };
      expect(enabledAgain.routine.trigger?.status).toBe("active");

      // Secret MUST already be persisted in SettingStore before webhookInfo is ever called.
      const storedAfterHmac = settings.get(`webhook.trigger.${r1.id}`) as {
        sealedSecret: string | null;
      };
      expect(storedAfterHmac.sealedSecret).not.toBeNull();

      const infoAfter = (await w.client.call("routines", "webhookInfo", {
        routineId: r1.id,
      })) as WebhookTriggerInfo;
      expect(infoAfter.secret).toMatch(/^[0-9a-f]{64}$/);

      // Unauthenticated request returns 401; signed request returns 202.
      expect(
        (
          await fetch(`${origin}${infoAfter.path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(401);

      const signedBody = JSON.stringify({ event: "deploy" });
      expect(
        (
          await fetch(`${origin}${infoAfter.path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": `sha256=${hmacHex(infoAfter.secret!, signedBody)}`,
            },
            body: signedBody,
          })
        ).status,
      ).toBe(202);

      // Reverse: pause -> edit back to none -> re-enable clears sealedSecret and allows token-only POST
      await w.client.call("routines", "update", {
        routineId: r1.id,
        enabled: false,
      });
      await w.client.call("routines", "update", {
        routineId: r1.id,
        trigger: {
          provider: "webhook",
          source: "http",
          trigger: "WEBHOOK_RECEIVED",
          mode: "webhook",
          config: { authMode: "none" },
        },
        enabled: true,
      });
      const storedCleared = settings.get(`webhook.trigger.${r1.id}`) as {
        sealedSecret: string | null;
      };
      expect(storedCleared.sealedSecret).toBeNull();
      expect(
        (
          await fetch(`${origin}${infoAfter.path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: signedBody,
          })
        ).status,
      ).toBe(202);

      // Regression 2a: enabled: false created -> webhookInfo -> deleted cleans SettingStore & returns 404
      const { routine: rDisabledDelete } = (await w.client.call(
        "routines",
        "create",
        {
          name: "Disabled Delete",
          brief: "Will be deleted before enabling.",
          schedule: null,
          trigger: {
            provider: "webhook",
            source: "http",
            trigger: "WEBHOOK_RECEIVED",
            mode: "webhook",
            config: { authMode: "none" },
          },
          timezone: "UTC",
          enabled: false,
        } satisfies RoutineArgs["create"],
      )) as { routine: RoutineSummary };
      expect(rDisabledDelete.trigger?.instanceId).toBeNull();

      const disabledInfo = (await w.client.call("routines", "webhookInfo", {
        routineId: rDisabledDelete.id,
      })) as WebhookTriggerInfo;
      expect(
        settings.get(`webhook.trigger.${rDisabledDelete.id}`),
      ).toBeDefined();
      const disabledResp = await fetch(`${origin}${disabledInfo.path}`, {
        method: "POST",
        body: "{}",
      });
      expect(disabledResp.status).toBe(202);
      expect(await disabledResp.json()).toEqual({
        ok: true,
        accepted: false,
        reason: "disabled",
      });

      await w.client.call("routines", "delete", {
        routineId: rDisabledDelete.id,
      });
      expect(
        settings.get(`webhook.trigger.${rDisabledDelete.id}`),
      ).toBeUndefined();
      expect(
        (await fetch(`${origin}${disabledInfo.path}`, { method: "POST" }))
          .status,
      ).toBe(404);

      // Regression 2b: enabled: false created -> webhookInfo -> switched to schedule-only cleans SettingStore & returns 404
      const { routine: rDisabledSwitch } = (await w.client.call(
        "routines",
        "create",
        {
          name: "Disabled Switch",
          brief: "Will switch to schedule.",
          schedule: null,
          trigger: {
            provider: "webhook",
            source: "http",
            trigger: "WEBHOOK_RECEIVED",
            mode: "webhook",
            config: { authMode: "none" },
          },
          timezone: "UTC",
          enabled: false,
        } satisfies RoutineArgs["create"],
      )) as { routine: RoutineSummary };
      const switchInfo = (await w.client.call("routines", "webhookInfo", {
        routineId: rDisabledSwitch.id,
      })) as WebhookTriggerInfo;
      expect(
        settings.get(`webhook.trigger.${rDisabledSwitch.id}`),
      ).toBeDefined();

      await w.client.call("routines", "update", {
        routineId: rDisabledSwitch.id,
        schedule: { kind: "daily", time: "09:00" },
        trigger: null,
      });
      expect(
        settings.get(`webhook.trigger.${rDisabledSwitch.id}`),
      ).toBeUndefined();
      expect(
        (await fetch(`${origin}${switchInfo.path}`, { method: "POST" })).status,
      ).toBe(404);
    } finally {
      w.client.close();
      await w.host.close();
    }
  });
});
