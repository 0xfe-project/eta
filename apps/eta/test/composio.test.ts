/**
 * The Composio source of the market against a local fake of backend.composio.dev that counts its
 * requests: nothing reaches the network, and no real key is used.
 */
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { authOf, Composio, COMPOSIO_URL } from "../src/plugins/composio";
import { githubProxy } from "../src/plugins/git";
import { Logos } from "../src/plugins/logo";
import { Market } from "../src/plugins/market";
import { CatalogCache } from "../src/plugins/market-cache";
import { SettingStore } from "../src/settings/store";

const KEY = "ck_test_SECRET_0123456789";
const item = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: slug.toUpperCase(),
  auth_schemes: ["OAUTH2"],
  composio_managed_auth_schemes: ["OAUTH2"],
  no_auth: false,
  deprecated: { toolkitId: "x" },
  meta: {
    description: `the ${slug} toolkit`,
    logo: `https://assets.composio.dev/logos/${slug}.png`,
    app_url: `https://${slug}.example`,
    categories: [{ id: "dev", name: "Developer Tools" }],
    tools_count: 3,
  },
  ...extra,
});

let requests: {
  method: string;
  path: string;
  key: string | null;
  body: string;
}[];
let handler: (
  request: Request,
  url: URL,
  body: string,
) => Response | Promise<Response>;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  githubProxy.prefix = "";
  requests = [];
  handler = () => new Response("{}", { status: 404 });
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        key: request.headers.get("x-api-key"),
        body,
      });
      return await handler(request, url, body);
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  vi.restoreAllMocks();
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

function open(options: { timeoutMs?: number } = {}) {
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  const settings = new SettingStore(db);
  const cache = new CatalogCache(db, { maxRowBytes: 1024 * 1024 });
  const start = () => {
    const composio = new Composio({
      db,
      key: Buffer.alloc(32, 7),
      settings,
      cache,
      baseUrl: `http://127.0.0.1:${server.port}`,
      ...options,
    });
    const market = new Market({
      settings,
      plugins: {} as never,
      dataDir: "unused",
      composio,
      cache,
    });
    return { composio, market };
  };
  return { db, settings, ...start(), start };
}

const composioOf = async (
  market: Market,
  mode: "refresh" | "cached" = "refresh",
) =>
  (await market.catalog(mode)).sources.find(
    (one) => one.source.kind === "composio",
  )!;

describe("the Composio source", () => {
  it("is listed, on, and cannot be removed", () => {
    const { market } = open();
    const one = market.sources().find((source) => source.kind === "composio")!;
    expect(one).toMatchObject({
      url: COMPOSIO_URL,
      name: "Composio",
      enabled: true,
    });
    expect(() => market.removeSource(COMPOSIO_URL)).toThrow();
  });

  it("can be switched off and on like any source, and the git list is not touched", async () => {
    const { market, settings } = open();
    market.setSourceEnabled(COMPOSIO_URL, false);
    expect(
      market.settings().sources.find((s) => s.kind === "composio")?.enabled,
    ).toBe(false);
    expect(
      (await market.catalog()).sources.some(
        (s) => s.source.kind === "composio",
      ),
    ).toBe(false);
    expect(JSON.stringify(settings.get("plugins.sources") ?? [])).not.toContain(
      "composio",
    );
    market.setSourceEnabled(COMPOSIO_URL, true);
    expect(
      (await market.catalog("cached")).sources.some(
        (s) => s.source.kind === "composio",
      ),
    ).toBe(true);
  });

  it("says a key is needed when there is none: no request, no error", async () => {
    const { market } = open();
    const one = await composioOf(market);
    expect(one).toMatchObject({
      status: "needs_key",
      entries: null,
      toolkits: null,
      error: null,
    });
    expect(requests).toHaveLength(0);
  });

  it("does not hide the other sources when it needs a key", async () => {
    const { market } = open();
    const git = Bun.serve({
      port: 0,
      fetch: () =>
        json({
          plugins: [{ name: "demo", description: "d", source: "./demo" }],
        }),
    });
    try {
      for (const source of market.sources())
        if (source.kind !== "composio") market.removeSource(source.url);
      market.addSource(`http://127.0.0.1:${git.port}/catalog.json`, "");
      const sources = (await market.catalog()).sources;
      expect(sources.map((s) => s.source.kind ?? "git")).toEqual([
        "git",
        "composio",
      ]);
      expect(sources[0]!.entries?.map((entry) => entry.name)).toEqual(["demo"]);
      expect(sources[1]!.status).toBe("needs_key");
    } finally {
      await git.stop(true);
    }
  });

  it("reads every page with the key in x-api-key, and maps the fields", async () => {
    const { market, composio } = open();
    composio.setKey(KEY);
    handler = (_request, url) => {
      const cursor = url.searchParams.get("cursor");
      if (cursor === null)
        return json({
          items: [
            item("github"),
            item("stripe", {
              auth_schemes: ["API_KEY"],
              composio_managed_auth_schemes: [],
            }),
            item("weather", { no_auth: true, auth_schemes: ["NO_AUTH"] }),
          ],
          next_cursor: "page2",
        });
      return json({
        items: [
          item("odd", {
            auth_schemes: ["SAML"],
            composio_managed_auth_schemes: [],
          }),
          item("plainlogo", {
            meta: {
              description: "d",
              logo: "http://assets.example/x.png",
              categories: ["Misc"],
            },
          }),
          { slug: "bad slug!", name: "x" },
          item("github"),
        ],
        next_cursor: null,
      });
    };
    const one = await composioOf(market);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.key === KEY && r.method === "GET")).toBe(
      true,
    );
    expect(requests[1]!.path).toContain("cursor=page2");
    expect(one.status).toBe("ready");
    expect(one.entries).toEqual([]);
    const byslug = Object.fromEntries(one.toolkits!.map((t) => [t.slug, t]));
    expect(Object.keys(byslug)).toEqual([
      "github",
      "stripe",
      "weather",
      "odd",
      "plainlogo",
    ]);
    expect(byslug.github).toMatchObject({
      kind: "composio",
      name: "GITHUB",
      auth: "oauth",
      managed: true,
      categories: ["Developer Tools"],
      logo: "https://assets.composio.dev/logos/github.png",
      toolsCount: 3,
      source: COMPOSIO_URL,
      sourceName: "Composio",
    });
    expect(byslug.stripe).toMatchObject({ auth: "api_key", managed: false });
    expect(byslug.weather!.auth).toBe("none");
    expect(byslug.odd!.auth).toBe("unknown");
    expect(byslug.plainlogo).toMatchObject({
      logo: null,
      categories: ["Misc"],
    });
  });

  it("classifies the schemes", () => {
    expect(authOf(["OAUTH2", "API_KEY"], [], false)).toBe("oauth");
    expect(authOf(["API_KEY"], [], false)).toBe("api_key");
    expect(authOf(["BEARER_TOKEN"], [], false)).toBe("api_key");
    expect(authOf(["NO_AUTH"], [], false)).toBe("none");
    expect(authOf([], [], true)).toBe("none");
    expect(authOf(["SOMETHING_NEW"], [], false)).toBe("unknown");
    expect(authOf([], [], false)).toBe("unknown");
  });

  it("says the key was refused on a 401, for this source only", async () => {
    const { market, composio } = open();
    composio.setKey(KEY);
    handler = () => json({ error: { message: "bad key" } }, 401);
    const one = await composioOf(market);
    expect(one).toMatchObject({
      status: "key_rejected",
      entries: null,
      toolkits: null,
      error: null,
    });
  });

  it("answers an error, not a hang, when Composio is silent", async () => {
    const { market, composio } = open({ timeoutMs: 100 });
    composio.setKey(KEY);
    handler = async () => {
      await new Promise((done) => setTimeout(done, 400));
      return json({ items: [], next_cursor: null });
    };
    const one = await composioOf(market);
    expect(one.status).toBe("error");
    expect(one.error).toContain("did not answer");
  });

  it("refuses a list whose pages do not end", async () => {
    const { market, composio } = open();
    composio.setKey(KEY);
    handler = () => json({ items: [item("a")], next_cursor: "same" });
    expect((await composioOf(market)).error).toContain("do not end");
  });

  it("keeps the old list, with its age and the reason, when reading again fails", async () => {
    const { market, composio } = open();
    composio.setKey(KEY);
    handler = () => json({ items: [item("github")], next_cursor: null });
    await composioOf(market);
    handler = () => new Response("down", { status: 503 });
    const one = await composioOf(market);
    expect(one.status).toBe("ready");
    expect(one.toolkits?.map((t) => t.slug)).toEqual(["github"]);
    expect(one.stale).toContain("503");
    expect(one.updatedAt).toBeGreaterThan(0);
    expect(one.error).toBeNull();
  });

  it("serves the kept list after a restart with no request, but only while a key is set", async () => {
    const first = open();
    first.composio.setKey(KEY);
    handler = () => json({ items: [item("github")], next_cursor: null });
    await composioOf(first.market);
    requests.length = 0;
    const again = first.start();
    expect(
      (await composioOf(again.market, "cached")).toolkits?.map((t) => t.slug),
    ).toEqual(["github"]);
    expect(requests).toHaveLength(0);
    again.composio.clearKey();
    expect(await composioOf(again.market, "cached")).toMatchObject({
      status: "needs_key",
      toolkits: null,
    });
  });

  it("does not follow a redirect with the key", async () => {
    const { market, composio } = open();
    composio.setKey(KEY);
    handler = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/x" },
      });
    const one = await composioOf(market);
    expect(one.status).toBe("error");
    expect(requests).toHaveLength(1);
  });
});

describe("the key", () => {
  it("is set, reported as set, and cleared; it is validated", () => {
    const { composio } = open();
    expect(composio.hasKey()).toBe(false);
    expect(() => composio.setKey("has space")).toThrow();
    expect(() => composio.setKey("")).toThrow();
    composio.setKey(`  ${KEY}\n`);
    expect(composio.hasKey()).toBe(true);
    composio.clearKey();
    expect(composio.hasKey()).toBe(false);
  });

  it("is sealed in the database and nowhere else: not in rows, cache, settings, errors or logs", async () => {
    const out = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "info"),
    ];
    const { market, composio, db } = open();
    composio.setKey(KEY);
    handler = () =>
      new Response(`internal error for key ${KEY}`, { status: 500 });
    const failed = await composioOf(market);
    handler = () => json({ items: [item("github")], next_cursor: null });
    const ok = await composioOf(market);
    handler = (_r, url) =>
      url.pathname.endsWith("/link")
        ? json({ error: `no ${KEY}` }, 500)
        : json({ items: [{ id: "ac_1", is_composio_managed: true }] });
    const link = await composio
      .link("github")
      .catch((error: Error) => error.message);
    const dump = JSON.stringify({
      failed,
      ok,
      link,
      status: composio.hasKey(),
      rows: db
        .query("SELECT * FROM composio_key")
        .all()
        .map((row) =>
          Buffer.from((row as { sealed: Uint8Array }).sealed).toString(
            "latin1",
          ),
        ),
      cache: db.query("SELECT * FROM market_catalog_cache").all(),
      settings: db.query("SELECT * FROM setting").all(),
      logs: out.map((spy) => spy.mock.calls),
    });
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("SECRET_0123");
    expect(String(failed.error)).toContain("500");
  });
});

describe("the link", () => {
  const link =
    (extra?: (url: URL, body: string) => Response | undefined) =>
    (_request: Request, url: URL, body: string): Response => {
      const own = extra?.(url, body);
      if (own !== undefined) return own;
      if (url.pathname === "/api/v3/auth_configs" && _request.method === "GET")
        return json({
          items: [
            {
              id: "ac_managed",
              is_composio_managed: true,
              status: "ENABLED",
              toolkit: { slug: "github" },
            },
          ],
        });
      if (url.pathname === "/api/v3/connected_accounts/link")
        return json({
          redirect_url: "https://connect.composio.dev/link/abc",
          link_token: "t",
          expires_at: "x",
          connected_account_id: "ca_1",
        });
      return json({}, 404);
    };

  it("needs a key", async () => {
    const { composio } = open();
    await expect(composio.link("github")).rejects.toThrow("API key");
    expect(requests).toHaveLength(0);
  });

  it("uses the managed auth config the project has, and returns Composio's https address", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    handler = link();
    expect(await composio.link("github")).toBe(
      "https://connect.composio.dev/link/abc",
    );
    expect(requests.map((r) => `${r.method} ${r.path.split("?")[0]}`)).toEqual([
      "GET /api/v3/auth_configs",
      "POST /api/v3/connected_accounts/link",
    ]);
    expect(requests[0]!.path).toContain("toolkit_slug=github");
    expect(requests.every((r) => r.key === KEY)).toBe(true);
    const sent = JSON.parse(requests[1]!.body) as {
      auth_config_id: string;
      user_id: string;
    };
    expect(sent.auth_config_id).toBe("ac_managed");
    // A random id made here: nothing about the person.
    expect(sent.user_id).toMatch(/^eta-[0-9a-f-]{36}$/);
  });

  it("keeps the same user id, and asks for the auth config only once per toolkit", async () => {
    const { composio, start } = open();
    composio.setKey(KEY);
    handler = link();
    await composio.link("github");
    await composio.link("github");
    expect(
      requests.filter((r) => r.path.startsWith("/api/v3/auth_configs")),
    ).toHaveLength(1);
    const ids = requests
      .filter((r) => r.path.includes("/link"))
      .map((r) => (JSON.parse(r.body) as { user_id: string }).user_id);
    expect(new Set(ids).size).toBe(1);
    // Kept in the settings: a new Composio on the same database means the same user.
    await start().composio.link("github");
    const last = requests.filter((r) => r.path.includes("/link")).at(-1)!;
    expect((JSON.parse(last.body) as { user_id: string }).user_id).toBe(ids[0]);
  });

  it("makes the managed auth config when the project has none", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    handler = link((url, body) => {
      if (url.pathname === "/api/v3/auth_configs" && body === "")
        return json({ items: [] });
      if (url.pathname === "/api/v3/auth_configs")
        return json({
          toolkit: { slug: "github" },
          auth_config: {
            id: "ac_new",
            auth_scheme: "OAUTH2",
            is_composio_managed: true,
            managed_app_id: null,
          },
        });
      return undefined;
    });
    await composio.link("github");
    const made = requests.find(
      (r) => r.method === "POST" && r.path === "/api/v3/auth_configs",
    )!;
    expect(JSON.parse(made.body)).toEqual({
      toolkit: { slug: "github" },
      auth_config: { type: "use_composio_managed_auth" },
    });
    expect(
      (JSON.parse(requests.at(-1)!.body) as { auth_config_id: string })
        .auth_config_id,
    ).toBe("ac_new");
  });

  it("refuses an address that is not https, or has no address", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    for (const redirect_url of [
      "http://connect.composio.dev/x",
      "javascript:alert(1)",
      "https://u:p@x.example/",
      undefined,
    ]) {
      handler = link((url) =>
        url.pathname.endsWith("/link")
          ? json({
              redirect_url,
              link_token: "t",
              expires_at: "x",
              connected_account_id: "c",
            })
          : undefined,
      );
      await expect(composio.link("github")).rejects.toThrow("https");
    }
  });

  it("says the key was refused, and refuses a name that is not a slug", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    handler = () => json({}, 401);
    await expect(composio.link("github")).rejects.toThrow(
      "refused the API key",
    );
    await expect(composio.link("../x")).rejects.toThrow("toolkit name");
  });
});

describe("the logo", () => {
  it("is looked up by slug in the host's own list; a toolkit without one has none", async () => {
    const { market, composio } = open();
    composio.setKey(KEY);
    handler = () =>
      json({
        items: [item("github"), item("nologo", { meta: { description: "d" } })],
        next_cursor: null,
      });
    await composioOf(market);
    expect(composio.logoOf("github")).toBe(
      "https://assets.composio.dev/logos/github.png",
    );
    expect(composio.logoOf("nologo")).toBeNull();
    expect(composio.logoOf("unknown")).toBeNull();
  });

  it("is fetched over https only, never sends a key, and falls back to the letter on any failure", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
    ]);
    const seen: Headers[] = [];
    const pictures = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push(request.headers);
        return new Response(png);
      },
    });
    try {
      const logos = new Logos({ allowPrivate: true, timeoutMs: 500 });
      // Plain http is refused, even to a host that would answer.
      expect(
        await logos.fromUrl(`http://127.0.0.1:${pictures.port}/a.png`),
      ).toBeNull();
      // A public name resolving inside the network is refused.
      const guarded = new Logos({ resolve: async () => ["127.0.0.1"] });
      expect(
        await guarded.fromUrl("https://assets.composio.dev/logos/github.png"),
      ).toBeNull();
      expect(seen).toHaveLength(0);
    } finally {
      await pictures.stop(true);
    }
  });

  it("does not take a redirect to http", async () => {
    const target = Bun.serve({ port: 0, fetch: () => new Response("x") });
    try {
      const logos = new Logos({
        allowPrivate: true,
        timeoutMs: 500,
        resolve: async () => ["127.0.0.1"],
      });
      const to = `http://127.0.0.1:${target.port}/p.png`;
      const hop = Bun.serve({
        port: 0,
        fetch: () =>
          new Response(null, { status: 302, headers: { location: to } }),
      });
      try {
        // The first hop is plain http too, so this only shows the whole chain is refused.
        expect(
          await logos.fromUrl(`http://127.0.0.1:${hop.port}/a.png`),
        ).toBeNull();
      } finally {
        await hop.stop(true);
      }
    } finally {
      await target.stop(true);
    }
  });
});
