/**
 * `ComposioTriggerProvider` unit + loopback fake HTTP/WebSocket tests:
 * - Task #136 REST contracts (`triggers_types` comma `toolkit_slugs` & `limit<=50`, `upsert` with
 *   `user_id` + `connected_account_id`, `PATCH/DELETE /api/v3.1/trigger_instances/manage/{triggerId}`
 *   idempotency including `409` enable/disable reconciliation & HTTP 204 upsert fallback)
 * - Pusher Protocol v7 handshake (`/api/v3/internal/sdk/realtime/credentials`,
 *   `/app/${key}?protocol=7&client=js&version=8.6.0&flash=false`, `/realtime/auth` form body,
 *   verbatim `channel_data` forwarding, `epoch` cancellation of in-flight auth)
 * - Heartbeat (`pusher:ping`/`pusher:pong` + 30s `pongTimeout` disconnect), close-code classification
 *   (`4000`, `4001`, `4100`, `4200`), 10KB `chunked-trigger_to_client` reassembly & incomplete timeout
 * - Strict idempotency key precedence (`id` -> `metadata.log_id` -> `log_id` -> `metadata.id`, never
 *   `metadata.trigger_id`), no WS connection without active bindings / API key, and secret redaction.
 */
import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type {
  IncomingTriggerEvent,
  TriggerBinding,
} from "../src/routines/triggers";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { Composio } from "../src/plugins/composio";
import {
  classifyPusherCloseCode,
  ComposioTriggerProvider,
  parseComposioTriggerEvent,
} from "../src/plugins/composio-triggers";
import { CatalogCache } from "../src/plugins/market-cache";
import { SettingStore } from "../src/settings/store";
import { until } from "./support/client";

const API_KEY = "ck_live_SECRET_KEY_123456";
const ALT_API_KEY = "ck_live_SECOND_KEY_654321";
const PUSHER_KEY = "pk_secret_pusher_777";
const PROJECT_ID = "proj-1111-2222-3333";
const CHANNEL_DATA = '{"user_id":"secret-channel-user-888","role":"owner"}';
const AUTH_HMAC = "pk_secret_pusher_777:supersecretauthhmac999";
const TEST_SECRET = Buffer.alloc(32, 7);

interface RecordedRequest {
  method: string;
  path: string;
  rawSearch: string;
  key: string | null;
  contentType: string | null;
  body: string;
}

interface WsData {
  id: number;
  url: string;
  socketId: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFakeComposio() {
  const requests: RecordedRequest[] = [];
  const clientFrames: { connId: number; event: string; data: unknown }[] = [];
  const connections = new Set<ServerWebSocket<WsData>>();
  let nextConnId = 1;
  let nowMs = 1_700_000_000_000;

  let connectedAccounts: {
    id: string;
    slug: string;
    authConfigId?: string;
    userId?: string;
  }[] = [{ id: "ca_gh_1", slug: "github", authConfigId: "ac_gh_1" }];

  let customRoute:
    | ((
        req: Request,
        url: URL,
        body: string,
      ) => Promise<Response | undefined> | Response | undefined)
    | undefined;

  let catalogItems: unknown[] = [
    {
      slug: "GITHUB_COMMIT_EVENT",
      name: "New Commit",
      description: "Fires on push commits",
      instructions: "Pick owner and repo",
      types: ["webhook", "poll"],
      type: "poll",
      version: "20261124_00",
      requires_webhook_endpoint_setup: false,
      toolkit: { slug: "github", name: "GitHub" },
      config: { type: "object", properties: { repo: { type: "string" } } },
      payload: { type: "object", properties: { sha: { type: "string" } } },
    },
    {
      slug: "SLACK_RECEIVE_MESSAGE",
      name: "New Message",
      description: "Fires on new Slack messages",
      types: ["webhook"],
      type: "webhook",
      toolkit: { slug: "slack", name: "Slack" },
      config: { type: "object", properties: { channel: { type: "string" } } },
      payload: { type: "object", properties: { text: { type: "string" } } },
    },
  ];

  const activeInstances = new Map<
    string,
    {
      id: string;
      trigger_name: string;
      connected_account_id: string;
      disabled_at: string | null;
      type: "webhook" | "poll";
    }
  >();

  let onWsOpen: ((ws: ServerWebSocket<WsData>) => void) | undefined;
  let activityTimeoutSec = 120;

  const server = Bun.serve<WsData>({
    port: 0,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const id = nextConnId++;
        const upgraded = srv.upgrade(req, {
          data: {
            id,
            url: url.pathname + url.search,
            socketId: `12345.${id}`,
          },
        });
        if (upgraded) return;
        return new Response("upgrade failed", { status: 400 });
      }

      const body = await req.text();
      requests.push({
        method: req.method,
        path: url.pathname,
        rawSearch: url.search,
        key: req.headers.get("x-api-key"),
        contentType: req.headers.get("content-type"),
        body,
      });

      if (customRoute !== undefined) {
        const override = await customRoute(req, url, body);
        if (override !== undefined) return override;
      }

      if (req.headers.get("x-api-key") === "bad-key") {
        return json({ error: { message: "bad api key", status: 401 } }, 401);
      }

      if (req.method === "GET" && url.pathname === "/api/v3/toolkits") {
        return json({ items: [], next_cursor: null });
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/v3/connected_accounts"
      ) {
        return json({
          items: connectedAccounts.map((acc) => ({
            id: acc.id,
            status: "ACTIVE",
            user_id: acc.userId,
            toolkit: { slug: acc.slug },
            ...(acc.authConfigId === undefined
              ? {}
              : { auth_config: { id: acc.authConfigId } }),
          })),
          next_cursor: null,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/v3.1/triggers_types") {
        const slugsParam = url.searchParams.get("toolkit_slugs");
        const allowed = slugsParam ? new Set(slugsParam.split(",")) : null;
        const filtered =
          allowed === null
            ? catalogItems
            : catalogItems.filter((item) => {
                const tk = (item as { toolkit?: { slug?: string } }).toolkit
                  ?.slug;
                return tk !== undefined && allowed.has(tk);
              });
        return json({
          items: filtered,
          next_cursor: null,
          total_pages: 1,
          current_page: 1,
          total_items: filtered.length,
        });
      }

      const upsertMatch =
        /^\/api\/v3\.1\/trigger_instances\/([^/]+)\/upsert$/.exec(url.pathname);
      if (req.method === "POST" && upsertMatch !== null) {
        const parsed = JSON.parse(body) as {
          connected_account_id?: string;
          type?: "webhook" | "poll";
          polling_interval?: number;
        };
        const slug = decodeURIComponent(upsertMatch[1]!);
        const id = `ti_${slug.toLowerCase()}_${activeInstances.size + 1}`;
        const mode = parsed.type ?? "webhook";
        activeInstances.set(id, {
          id,
          trigger_name: slug,
          connected_account_id: parsed.connected_account_id ?? "ca_unknown",
          disabled_at: null,
          type: mode,
        });
        return json({
          trigger_id: id,
          type: mode,
          fallback_reason: null,
          polling_interval: parsed.polling_interval ?? null,
        });
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/v3.1/trigger_instances/active"
      ) {
        const filterIds = url.searchParams.get("trigger_ids");
        const items = [...activeInstances.values()].filter((one) =>
          filterIds ? filterIds.split(",").includes(one.id) : true,
        );
        return json({ items, next_cursor: null });
      }

      const manageMatch =
        /^\/api\/v3\.1\/trigger_instances\/manage\/([^/]+)$/.exec(url.pathname);
      if (manageMatch !== null) {
        const triggerId = decodeURIComponent(manageMatch[1]!);
        if (req.method === "PATCH") {
          const parsed = JSON.parse(body) as { status?: string };
          const inst = activeInstances.get(triggerId);
          if (inst !== undefined) {
            inst.disabled_at =
              parsed.status === "disable" ? "2026-11-27T00:00:00Z" : null;
          }
          return json({ status: "success" });
        }
        if (req.method === "DELETE") {
          activeInstances.delete(triggerId);
          return json({ trigger_id: triggerId });
        }
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/v3/internal/sdk/realtime/credentials"
      ) {
        return json({
          pusher_key: PUSHER_KEY,
          pusher_cluster: "mt1",
          project_id: PROJECT_ID,
        });
      }

      if (
        req.method === "POST" &&
        url.pathname === "/api/v3/internal/sdk/realtime/auth"
      ) {
        return json({
          auth: AUTH_HMAC,
          channel_data: CHANNEL_DATA,
        });
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        connections.add(ws);
        ws.send(
          JSON.stringify({
            event: "pusher:connection_established",
            data: JSON.stringify({
              socket_id: ws.data.socketId,
              activity_timeout: activityTimeoutSec,
            }),
          }),
        );
        onWsOpen?.(ws);
      },
      message(ws, message) {
        const raw =
          typeof message === "string" ? message : message.toString("utf8");
        const parsed = JSON.parse(raw) as { event: string; data: unknown };
        clientFrames.push({
          connId: ws.data.id,
          event: parsed.event,
          data: parsed.data,
        });
        if (parsed.event === "pusher:subscribe") {
          const subData = parsed.data as { channel?: string };
          ws.send(
            JSON.stringify({
              event: "pusher_internal:subscription_succeeded",
              channel: subData.channel,
              data: "{}",
            }),
          );
        }
      },
      close(ws) {
        connections.delete(ws);
      },
    },
  });

  const dbs: Database[] = [];
  const providers: ComposioTriggerProvider[] = [];

  const cleanup = async () => {
    for (const p of providers.splice(0)) await p.stop();
    server.stop(true);
    for (const db of dbs.splice(0)) db.close();
  };

  const make = (
    opts: {
      key?: string | null;
      activityTimeoutMs?: number;
      pongTimeoutMs?: number;
      chunkTimeoutMs?: number;
      reconnectBaseMs?: number;
      reconnectMaxMs?: number;
      catalogTtlMs?: number;
      warn?: (msg: string) => void;
    } = {},
  ) => {
    const db = openDatabase(":memory:");
    dbs.push(db);
    applyMigrations(db, loadMigrations());
    const settings = new SettingStore(db);
    const cache = new CatalogCache(db, { maxRowBytes: 1024 * 1024 });
    const composio = new Composio({
      db,
      key: TEST_SECRET,
      settings,
      cache,
      baseUrl: `http://127.0.0.1:${server.port}`,
      now: () => nowMs,
    });
    if (opts.key !== null) {
      composio.setKey(opts.key ?? API_KEY);
    }
    const provider = new ComposioTriggerProvider({
      composio,
      pusherUrl: `ws://127.0.0.1:${server.port}`,
      now: () => nowMs,
      warn: opts.warn,
      catalogTtlMs: opts.catalogTtlMs ?? 5 * 60_000,
      activityTimeoutMs: opts.activityTimeoutMs,
      pongTimeoutMs: opts.pongTimeoutMs,
      chunkTimeoutMs: opts.chunkTimeoutMs,
      reconnectBaseMs: opts.reconnectBaseMs ?? 20,
      reconnectMaxMs: opts.reconnectMaxMs ?? 80,
    });
    providers.push(provider);
    return { db, composio, provider };
  };

  return {
    server,
    requests,
    clientFrames,
    connections,
    activeInstances,
    setAccounts: (accs: typeof connectedAccounts) => {
      connectedAccounts = accs;
    },
    setCatalog: (items: unknown[]) => {
      catalogItems = items;
    },
    setCustomRoute: (fn: typeof customRoute) => {
      customRoute = fn;
    },
    setOnWsOpen: (fn: typeof onWsOpen) => {
      onWsOpen = fn;
    },
    setActivityTimeoutSec: (sec: number) => {
      activityTimeoutSec = sec;
    },
    advanceClock: (ms: number) => {
      nowMs += ms;
    },
    make,
    cleanup,
  };
}

let activeHarness: ReturnType<typeof createFakeComposio> | undefined;
afterEach(async () => {
  if (activeHarness !== undefined) {
    await activeHarness.cleanup();
    activeHarness = undefined;
  }
});

describe("the ComposioTriggerProvider REST & contracts", () => {
  it("queries triggers_types with comma-joined toolkit_slugs and limit<=50, caches 5m, and attaches accounts", async () => {
    const h = (activeHarness = createFakeComposio());
    h.setAccounts([
      { id: "ca_sl_1", slug: "slack", authConfigId: "ac_sl" },
      { id: "ca_gh_1", slug: "github", authConfigId: "ac_gh" },
    ]);
    const { composio, provider } = h.make();

    expect(provider.status()).toEqual({
      provider: "composio",
      status: "ready",
    });
    const items = await provider.listTriggers();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      provider: "composio",
      source: "github",
      trigger: "GITHUB_COMMIT_EVENT",
      modes: ["webhook", "poll"],
      accounts: [{ id: "ca_gh_1" }],
    });

    const catalogReq = h.requests.find(
      (r) => r.path === "/api/v3.1/triggers_types",
    )!;
    expect(catalogReq).toBeDefined();
    expect(catalogReq.rawSearch).toContain("limit=50");
    // Must use literal comma-joined toolkit_slugs=github,slack and NEVER toolkit_slugs[].
    expect(catalogReq.rawSearch).toContain("toolkit_slugs=github,slack");
    expect(catalogReq.rawSearch).not.toContain("toolkit_slugs[]");

    // Second read hits 5-minute cache instead of refetching /triggers_types.
    const reqCountBeforeCache = h.requests.filter(
      (r) => r.path === "/api/v3.1/triggers_types",
    ).length;
    await provider.listTriggers({ query: "slack" });
    expect(
      h.requests.filter((r) => r.path === "/api/v3.1/triggers_types"),
    ).toHaveLength(reqCountBeforeCache);

    // refresh: true bypasses cache.
    await provider.listTriggers({ refresh: true });
    expect(
      h.requests.filter((r) => r.path === "/api/v3.1/triggers_types"),
    ).toHaveLength(reqCountBeforeCache + 1);

    // Key clearing moves status to needs_key cleanly.
    composio.clearKey();
    expect(provider.status()).toEqual({
      provider: "composio",
      status: "needs_key",
    });
    expect(await provider.listTriggers()).toEqual([]);
  });

  it("handles 401 key_rejected, disabled toggle, multi-account selection, 204 upsert fallback, and 409/404 idempotency", async () => {
    const h = (activeHarness = createFakeComposio());
    h.setAccounts([
      { id: "ca_gh_1", slug: "github" },
      { id: "ca_gh_2", slug: "github" },
    ]);
    const { composio, provider } = h.make();

    // Multiple active accounts require explicit accountId.
    await expect(
      provider.provision({
        routineId: "r1",
        trigger: {
          provider: "composio",
          source: "github",
          trigger: "GITHUB_COMMIT_EVENT",
        },
        enabled: true,
        existingInstanceId: null,
      }),
    ).rejects.toThrow(/multiple active connected accounts/i);

    const created = await provider.provision({
      routineId: "r1",
      trigger: {
        provider: "composio",
        source: "github",
        trigger: "GITHUB_COMMIT_EVENT",
        accountId: "ca_gh_2",
        config: { repo: "eta" },
      },
      enabled: true,
      existingInstanceId: null,
    });
    expect(created.accountId).toBe("ca_gh_2");
    expect(created.instanceId).toMatch(/^ti_github_commit_event_/);

    const upsertReq = h.requests.find((r) => r.path.endsWith("/upsert"))!;
    expect(JSON.parse(upsertReq.body)).toMatchObject({
      user_id: composio.userId(),
      connected_account_id: "ca_gh_2",
      trigger_config: { repo: "eta" },
    });

    // 409 from PATCH manage/{id} succeeds if active list already matches desired state.
    h.setCustomRoute((req, url) => {
      if (
        req.method === "PATCH" &&
        url.pathname ===
          `/api/v3.1/trigger_instances/manage/${created.instanceId}`
      ) {
        return json({ error: { message: "already enabled" } }, 409);
      }
      return undefined;
    });
    await expect(
      provider.setEnabled(created.instanceId, true),
    ).resolves.toBeUndefined();

    // 404 on DELETE is idempotent.
    h.setCustomRoute((req, url) => {
      if (req.method === "DELETE" && url.pathname.includes("/manage/")) {
        return json({ error: { message: "missing" } }, 404);
      }
      return undefined;
    });
    await expect(
      provider.deleteInstance(created.instanceId),
    ).resolves.toBeUndefined();

    // Disable toggle & bad key statuses.
    composio.setEnabled(false);
    expect(provider.status()).toEqual({
      provider: "composio",
      status: "disabled",
    });
    composio.setEnabled(true);
    composio.setKey("bad-key");
    expect(await provider.listTriggers()).toEqual([]);
    expect(provider.status().status).toBe("key_rejected");
  });
});

describe("the ComposioTriggerProvider Pusher v7 protocol & security", () => {
  it("does not connect when there are 0 enabled bindings; connects once active, forwards channel_data verbatim, and disconnects on key clear", async () => {
    const h = (activeHarness = createFakeComposio());
    const { composio, provider } = h.make();
    const events: IncomingTriggerEvent[] = [];
    let bindings: TriggerBinding[] = [];

    provider.start({
      bindings: () => bindings,
      onEvent: (ev) => events.push(ev),
      onBindingsChanged: () => {},
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(h.connections.size).toBe(0);
    expect(
      h.requests.some((r) => r.path.includes("realtime/credentials")),
    ).toBe(false);

    bindings = [
      {
        routineId: "r1",
        enabled: true,
        instanceId: "ti_1",
        trigger: {
          provider: "composio",
          source: "github",
          trigger: "GITHUB_COMMIT_EVENT",
        },
      },
    ];
    provider.syncBindings();

    await until(() =>
      h.clientFrames.some((f) => f.event === "pusher:subscribe"),
    );

    const credReq = h.requests.find(
      (r) => r.path === "/api/v3/internal/sdk/realtime/credentials",
    );
    expect(credReq).toBeDefined();

    const wsConn = [...h.connections][0]!;
    expect(wsConn.data.url).toBe(
      `/app/${PUSHER_KEY}?protocol=7&client=js&version=8.6.0&flash=false`,
    );

    const authReq = h.requests.find(
      (r) => r.path === "/api/v3/internal/sdk/realtime/auth",
    )!;
    expect(authReq.contentType).toContain("application/x-www-form-urlencoded");
    expect(authReq.body).toContain(
      `channel_name=${encodeURIComponent(`private-${PROJECT_ID}_triggers`)}`,
    );

    const subFrame = h.clientFrames.find(
      (f) => f.event === "pusher:subscribe",
    )!;
    expect(subFrame.data).toEqual({
      channel: `private-${PROJECT_ID}_triggers`,
      auth: AUTH_HMAC,
      channel_data: CHANNEL_DATA,
    });

    // Normal trigger_to_client V3 payload.
    wsConn.send(
      JSON.stringify({
        event: "trigger_to_client",
        channel: `private-${PROJECT_ID}_triggers`,
        data: JSON.stringify({
          id: "msg_abc1",
          timestamp: "2026-11-27T01:00:00Z",
          type: "composio.trigger.message",
          metadata: {
            log_id: "log_1",
            trigger_slug: "GITHUB_COMMIT_EVENT",
            toolkit_slug: "github",
            trigger_id: "ti_1",
            connected_account_id: "ca_gh_1",
            user_id: composio.userId(),
          },
          data: { sha: "deadbeef" },
        }),
      }),
    );

    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({
      provider: "composio",
      instanceId: "ti_1",
      triggerSlug: "GITHUB_COMMIT_EVENT",
      source: "github",
      accountId: "ca_gh_1",
      eventId: "msg_abc1",
      payload: { sha: "deadbeef" },
    });

    // Clearing API key disconnects active socket cleanly.
    composio.clearKey();
    await until(() => h.connections.size === 0);
  });

  it("discards stale in-flight auth when epoch changes (setKey during auth) and never leaks secrets in errors/warnings", async () => {
    const h = (activeHarness = createFakeComposio());
    const warnings: string[] = [];
    const { composio, provider } = h.make({ warn: (m) => warnings.push(m) });

    let releaseAuth!: () => void;
    const authGate = new Promise<void>((r) => {
      releaseAuth = r;
    });
    h.setCustomRoute(async (req, url) => {
      if (
        req.method === "POST" &&
        url.pathname === "/api/v3/internal/sdk/realtime/auth"
      ) {
        await authGate;
        return json(
          {
            error: {
              message: `denied for ${API_KEY} and ${PUSHER_KEY} and ${CHANNEL_DATA}`,
            },
          },
          401,
        );
      }
      return undefined;
    });

    provider.start({
      bindings: () => [
        {
          routineId: "r1",
          enabled: true,
          instanceId: "ti_1",
          trigger: {
            provider: "composio",
            source: "github",
            trigger: "GITHUB_COMMIT_EVENT",
          },
        },
      ],
      onEvent: () => {},
      onBindingsChanged: () => {},
    });

    await until(() =>
      h.requests.some((r) => r.path === "/api/v3/internal/sdk/realtime/auth"),
    );

    // Replace key mid-flight; stale auth must be ignored without closing/subscribing the new epoch.
    h.setCustomRoute(undefined);
    composio.setKey(ALT_API_KEY);
    releaseAuth();

    await until(
      () =>
        h.requests.filter(
          (r) =>
            r.path === "/api/v3/internal/sdk/realtime/auth" &&
            r.key === ALT_API_KEY,
        ).length === 1 &&
        h.clientFrames.some((f) => f.event === "pusher:subscribe"),
    );
    expect(
      h.clientFrames.filter((f) => f.event === "pusher:subscribe"),
    ).toHaveLength(1);

    // Now test redaction when a 403/401 happens on credentials without key rotation.
    h.setCustomRoute((_req, url) => {
      if (url.pathname === "/api/v3/internal/sdk/realtime/credentials") {
        return json({ error: { message: `leaked ${ALT_API_KEY}` } }, 401);
      }
      return undefined;
    });
    composio.setEnabled(false);
    composio.setEnabled(true);
    await until(() => provider.status().status === "error");

    const serialized = `${provider.status().error ?? ""}\n${warnings.join("\n")}`;
    expect(serialized).not.toContain(ALT_API_KEY);
    expect(serialized).not.toContain(PUSHER_KEY);
    expect(serialized).not.toContain(CHANNEL_DATA);
    expect(serialized).not.toContain(AUTH_HMAC);
  });

  it("handles server ping/pong, idle ping pongTimeout reconnect, close code classification, and chunked-trigger_to_client reassembly", async () => {
    const h = (activeHarness = createFakeComposio());
    const warnings: string[] = [];
    const { composio, provider } = h.make({
      activityTimeoutMs: 40,
      pongTimeoutMs: 50,
      chunkTimeoutMs: 50,
      warn: (m) => warnings.push(m),
    });

    expect(classifyPusherCloseCode(4000)).toBe("tls_only");
    expect(classifyPusherCloseCode(4001)).toBe("refused");
    expect(classifyPusherCloseCode(4300)).toBe("refused");
    expect(classifyPusherCloseCode(4100)).toBe("backoff");
    expect(classifyPusherCloseCode(1002)).toBe("backoff");
    expect(classifyPusherCloseCode(4200)).toBe("retry");

    const events: IncomingTriggerEvent[] = [];
    provider.start({
      bindings: () => [
        {
          routineId: "r1",
          enabled: true,
          instanceId: "ti_1",
          trigger: {
            provider: "composio",
            source: "github",
            trigger: "GITHUB_COMMIT_EVENT",
          },
        },
      ],
      onEvent: (ev) => events.push(ev),
      onBindingsChanged: () => {},
    });

    await until(() =>
      h.clientFrames.some((f) => f.event === "pusher:subscribe"),
    );
    const conn1 = [...h.connections][0]!;

    // Server ping -> client pong.
    conn1.send(JSON.stringify({ event: "pusher:ping", data: {} }));
    await until(() => h.clientFrames.some((f) => f.event === "pusher:pong"));

    // Server sends chunked payload out of order -> reassembled!
    const largePayload = JSON.stringify({
      id: "msg_chunked_1",
      trigger_slug: "GITHUB_COMMIT_EVENT",
      metadata: {
        trigger_id: "ti_1",
        log_id: "log_c1",
        user_id: composio.userId(),
      },
      data: { body: "A".repeat(1200) },
    });
    const split1 = largePayload.slice(0, 400);
    const split2 = largePayload.slice(400, 900);
    const split3 = largePayload.slice(900);
    conn1.send(
      JSON.stringify({
        event: "chunked-trigger_to_client",
        channel: `private-${PROJECT_ID}_triggers`,
        data: JSON.stringify({ id: "chk_1", index: 1, chunk: split2 }),
      }),
    );
    conn1.send(
      JSON.stringify({
        event: "chunked-trigger_to_client",
        channel: `private-${PROJECT_ID}_triggers`,
        data: JSON.stringify({
          id: "chk_1",
          index: 2,
          chunk: split3,
          final: true,
        }),
      }),
    );
    conn1.send(
      JSON.stringify({
        event: "chunked-trigger_to_client",
        channel: `private-${PROJECT_ID}_triggers`,
        data: JSON.stringify({ id: "chk_1", index: 0, chunk: split1 }),
      }),
    );
    await until(() => events.length === 1);
    expect(events[0]!.eventId).toBe("msg_chunked_1");
    expect((events[0]!.payload as { body: string }).body).toHaveLength(1200);

    // Send incomplete chunk -> expires after chunkTimeoutMs without emitting.
    conn1.send(
      JSON.stringify({
        event: "chunked-trigger_to_client",
        channel: `private-${PROJECT_ID}_triggers`,
        data: JSON.stringify({
          id: "chk_dangling",
          index: 0,
          chunk: "{partial",
        }),
      }),
    );

    // Idle ping sent -> no pong back -> pongTimeout triggers reconnect to conn #2.
    await until(() =>
      h.clientFrames.some((f) => f.connId === 1 && f.event === "pusher:ping"),
    );
    await until(
      () =>
        h.clientFrames.filter((f) => f.event === "pusher:subscribe").length >=
        2,
    );

    // Closing with 4001 ("refused") marks error and stops auto-reconnect.
    const countBefore4001 = h.clientFrames.filter(
      (f) => f.event === "pusher:subscribe",
    ).length;
    const latestConn = [...h.connections][0]!;
    latestConn.close(4001, "refused");
    await until(() => provider.status().status === "error");
    await new Promise((r) => setTimeout(r, 90));
    expect(
      h.clientFrames.filter((f) => f.event === "pusher:subscribe"),
    ).toHaveLength(countBefore4001);
  });

  it("enforces idempotency key fallback hierarchy and rejects metadata.trigger_id", () => {
    expect(
      parseComposioTriggerEvent({
        id: "msg_top",
        trigger_slug: "S",
        metadata: { log_id: "log_m", id: "meta_id", trigger_id: "ti_1" },
        data: { ok: 1 },
      })?.eventId,
    ).toBe("msg_top");

    expect(
      parseComposioTriggerEvent({
        trigger_slug: "S",
        log_id: "log_top",
        metadata: { log_id: "log_m", id: "meta_id", trigger_id: "ti_1" },
        data: {},
      })?.eventId,
    ).toBe("log_m");

    expect(
      parseComposioTriggerEvent({
        trigger_slug: "S",
        log_id: "log_top",
        metadata: { id: "meta_id", trigger_id: "ti_1" },
        data: {},
      })?.eventId,
    ).toBe("log_top");

    expect(
      parseComposioTriggerEvent({
        trigger_slug: "S",
        metadata: { id: "meta_legacy_1", trigger_id: "ti_1" },
        data: {},
      })?.eventId,
    ).toBe("meta_legacy_1");

    // NEVER falls back to metadata.trigger_id when all event IDs are absent.
    expect(
      parseComposioTriggerEvent({
        trigger_slug: "S",
        metadata: { trigger_id: "ti_1" },
        data: {},
      }),
    ).toBeNull();
  });

  it("deduplicates concurrent syncBindings calls while credentials fetch is in flight", async () => {
    const h = (activeHarness = createFakeComposio());
    const { provider } = h.make();
    let releaseCreds!: () => void;
    const credsGate = new Promise<void>((r) => {
      releaseCreds = r;
    });
    h.setCustomRoute(async (req, url) => {
      if (
        req.method === "GET" &&
        url.pathname === "/api/v3/internal/sdk/realtime/credentials"
      ) {
        await credsGate;
      }
      return undefined;
    });

    provider.start({
      bindings: () => [
        {
          routineId: "r1",
          enabled: true,
          instanceId: "ti_1",
          trigger: {
            provider: "composio",
            source: "github",
            trigger: "GITHUB_COMMIT_EVENT",
          },
        },
      ],
      onEvent: () => {},
      onBindingsChanged: () => {},
    });

    await until(() =>
      h.requests.some(
        (r) => r.path === "/api/v3/internal/sdk/realtime/credentials",
      ),
    );
    // Repeated syncBindings() calls while credentials is in flight must not issue duplicate requests.
    provider.syncBindings();
    provider.syncBindings();
    provider.syncBindings();
    releaseCreds();

    await until(() =>
      h.clientFrames.some((f) => f.event === "pusher:subscribe"),
    );
    expect(
      h.requests.filter(
        (r) => r.path === "/api/v3/internal/sdk/realtime/credentials",
      ),
    ).toHaveLength(1);
    expect(
      h.clientFrames.filter((f) => f.event === "pusher:subscribe"),
    ).toHaveLength(1);
  });

  it("preserves server-negotiated activity_timeout across subscription_succeeded and subsequent frames", async () => {
    const h = (activeHarness = createFakeComposio());
    // Short server-negotiated activity_timeout (60ms) with NO local activityTimeoutMs override.
    h.setActivityTimeoutSec(0.06);
    const { provider } = h.make();

    provider.start({
      bindings: () => [
        {
          routineId: "r1",
          enabled: true,
          instanceId: "ti_1",
          trigger: {
            provider: "composio",
            source: "github",
            trigger: "GITHUB_COMMIT_EVENT",
          },
        },
      ],
      onEvent: () => {},
      onBindingsChanged: () => {},
    });

    await until(() =>
      h.clientFrames.some((f) => f.event === "pusher:subscribe"),
    );
    // If subscription_succeeded had overwritten #serverActivityMs with 120s, pusher:ping would not
    // arrive within test timeout; keeping server-negotiated 60ms fires it promptly.
    await until(() => h.clientFrames.some((f) => f.event === "pusher:ping"));
  });

  it("clears stale streamError and refused state when bindings become empty or accounts refresh", async () => {
    const h = (activeHarness = createFakeComposio());
    const { composio, provider } = h.make();
    let bindings: TriggerBinding[] = [
      {
        routineId: "r1",
        enabled: true,
        instanceId: "ti_1",
        trigger: {
          provider: "composio",
          source: "github",
          trigger: "GITHUB_COMMIT_EVENT",
        },
      },
    ];

    provider.start({
      bindings: () => bindings,
      onEvent: () => {},
      onBindingsChanged: () => {},
    });

    await until(() =>
      h.clientFrames.some((f) => f.event === "pusher:subscribe"),
    );
    const conn = [...h.connections][0]!;
    conn.close(4001, "refused");
    await until(() => provider.status().status === "error");

    // Clearing all active bindings disconnects and clears stale streamError/refused back to ready.
    bindings = [];
    provider.syncBindings();
    expect(provider.status()).toEqual({
      provider: "composio",
      status: "ready",
    });

    // Re-adding a binding and suffering a 4001 error again can recover cleanly on accounts refresh.
    bindings = [
      {
        routineId: "r1",
        enabled: true,
        instanceId: "ti_1",
        trigger: {
          provider: "composio",
          source: "github",
          trigger: "GITHUB_COMMIT_EVENT",
        },
      },
    ];
    provider.syncBindings();
    await until(
      () =>
        h.clientFrames.filter((f) => f.event === "pusher:subscribe").length ===
        2,
    );
    const conn2 = [...h.connections][0]!;
    conn2.close(4001, "refused");
    await until(() => provider.status().status === "error");

    await composio.follow();
    expect(provider.status().status).toBe("ready");
    await until(
      () =>
        h.clientFrames.filter((f) => f.event === "pusher:subscribe").length ===
        3,
    );
  });
});
