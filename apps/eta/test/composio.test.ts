/**
 * The Composio source of the market against a local fake of backend.composio.dev that counts its
 * requests: nothing reaches the network, and no real key is used.
 */
import { Buffer } from "node:buffer";
import { COMPOSIO_NO_MANAGED_LOGIN } from "@eta/client-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedCredentialTable } from "../src/credentials/table";
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
  it("is listed, off without a key, on with one, and cannot be removed", () => {
    const { market, composio } = open();
    const one = () =>
      market.sources().find((source) => source.kind === "composio")!;
    expect(one()).toMatchObject({
      url: COMPOSIO_URL,
      name: "Composio",
      enabled: false,
    });
    composio.setKey(KEY);
    expect(one()).toMatchObject({
      url: COMPOSIO_URL,
      name: "Composio",
      enabled: true,
    });
    expect(() => market.removeSource(COMPOSIO_URL)).toThrow();
  });

  it("can be switched off and on like any source, and the git list is not touched", async () => {
    const { market, settings, composio } = open();
    composio.setKey(KEY);
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

  it("says a key is needed when it is asked with none: no request, no error", async () => {
    const { composio } = open();
    const one = await composio.read(composio.source(), "refresh");
    expect(one).toMatchObject({
      status: "needs_key",
      entries: null,
      toolkits: null,
      error: null,
    });
    expect(requests).toHaveLength(0);
  });

  it("does not hide the other sources while there is no key", async () => {
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
      expect(sources.map((s) => s.source.kind ?? "git")).toEqual(["git"]);
      expect(sources[0]!.entries?.map((entry) => entry.name)).toEqual(["demo"]);
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
    expect(
      (await again.market.catalog("cached")).sources.some(
        (one) => one.source.kind === "composio",
      ),
    ).toBe(false);
  });

  it("names only the toolkits asked for from the kept list, with no request, and nothing without a key", async () => {
    const first = open();
    first.composio.setKey(KEY);
    handler = () =>
      json({
        items: [item("github"), item("gmail"), item("exa")],
        next_cursor: null,
      });
    await composioOf(first.market);
    requests.length = 0;
    const again = first.start();
    expect(again.composio.toolkitsOf(["gmail", "ghost", "github"])).toEqual([
      { slug: "github", name: "GITHUB", description: "the github toolkit" },
      { slug: "gmail", name: "GMAIL", description: "the gmail toolkit" },
    ]);
    expect(requests).toHaveLength(0);
    again.composio.clearKey();
    expect(again.composio.toolkitsOf(["gmail"])).toEqual([]);
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
        .query("SELECT * FROM credential WHERE integration = 'market'")
        .all()
        .map((row) =>
          Buffer.from((row as { value: Uint8Array }).value).toString("latin1"),
        ),
      cache: db.query("SELECT * FROM market_catalog_cache").all(),
      settings: db.query("SELECT * FROM setting").all(),
      logs: out.map((spy) => spy.mock.calls),
    });
    expect(JSON.parse(dump).rows).toHaveLength(1);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("SECRET_0123");
    expect(String(failed.error)).toContain("500");
  });

  it("is one row of the credential table (market, composio, secret), and clearing takes only that row", () => {
    const { composio, db } = open();
    const table = new EncryptedCredentialTable(db, Buffer.alloc(32, 7));
    table.write("market", "cursor", "secret", "cursor-token");
    composio.setKey(KEY);
    expect(table.read("market", "composio", "secret")).toBe(KEY);
    composio.setKey(`${KEY}x`);
    expect(
      db
        .query("SELECT count(*) AS n FROM credential WHERE key = 'composio'")
        .get(),
    ).toEqual({ n: 1 });
    composio.clearKey();
    expect(table.read("market", "composio", "secret")).toBeUndefined();
    expect(table.read("market", "cursor", "secret")).toBe("cursor-token");
    expect(composio.hasKey()).toBe(false);
  });

  it("reads a key that was put in the credential table by someone else, and a value that is not a string as no key", () => {
    const { composio, db } = open();
    const table = new EncryptedCredentialTable(db, Buffer.alloc(32, 7));
    table.write("market", "composio", "secret", { not: "a string" });
    expect(composio.hasKey()).toBe(false);
    table.write("market", "composio", "secret", KEY);
    expect(composio.hasKey()).toBe(true);
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

  it("does not ask for an auth config or a link for a toolkit that needs no sign-in, and still does for any other kind", async () => {
    const { composio, market } = open();
    composio.setKey(KEY);
    handler = () =>
      json({
        items: [
          item("hackernews", {
            auth_schemes: ["NO_AUTH"],
            composio_managed_auth_schemes: [],
            no_auth: true,
          }),
          item("exa", {
            auth_schemes: ["API_KEY"],
            composio_managed_auth_schemes: [],
          }),
          item("gmail"),
          item("odd", {
            auth_schemes: ["SOMETHING_NEW"],
            composio_managed_auth_schemes: [],
          }),
        ],
        next_cursor: null,
      });
    await composioOf(market);
    requests.length = 0;
    handler = link();
    await expect(composio.link("hackernews")).rejects.toThrow();
    expect(requests).toHaveLength(0);
    // A toolkit that signs in with the user's own key, and one Composio has no sign-in of its own
    // for (the `odd` one), have their tests below.
    for (const slug of ["gmail", "not-in-the-list"]) {
      requests.length = 0;
      expect(await composio.link(slug)).toBe(
        "https://connect.composio.dev/link/abc",
      );
      expect(
        requests.some((r) => r.path.startsWith("/api/v3/auth_configs")),
      ).toBe(true);
      expect(
        requests.some((r) => r.path === "/api/v3/connected_accounts/link"),
      ).toBe(true);
    }
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
      // The config it made is then switched on for the tool router.
      if (url.pathname === "/api/v3/auth_configs/ac_new")
        return json({ success: true });
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

  describe("the auth config's switch for the tool router", () => {
    const managed = (id: string, flag?: boolean, extra: object = {}) => ({
      id,
      is_composio_managed: true,
      status: "ENABLED",
      ...(flag === undefined ? {} : { is_enabled_for_tool_router: flag }),
      ...extra,
    });
    const listing = (items: unknown[], patch?: () => Response) =>
      link((url, body) => {
        if (url.pathname === "/api/v3/auth_configs" && body === "")
          return json({ items });
        if (url.pathname === "/api/v3/auth_configs" && body !== "")
          return json({
            toolkit: { slug: "github" },
            auth_config: { id: "ac_new", is_composio_managed: true },
          });
        if (url.pathname.startsWith("/api/v3/auth_configs/"))
          return patch?.() ?? json({ success: true });
        return undefined;
      });
    const patches = () => requests.filter((r) => r.method === "PATCH");
    const linkedTo = () =>
      (
        JSON.parse(requests.find((r) => r.path.includes("/link"))!.body) as {
          auth_config_id: string;
        }
      ).auth_config_id;

    it("switches a config it just made on for the tool router, before the link is asked for", async () => {
      const { composio } = open();
      composio.setKey(KEY);
      handler = listing([]);
      await composio.link("github");
      expect(
        requests.map((r) => `${r.method} ${r.path.split("?")[0]}`),
      ).toEqual([
        "GET /api/v3/auth_configs",
        "POST /api/v3/auth_configs",
        "PATCH /api/v3/auth_configs/ac_new",
        "POST /api/v3/connected_accounts/link",
      ]);
      expect(JSON.parse(patches()[0]!.body)).toEqual({
        type: "default",
        is_enabled_for_tool_router: true,
      });
      expect(linkedTo()).toBe("ac_new");
    });

    it("switches an existing managed config on when it is off, once, and not again for the same toolkit", async () => {
      const { composio } = open();
      composio.setKey(KEY);
      handler = listing([managed("ac_old", false)]);
      await composio.link("github");
      expect(patches()).toHaveLength(1);
      expect(patches()[0]!.path).toBe("/api/v3/auth_configs/ac_old");
      expect(JSON.parse(patches()[0]!.body)).toEqual({
        type: "default",
        is_enabled_for_tool_router: true,
      });
      expect(linkedTo()).toBe("ac_old");
      await composio.link("github");
      expect(patches()).toHaveLength(1);
    });

    it("sends no PATCH for a config that is on, or whose list does not say", async () => {
      for (const flag of [true, undefined]) {
        requests.length = 0;
        const { composio } = open();
        composio.setKey(KEY);
        handler = listing([managed("ac_x", flag)]);
        await composio.link("github");
        expect(patches()).toHaveLength(0);
      }
    });

    it("takes the one that is already on when there are two, and patches nothing", async () => {
      const { composio } = open();
      composio.setKey(KEY);
      handler = listing([managed("ac_early", false), managed("ac_late", true)]);
      await composio.link("github");
      expect(patches()).toHaveLength(0);
      expect(linkedTo()).toBe("ac_late");
    });

    it("still returns the address when the PATCH of an existing config fails, says so in the log, and no key is in any output", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { composio } = open();
      composio.setKey(KEY);
      handler = listing([managed("ac_old", false)], () =>
        json({ message: `no ${KEY}` }, 500),
      );
      expect(await composio.link("github")).toBe(
        "https://connect.composio.dev/link/abc",
      );
      expect(linkedTo()).toBe("ac_old");
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET_0123");
    });

    it("fails with a clear message when the PATCH of a config it just made fails, and asks for no link", async () => {
      const { composio } = open();
      composio.setKey(KEY);
      handler = listing([], () => json({ message: `no ${KEY}` }, 403));
      const error = await composio.link("github").then(
        () => undefined,
        (caught: unknown) => String(caught),
      );
      expect(error).toContain("tool router");
      expect(error).not.toContain("SECRET_0123");
      expect(requests.some((r) => r.path.includes("/link"))).toBe(false);
    });
  });

  describe("a toolkit that signs in with a key the user owns", () => {
    const toolkitOf = (...schemes: string[]) =>
      item("exa", {
        auth_schemes: schemes,
        composio_managed_auth_schemes: [],
      });
    const mine = (id: string, extra: object = {}) => ({
      id,
      is_composio_managed: false,
      status: "ENABLED",
      auth_scheme: "API_KEY",
      toolkit: { slug: "exa" },
      ...extra,
    });
    const managedOne = {
      id: "ac_managed",
      is_composio_managed: true,
      status: "ENABLED",
      auth_scheme: "OAUTH2",
      is_enabled_for_tool_router: true,
    };
    async function listed(
      items: unknown[],
      schemes: string[] = ["API_KEY", "BEARER_TOKEN"],
      patch?: () => Response,
    ) {
      const { composio, market } = open();
      composio.setKey(KEY);
      handler = () =>
        json({ items: [toolkitOf(...schemes)], next_cursor: null });
      await composioOf(market);
      requests.length = 0;
      handler = link((url, body) => {
        if (url.pathname === "/api/v3/auth_configs" && body === "")
          return json({ items });
        if (url.pathname === "/api/v3/auth_configs")
          return json({
            toolkit: { slug: "exa" },
            auth_config: {
              id: "ac_custom",
              auth_scheme: "API_KEY",
              is_composio_managed: false,
            },
          });
        if (url.pathname.startsWith("/api/v3/auth_configs/"))
          return patch?.() ?? json({ success: true });
        return undefined;
      });
      return composio;
    }
    const steps = () =>
      requests.map((r) => `${r.method} ${r.path.split("?")[0]}`);
    const linkedTo = () =>
      (
        JSON.parse(requests.find((r) => r.path.includes("/link"))!.body) as {
          auth_config_id: string;
        }
      ).auth_config_id;

    it("makes no managed config: with none of its own it makes a custom one with no credentials, switches it on, then links", async () => {
      const composio = await listed([managedOne]);
      expect(await composio.link("exa")).toBe(
        "https://connect.composio.dev/link/abc",
      );
      expect(steps()).toEqual([
        "GET /api/v3/auth_configs",
        "POST /api/v3/auth_configs",
        "PATCH /api/v3/auth_configs/ac_custom",
        "POST /api/v3/connected_accounts/link",
      ]);
      expect(JSON.parse(requests[1]!.body)).toEqual({
        toolkit: { slug: "exa" },
        auth_config: {
          type: "use_custom_auth",
          authScheme: "API_KEY",
          name: expect.any(String),
          credentials: {},
        },
      });
      expect(JSON.stringify(requests)).not.toContain("use_composio_managed");
      expect(JSON.parse(requests[2]!.body)).toEqual({
        type: "default",
        is_enabled_for_tool_router: true,
      });
      expect(linkedTo()).toBe("ac_custom");
    });

    it("makes a bearer-token config for a toolkit that lists no API_KEY", async () => {
      const composio = await listed([], ["BEARER_TOKEN"]);
      await composio.link("exa");
      expect(
        (
          JSON.parse(requests[1]!.body) as {
            auth_config: { authScheme: string };
          }
        ).auth_config.authScheme,
      ).toBe("BEARER_TOKEN");
    });

    it("takes a config of its own that is on for the tool router, and creates and patches nothing", async () => {
      const composio = await listed([
        managedOne,
        mine("ac_oauth_of_mine", { auth_scheme: "OAUTH2" }),
        mine("ac_off", { is_enabled_for_tool_router: false }),
        mine("ac_disabled", { status: "DISABLED" }),
        mine("ac_mine", { is_enabled_for_tool_router: true }),
      ]);
      await composio.link("exa");
      expect(steps()).toEqual([
        "GET /api/v3/auth_configs",
        "POST /api/v3/connected_accounts/link",
      ]);
      expect(linkedTo()).toBe("ac_mine");
    });

    it("switches a config of its own on when it is off, and still links when that fails, saying so in the log", async () => {
      const composio = await listed([
        mine("ac_off", { is_enabled_for_tool_router: false }),
      ]);
      await composio.link("exa");
      expect(steps()).toEqual([
        "GET /api/v3/auth_configs",
        "PATCH /api/v3/auth_configs/ac_off",
        "POST /api/v3/connected_accounts/link",
      ]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const failing = await listed(
        [mine("ac_off", { is_enabled_for_tool_router: false })],
        undefined,
        () => json({ message: `no ${KEY}` }, 500),
      );
      expect(await failing.link("exa")).toBe(
        "https://connect.composio.dev/link/abc",
      );
      expect(linkedTo()).toBe("ac_off");
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET_0123");
    });

    it("never deletes anything on Composio", async () => {
      const composio = await listed([mine("ac_mine", {})]);
      await composio.link("exa");
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  describe("a toolkit Composio has no managed sign-in for", () => {
    const toolkitOf = (slug: string, ...schemes: string[]) =>
      item(slug, { auth_schemes: schemes, composio_managed_auth_schemes: [] });
    const mine = (id: string, extra: object = {}) => ({
      id,
      is_composio_managed: false,
      status: "ENABLED",
      auth_scheme: "OAUTH2",
      ...extra,
    });
    const managedOne = {
      id: "ac_managed",
      is_composio_managed: true,
      status: "ENABLED",
      auth_scheme: "OAUTH2",
      is_enabled_for_tool_router: true,
    };
    async function listed(
      toolkits: unknown[],
      configs: unknown[],
      patch?: () => Response,
    ) {
      const { composio, market } = open();
      composio.setKey(KEY);
      handler = () => json({ items: toolkits, next_cursor: null });
      await composioOf(market);
      requests.length = 0;
      handler = link((url, body) => {
        if (url.pathname === "/api/v3/auth_configs" && body === "")
          return json({ items: configs });
        if (url.pathname === "/api/v3/auth_configs")
          return json({
            auth_config: { id: "ac_made", is_composio_managed: false },
          });
        if (url.pathname.startsWith("/api/v3/auth_configs/"))
          return patch?.() ?? json({ success: true });
        return undefined;
      });
      return composio;
    }
    const steps = () =>
      requests.map((r) => `${r.method} ${r.path.split("?")[0]}`);
    const linkedTo = () =>
      (
        JSON.parse(requests.find((r) => r.path.includes("/link"))!.body) as {
          auth_config_id: string;
        }
      ).auth_config_id;
    // Schemes eta has no evidence it can make a config for without the user's credentials: for these
    // nothing is created, and a config the user made on Composio is the only way in.
    const NEEDS_OWN_APP: [string, string[]][] = [
      ["twitter", ["OAUTH2"]],
      ["railway_mcp", ["OAUTH2"]],
      ["odd", ["SOMETHING_NEW"]],
    ];

    it("makes a custom key config, not a managed one, for a toolkit that lists a key next to OAuth (Railway)", async () => {
      expect(authOf(["OAUTH2", "API_KEY"], [], false)).toBe("oauth");
      const composio = await listed(
        [toolkitOf("railway", "OAUTH2", "API_KEY")],
        [managedOne],
      );
      expect(await composio.link("railway")).toBe(
        "https://connect.composio.dev/link/abc",
      );
      expect(steps()).toEqual([
        "GET /api/v3/auth_configs",
        "POST /api/v3/auth_configs",
        "PATCH /api/v3/auth_configs/ac_made",
        "POST /api/v3/connected_accounts/link",
      ]);
      expect(JSON.parse(requests[1]!.body)).toEqual({
        toolkit: { slug: "railway" },
        auth_config: {
          type: "use_custom_auth",
          authScheme: "API_KEY",
          name: expect.any(String),
          credentials: {},
        },
      });
      expect(JSON.stringify(requests)).not.toContain("use_composio_managed");
      expect(linkedTo()).toBe("ac_made");
    });

    it("takes the bearer token scheme when that is the key it lists next to OAuth", async () => {
      const composio = await listed(
        [toolkitOf("railway", "OAUTH2", "BEARER_TOKEN")],
        [],
      );
      await composio.link("railway");
      expect(
        (
          JSON.parse(requests[1]!.body) as {
            auth_config: { authScheme: string };
          }
        ).auth_config.authScheme,
      ).toBe("BEARER_TOKEN");
    });

    it("asks nothing of Composio but the list when there is no config of its own, and says what to do", async () => {
      for (const [slug, schemes] of NEEDS_OWN_APP) {
        const composio = await listed(
          [toolkitOf(slug, ...schemes)],
          [managedOne, mine("ac_disabled", { status: "DISABLED" })],
        );
        const error = await composio.link(slug).then(
          () => "",
          (caught: unknown) => String(caught),
        );
        expect(error).toContain(COMPOSIO_NO_MANAGED_LOGIN);
        expect(error).not.toContain("404");
        expect(steps()).toEqual(["GET /api/v3/auth_configs"]);
      }
    });

    it("uses a config of its own that is on for the tool router, of any scheme, and creates and patches nothing", async () => {
      for (const [slug, schemes] of NEEDS_OWN_APP) {
        const composio = await listed(
          [toolkitOf(slug, ...schemes)],
          [
            managedOne,
            mine("ac_off", { is_enabled_for_tool_router: false }),
            mine("ac_disabled", { status: "DISABLED" }),
            mine("ac_mine", {
              auth_scheme: schemes[0],
              is_enabled_for_tool_router: true,
            }),
          ],
        );
        expect(await composio.link(slug)).toBe(
          "https://connect.composio.dev/link/abc",
        );
        expect(steps()).toEqual([
          "GET /api/v3/auth_configs",
          "POST /api/v3/connected_accounts/link",
        ]);
        expect(linkedTo()).toBe("ac_mine");
      }
    });

    it("switches a config of its own on for the tool router when it is off, and still links when that fails", async () => {
      const composio = await listed(
        [toolkitOf("twitter", "OAUTH2")],
        [mine("ac_off", { is_enabled_for_tool_router: false })],
      );
      await composio.link("twitter");
      expect(steps()).toEqual([
        "GET /api/v3/auth_configs",
        "PATCH /api/v3/auth_configs/ac_off",
        "POST /api/v3/connected_accounts/link",
      ]);
      expect(JSON.parse(requests[1]!.body)).toEqual({
        type: "default",
        is_enabled_for_tool_router: true,
      });
      expect(linkedTo()).toBe("ac_off");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const failing = await listed(
        [toolkitOf("twitter", "OAUTH2")],
        [mine("ac_off", { is_enabled_for_tool_router: false })],
        () => json({ message: `no ${KEY}` }, 500),
      );
      expect(await failing.link("twitter")).toBe(
        "https://connect.composio.dev/link/abc",
      );
      expect(linkedTo()).toBe("ac_off");
    });

    it("makes a custom config with no credentials for a toolkit that signs in by dynamic client registration (Cloudflare MCP)", async () => {
      const composio = await listed(
        [toolkitOf("cloudflare_mcp", "DCR_OAUTH")],
        [managedOne],
      );
      expect(await composio.link("cloudflare_mcp")).toBe(
        "https://connect.composio.dev/link/abc",
      );
      expect(steps()).toEqual([
        "GET /api/v3/auth_configs",
        "POST /api/v3/auth_configs",
        "PATCH /api/v3/auth_configs/ac_made",
        "POST /api/v3/connected_accounts/link",
      ]);
      expect(JSON.parse(requests[1]!.body)).toEqual({
        toolkit: { slug: "cloudflare_mcp" },
        auth_config: {
          type: "use_custom_auth",
          authScheme: "DCR_OAUTH",
          name: expect.any(String),
          credentials: {},
        },
      });
      expect(JSON.stringify(requests)).not.toContain("use_composio_managed");
      expect(linkedTo()).toBe("ac_made");
    });

    it("takes a DCR config of its own when there is one, and no other scheme of its own", async () => {
      const composio = await listed(
        [toolkitOf("cloudflare_mcp", "DCR_OAUTH")],
        [
          mine("ac_other", {
            auth_scheme: "OAUTH2",
            is_enabled_for_tool_router: true,
          }),
          mine("ac_dcr", {
            auth_scheme: "DCR_OAUTH",
            is_enabled_for_tool_router: true,
          }),
        ],
      );
      await composio.link("cloudflare_mcp");
      expect(steps()).toEqual([
        "GET /api/v3/auth_configs",
        "POST /api/v3/connected_accounts/link",
      ]);
      expect(linkedTo()).toBe("ac_dcr");
    });

    it("prefers a key to dynamic client registration when it lists both", async () => {
      const composio = await listed(
        [toolkitOf("both", "DCR_OAUTH", "OAUTH2", "API_KEY")],
        [],
      );
      await composio.link("both");
      expect(
        (
          JSON.parse(requests[1]!.body) as {
            auth_config: { authScheme: string };
          }
        ).auth_config.authScheme,
      ).toBe("API_KEY");
    });

    it("leaves a toolkit that has a managed sign-in as it was: a managed config is made when there is none", async () => {
      const composio = await listed([item("gmail")], []);
      expect(await composio.link("gmail")).toBe(
        "https://connect.composio.dev/link/abc",
      );
      expect(steps()).toEqual([
        "GET /api/v3/auth_configs",
        "POST /api/v3/auth_configs",
        "PATCH /api/v3/auth_configs/ac_made",
        "POST /api/v3/connected_accounts/link",
      ]);
      expect(JSON.parse(requests[1]!.body)).toEqual({
        toolkit: { slug: "gmail" },
        auth_config: { type: "use_composio_managed_auth" },
      });
    });

    it("never deletes anything on Composio", async () => {
      const composio = await listed(
        [
          toolkitOf("twitter", "OAUTH2"),
          toolkitOf("railway", "API_KEY"),
          toolkitOf("cloudflare_mcp", "DCR_OAUTH"),
        ],
        [mine("ac_mine", { is_enabled_for_tool_router: true })],
      );
      await composio.link("twitter");
      await composio.link("railway");
      await composio.link("cloudflare_mcp");
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
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

  it("names the method and the path of the call Composio refused, and never the query or the key", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    const failure = () =>
      composio.link("github").then(
        () => "",
        (caught: unknown) => String(caught),
      );
    handler = () => json({ message: `no ${KEY}` }, 404);
    const listing = await failure();
    expect(listing).toContain(
      "Composio answered HTTP 404 (GET /api/v3/auth_configs)",
    );
    expect(listing).not.toContain("toolkit_slug");
    expect(listing).not.toContain("SECRET_0123");
    handler = (request, url) =>
      request.method === "GET" && url.pathname === "/api/v3/auth_configs"
        ? json({ items: [] })
        : json({}, 404);
    expect(await failure()).toContain(
      "Composio answered HTTP 404 (POST /api/v3/auth_configs)",
    );
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

describe("the connected toolkits", () => {
  const account = (slug: string, status: string) => ({
    id: `ca_${slug}_${status}`,
    status,
    user_id: "x",
    toolkit: { slug },
  });
  const page = (items: unknown[], next: string | null = null) =>
    json({
      items,
      next_cursor: next,
      total_pages: 1,
      current_page: 1,
      total_items: items.length,
    });

  it("needs a key: no request, no error", async () => {
    const { composio } = open();
    expect(await composio.connected()).toEqual({
      status: "needs_key",
      slugs: [],
    });
    expect(requests).toHaveLength(0);
  });

  it("returns the slugs of the ACTIVE accounts only, asking for this host's user and nothing else", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    handler = () =>
      page([
        account("github", "ACTIVE"),
        account("gmail", "EXPIRED"),
        account("slack", "INITIATED"),
        account("notion", "ACTIVE"),
        account("github", "ACTIVE"),
        { status: "ACTIVE", toolkit: {} },
        { status: "ACTIVE" },
        "junk",
      ]);
    expect(await composio.connected()).toEqual({
      status: "ready",
      slugs: ["github", "notion"],
    });
    expect(requests).toHaveLength(1);
    const asked = new URL(requests[0]!.path, "http://x");
    expect(requests[0]!.method).toBe("GET");
    expect(asked.pathname).toBe("/api/v3/connected_accounts");
    expect(asked.searchParams.get("statuses")).toBe("ACTIVE");
    expect(asked.searchParams.get("user_ids")).toMatch(/^eta-[0-9a-f-]{36}$/);
    expect(requests[0]!.key).toBe(KEY);
  });

  it("asks for the same user the link was made for", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    handler = (request, url) =>
      url.pathname === "/api/v3/auth_configs"
        ? json({ items: [{ id: "ac_1", is_composio_managed: true }] })
        : url.pathname.endsWith("/link")
          ? json({ redirect_url: "https://connect.composio.dev/link/abc" })
          : request.method === "GET"
            ? page([])
            : json({}, 404);
    await composio.link("github");
    await composio.connected();
    const made = (JSON.parse(requests[1]!.body) as { user_id: string }).user_id;
    const asked = new URL(requests[2]!.path, "http://x");
    expect(asked.searchParams.get("user_ids")).toBe(made);
  });

  it("reads every page by its cursor, and stops on a cursor that does not move", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    handler = (_request, url) => {
      const cursor = url.searchParams.get("cursor");
      if (cursor === null) return page([account("github", "ACTIVE")], "c2");
      if (cursor === "c2") return page([account("gmail", "ACTIVE")], "c3");
      return page([account("slack", "ACTIVE")]);
    };
    expect(await composio.connected()).toEqual({
      status: "ready",
      slugs: ["github", "gmail", "slack"],
    });
    expect(requests).toHaveLength(3);
    requests.length = 0;
    handler = () => page([account("github", "ACTIVE")], "same");
    expect((await composio.connected()).status).toBe("error");
    expect(requests.length).toBeLessThan(5);
  });

  it("says the key was refused on a 401, and says no slug", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    handler = () => json({ error: "no" }, 401);
    expect(await composio.connected()).toEqual({
      status: "key_rejected",
      slugs: [],
    });
  });

  it("answers an error, not a hang, when Composio is silent; the key is not in any answer", async () => {
    const { composio } = open({ timeoutMs: 50 });
    composio.setKey(KEY);
    handler = async () => {
      await new Promise((done) => setTimeout(done, 500));
      return page([account("github", "ACTIVE")]);
    };
    const silent = await composio.connected();
    handler = () => new Response(`failure for key ${KEY}`, { status: 500 });
    const failed = await composio.connected();
    expect(silent).toEqual({ status: "error", slugs: [] });
    expect(failed).toEqual({ status: "error", slugs: [] });
    expect(JSON.stringify({ silent, failed })).not.toContain(KEY);
  });

  it("does not follow a redirect with the key", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    const other = Bun.serve({
      port: 0,
      fetch: (request) => {
        requests.push({
          method: request.method,
          path: "OTHER",
          key: request.headers.get("x-api-key"),
          body: "",
        });
        return page([account("github", "ACTIVE")]);
      },
    });
    try {
      handler = () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${other.port}/x` },
        });
      expect((await composio.connected()).slugs).toEqual([]);
      expect(requests.some((r) => r.path === "OTHER")).toBe(false);
    } finally {
      await other.stop(true);
    }
  });
});

describe("the kept list", () => {
  it("keeps what each toolkit says, not only its slug: after a restart the card has its description, sign-in type and logo", async () => {
    const first = open();
    first.composio.setKey(KEY);
    handler = () =>
      json({
        items: [item("github"), item("hackernews", { no_auth: true })],
        next_cursor: null,
      });
    const fresh = await composioOf(first.market);
    requests.length = 0;
    const again = first.start();
    const kept = await composioOf(again.market, "cached");
    expect(kept.toolkits).toEqual(fresh.toolkits);
    expect(kept.toolkits?.map((one) => one.auth)).toEqual(["oauth", "none"]);
    // The picture is looked up in the kept list too, with no call to Composio.
    expect(again.composio.logoOf("github")).toBe(
      "https://assets.composio.dev/logos/github.png",
    );
    expect(requests).toHaveLength(0);
  });

  it("checks the kept list again: a bad slug is dropped and an address that is not https is not kept", async () => {
    const { db, composio, start } = open();
    composio.setKey(KEY);
    handler = () => json({ items: [item("github")], next_cursor: null });
    await composioOf(open().market);
    const { market } = start();
    await composioOf(market);
    const row = db
      .query<{ body: string }, []>(
        "SELECT body FROM market_catalog_cache WHERE url = 'composio:toolkits'",
      )
      .get();
    const list = JSON.parse(row!.body) as Record<string, unknown>[];
    list[0] = { ...list[0], logo: "http://assets.composio.dev/x.png" };
    list.push({ ...list[0], slug: "bad slug" });
    db.query(
      "UPDATE market_catalog_cache SET body = ? WHERE url = 'composio:toolkits'",
    ).run(JSON.stringify(list));
    const again = start();
    const kept = await composioOf(again.market, "cached");
    expect(kept.toolkits?.map((one) => one.slug)).toEqual(["github"]);
    expect(kept.toolkits?.[0]?.logo).toBeNull();
  });
});

describe("the source without a key", () => {
  const enabledOf = (market: Market) =>
    market.settings().sources.find((one) => one.kind === "composio")!.enabled;
  const listed = async (market: Market) =>
    (await market.catalog("cached")).sources.some(
      (one) => one.source.kind === "composio",
    );

  it("is off while there is no key, and the market does not ask it", async () => {
    const { market, composio } = open();
    expect(composio.source().enabled).toBe(false);
    expect(enabledOf(market)).toBe(false);
    expect(await listed(market)).toBe(false);
    expect(
      (await market.catalog()).sources.map((s) => s.source.kind),
    ).not.toContain("composio");
    expect(requests).toHaveLength(0);
  });

  it("is on once a key is saved, and off again once it is cleared", async () => {
    const { market, composio } = open();
    composio.setKey(KEY);
    expect(enabledOf(market)).toBe(true);
    expect(await listed(market)).toBe(true);
    composio.clearKey();
    expect(enabledOf(market)).toBe(false);
    expect(await listed(market)).toBe(false);
  });

  it("stays off with a key when the user switched it off, and the setting is not written by the missing key", async () => {
    const { market, composio, settings } = open();
    // No key: nothing is written to the setting to make it off.
    expect(enabledOf(market)).toBe(false);
    expect(settings.get("plugins.composioEnabled")).toBeUndefined();
    composio.setKey(KEY);
    expect(settings.get("plugins.composioEnabled")).toBeUndefined();
    market.setSourceEnabled(COMPOSIO_URL, false);
    expect(enabledOf(market)).toBe(false);
    expect(await listed(market)).toBe(false);
    // The manual off is the user's: a new key does not undo it, and clearing the key keeps it.
    composio.setKey(`${KEY}x`);
    expect(enabledOf(market)).toBe(false);
    composio.clearKey();
    expect(settings.get("plugins.composioEnabled")).toBe(false);
    market.setSourceEnabled(COMPOSIO_URL, true);
    expect(enabledOf(market)).toBe(false);
    composio.setKey(KEY);
    expect(enabledOf(market)).toBe(true);
  });
});

describe("disconnecting a toolkit", () => {
  interface Held {
    id: string;
    user: string;
    slug: string;
    status: string;
  }
  /** A fake of Composio that holds accounts, lists them (by user, unless told to ignore it) and deletes them. */
  function hold(accounts: Held[], options: { ignoreUsers?: boolean } = {}) {
    const deleted: string[] = [];
    handler = (request, url) => {
      if (request.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        if (!accounts.some((one) => one.id === id)) return json({}, 404);
        deleted.push(id);
        return json({ success: true });
      }
      const users = url.searchParams.get("user_ids");
      const items = accounts
        .filter(
          (one) =>
            (options.ignoreUsers || users === one.user) &&
            url.searchParams.get("statuses") === one.status,
        )
        .map((one) => ({
          id: one.id,
          status: one.status,
          user_id: one.user,
          toolkit: { slug: one.slug },
        }));
      return json({ items, next_cursor: null });
    };
    return deleted;
  }
  /** The user id the host made: read off the first question it asks. */
  async function userOf(composio: Composio): Promise<string> {
    handler = () => json({ items: [], next_cursor: null });
    await composio.connected();
    const asked = new URL(requests.at(-1)!.path, "http://x");
    requests.length = 0;
    return asked.searchParams.get("user_ids")!;
  }
  const mine = (id: string, user: string, slug = "github"): Held => ({
    id,
    user,
    slug,
    status: "ACTIVE",
  });

  it("needs a key: no request, a status and nothing removed", async () => {
    const { composio } = open();
    expect(await composio.disconnect("github")).toEqual({
      status: "needs_key",
      removed: 0,
    });
    expect(requests).toHaveLength(0);
  });

  it("refuses a name that is not a slug, before any request", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    await expect(composio.disconnect("a/b?c")).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("deletes the accounts of that toolkit under this host's user, and no other account", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    const user = await userOf(composio);
    const deleted = hold([
      mine("ca_one", user),
      mine("ca_two", user),
      mine("ca_mail", user, "gmail"),
      mine("ca_theirs", "someone-else"),
    ]);
    expect(await composio.disconnect("github")).toEqual({
      status: "ready",
      removed: 2,
    });
    expect(deleted.sort()).toEqual(["ca_one", "ca_two"]);
    const asked = requests.filter((one) => one.method === "GET");
    expect(
      new URL(asked[0]!.path, "http://x").searchParams.get("user_ids"),
    ).toBe(user);
    expect(requests.every((one) => one.key === KEY)).toBe(true);
  });

  it("does not touch another user's account even when Composio ignores the user filter", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    const user = await userOf(composio);
    const deleted = hold(
      [mine("ca_mine", user), mine("ca_theirs", "someone-else")],
      { ignoreUsers: true },
    );
    expect(await composio.disconnect("github")).toEqual({
      status: "ready",
      removed: 1,
    });
    expect(deleted).toEqual(["ca_mine"]);
  });

  it("removes nothing, and says so, when the toolkit has no account here", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    const user = await userOf(composio);
    const deleted = hold([mine("ca_mail", user, "gmail")]);
    expect(await composio.disconnect("github")).toEqual({
      status: "ready",
      removed: 0,
    });
    expect(deleted).toEqual([]);
  });

  it("says only a status when Composio fails, never its text or the key", async () => {
    const { composio } = open();
    composio.setKey(KEY);
    const user = await userOf(composio);
    handler = (request) =>
      request.method === "DELETE"
        ? new Response(`boom for key ${KEY}`, { status: 500 })
        : json({
            items: [
              { id: "ca_one", status: "ACTIVE", toolkit: { slug: "github" } },
            ],
            next_cursor: null,
            user,
          });
    const failed = await composio.disconnect("github");
    expect(failed).toEqual({ status: "error", removed: 0 });
    handler = () => json({ error: "no" }, 401);
    const refused = await composio.disconnect("github");
    expect(refused).toEqual({ status: "key_rejected", removed: 0 });
    expect(JSON.stringify({ failed, refused })).not.toContain(KEY);
    expect(
      JSON.stringify(requests.map((one) => [one.path, one.body])),
    ).not.toContain(KEY);
  });
});
