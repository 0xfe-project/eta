/**
 * The desktop app is released from the same repository under `desktop-v*` tags. A host takes only
 * `v*` ones, whatever GitHub calls the latest release.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isHostTag, newestHost, nextPage, Releases } from "../src/releases";

interface Listed {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
  html_url?: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

/**
 * The API with `releases`, newest first, and `latest` as GitHub has it. The list comes in pages
 * of `per_page`, with a `Link` to the next as GitHub sends it, unless `paged` is false: then it is
 * a server that sends everything at once, whatever it is asked.
 */
function fakeApi(releases: Listed[], latest?: string, paged = true) {
  const asked: string[] = [];
  const answer = (release: Listed) => Response.json({ ...release, assets: [] });
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const { pathname, search } = new URL(request.url);
      asked.push(pathname + search);
      if (pathname === "/repo/releases/latest") {
        const found = releases.find((release) => release.tag_name === latest);
        return found === undefined
          ? new Response("not found", { status: 404 })
          : answer(found);
      }
      if (pathname === "/repo/releases") {
        const all = releases.map((release) => ({ ...release, assets: [] }));
        if (!paged) return Response.json(all);
        const query = new URL(request.url).searchParams;
        const size = Number(query.get("per_page") ?? 30);
        const page = Number(query.get("page") ?? 1);
        const next = new URL(request.url);
        next.searchParams.set("page", String(page + 1));
        return Response.json(all.slice((page - 1) * size, page * size), {
          headers:
            page * size < all.length
              ? {
                  link: `<${next.href}>; rel="next", <${next.href}>; rel="last"`,
                }
              : {},
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return {
    asked,
    releases: new Releases({
      upstream: `http://127.0.0.1:${server.port}/repo`,
      token: () => Promise.resolve({}),
    }),
  };
}

describe("host tags", () => {
  it("are v and a version", () => {
    expect(isHostTag("v0.2.0")).toBe(true);
    expect(isHostTag("v0.2.0-rc.1")).toBe(true);
    expect(isHostTag("desktop-v0.2.0")).toBe(false);
    expect(isHostTag("v0.2")).toBe(false);
    expect(isHostTag("vnext")).toBe(false);
  });

  it("pick the highest published one that is not a pre-release", () => {
    expect(
      newestHost([
        { tag_name: "desktop-v9.0.0", assets: [] },
        { tag_name: "v0.10.0", draft: true, assets: [] },
        { tag_name: "v0.9.0-rc.1", assets: [] },
        { tag_name: "v0.3.0", prerelease: true, assets: [] },
        { tag_name: "v0.2.10", assets: [] },
        { tag_name: "v0.2.9", assets: [] },
      ])?.tag_name,
    ).toBe("v0.2.10");
    expect(newestHost([{ tag_name: "desktop-v1.0.0", assets: [] }])).toBe(
      undefined,
    );
  });
});

describe("the latest release", () => {
  it("is GitHub's latest when that is a host", async () => {
    const api = fakeApi(
      [{ tag_name: "desktop-v0.2.0" }, { tag_name: "v0.3.0" }],
      "v0.3.0",
    );
    await expect(api.releases.latest()).resolves.toMatchObject({
      version: "0.3.0",
    });
    expect(api.asked).toEqual(["/repo/releases/latest"]);
  });

  it("carries what it says about itself, and where to read it in full", async () => {
    const page = "https://github.com/o/r/releases/tag/v0.3.0";
    const api = fakeApi(
      [{ tag_name: "v0.3.0", body: "\n- Tasks as a board\n", html_url: page }],
      "v0.3.0",
    );
    await expect(api.releases.latest()).resolves.toEqual({
      version: "0.3.0",
      assets: [],
      notes: "- Tasks as a board",
      page,
    });
    // A release with nothing to say has no notes, not empty ones.
    const quiet = fakeApi([{ tag_name: "v0.3.0", body: null }], "v0.3.0");
    expect(await quiet.releases.latest()).toEqual({
      version: "0.3.0",
      assets: [],
    });
  });

  it("is not a desktop release that took GitHub's latest", async () => {
    const api = fakeApi(
      [
        { tag_name: "desktop-v0.2.0" },
        { tag_name: "v0.4.0-rc.1", prerelease: true },
        { tag_name: "v0.3.0" },
        { tag_name: "v0.2.0" },
      ],
      "desktop-v0.2.0",
    );
    await expect(api.releases.latest()).resolves.toMatchObject({
      version: "0.3.0",
    });
    expect(api.asked).toEqual([
      "/repo/releases/latest",
      "/repo/releases?per_page=100",
    ]);
  });

  it("is looked for in the list when GitHub has none", async () => {
    const api = fakeApi([{ tag_name: "v0.1.0" }]);
    await expect(api.releases.latest()).resolves.toMatchObject({
      version: "0.1.0",
    });
  });

  it("does not exist where only the desktop app is released", async () => {
    const api = fakeApi([{ tag_name: "desktop-v0.1.0" }], "desktop-v0.1.0");
    await expect(api.releases.latest()).rejects.toThrow(
      "has no host release (a v* tag)",
    );
  });
});

describe("the full-release channel", () => {
  it("does not take GitHub's latest when its tag has a -", async () => {
    // Someone unmarked a pre-release by hand: GitHub calls it the latest, and it is not.
    const api = fakeApi(
      [
        { tag_name: "v0.4.0-rc.1" },
        { tag_name: "desktop-v0.3.0" },
        { tag_name: "v0.3.0" },
      ],
      "v0.4.0-rc.1",
    );
    await expect(api.releases.latest()).resolves.toMatchObject({
      version: "0.3.0",
    });
    expect(api.asked).toEqual([
      "/repo/releases/latest",
      "/repo/releases?per_page=100",
    ]);
  });

  it("does not take GitHub's latest when it is marked a pre-release", async () => {
    const api = fakeApi(
      [{ tag_name: "v0.4.0", prerelease: true }, { tag_name: "v0.3.0" }],
      "v0.4.0",
    );
    await expect(api.releases.latest()).resolves.toMatchObject({
      version: "0.3.0",
    });
  });

  it("ignores pre-releases, drafts and the desktop app's releases", async () => {
    const api = fakeApi([
      { tag_name: "desktop-v9.0.0" },
      { tag_name: "v0.5.0", draft: true },
      { tag_name: "v0.4.0-beta.2", prerelease: true },
      { tag_name: "v0.3.1" },
      { tag_name: "v0.3.0" },
    ]);
    await expect(
      api.releases.latest({ prerelease: false }),
    ).resolves.toMatchObject({
      version: "0.3.1",
    });
  });
});

describe("the pre-release channel", () => {
  const mixed = [
    { tag_name: "desktop-v9.0.0" },
    { tag_name: "desktop-v9.1.0-rc.1", prerelease: true },
    { tag_name: "v0.5.0", draft: true },
    { tag_name: "v0.5.0-rc.1", draft: true, prerelease: true },
    { tag_name: "v0.4.0-beta.2", prerelease: true },
    { tag_name: "v0.4.0-beta.10", prerelease: true },
    { tag_name: "v0.3.1" },
    { tag_name: "v0.3.0" },
  ];

  it("takes the highest published v*, pre-release or not, from the list", async () => {
    const api = fakeApi(mixed, "v0.3.1");
    await expect(
      api.releases.latest({ prerelease: true }),
    ).resolves.toMatchObject({ version: "0.4.0-beta.10" });
    // GitHub's latest is never a pre-release: the list is the only place to look.
    expect(api.asked).toEqual(["/repo/releases?per_page=100"]);
  });

  it("goes to the full release once it is out, above its own candidates", async () => {
    const api = fakeApi(
      [
        { tag_name: "v0.4.0" },
        { tag_name: "desktop-v1.0.0" },
        ...mixed,
        { tag_name: "v0.4.0-rc.1", prerelease: true },
      ],
      "v0.4.0",
    );
    await expect(
      api.releases.latest({ prerelease: true }),
    ).resolves.toMatchObject({ version: "0.4.0" });
  });

  it("takes a full release that is the highest", async () => {
    const api = fakeApi([
      { tag_name: "v0.3.0-rc.2", prerelease: true },
      { tag_name: "v0.3.1" },
    ]);
    await expect(
      api.releases.latest({ prerelease: true }),
    ).resolves.toMatchObject({ version: "0.3.1" });
  });

  it("does not exist where there are only drafts and desktop releases", async () => {
    const api = fakeApi([
      { tag_name: "desktop-v0.1.0" },
      { tag_name: "v0.2.0-rc.1", draft: true, prerelease: true },
    ]);
    await expect(api.releases.latest({ prerelease: true })).rejects.toThrow(
      "has no host release (a v* tag)",
    );
  });

  it("is picked by newestHost too", () => {
    const listed = mixed.map((release) => ({ ...release, assets: [] }));
    expect(newestHost(listed, { prerelease: true })?.tag_name).toBe(
      "v0.4.0-beta.10",
    );
    expect(newestHost(listed)?.tag_name).toBe("v0.3.1");
  });
});

describe("a list longer than a page", () => {
  /** `count` desktop releases, newest first: more of them than a page holds. */
  const desktop = (count: number, prerelease = false): Listed[] =>
    Array.from({ length: count }, (_, index) => ({
      tag_name: `desktop-v0.${String(count - index)}.0`,
      prerelease,
    }));

  it("finds the host release behind a page of desktop releases", async () => {
    const api = fakeApi(
      [
        ...desktop(150),
        { tag_name: "v0.4.0-rc.1", prerelease: true },
        { tag_name: "v0.3.0" },
        { tag_name: "v0.2.0" },
      ],
      "desktop-v0.150.0",
    );
    await expect(api.releases.latest()).resolves.toMatchObject({
      version: "0.3.0",
    });
    expect(api.asked).toEqual([
      "/repo/releases/latest",
      "/repo/releases?per_page=100",
      "/repo/releases?per_page=100&page=2",
    ]);
  });

  it("does so on the pre-release channel too", async () => {
    const api = fakeApi([
      ...desktop(120, true),
      { tag_name: "v0.4.0-rc.1", prerelease: true },
      { tag_name: "v0.3.0" },
    ]);
    await expect(
      api.releases.latest({ prerelease: true }),
    ).resolves.toMatchObject({ version: "0.4.0-rc.1" });
  });

  it("gives the app its host candidates from behind them", async () => {
    const api = fakeApi([
      ...desktop(230),
      { tag_name: "v0.3.0" },
      { tag_name: "v0.2.0" },
    ]);
    expect((await api.releases.hosts()).map(({ version }) => version)).toEqual([
      "0.3.0",
      "0.2.0",
    ]);
    expect(api.asked.at(-1)).toBe("/repo/releases?per_page=100&page=3");
  });

  it("stops at the first page that has a host release", async () => {
    const api = fakeApi([
      { tag_name: "v0.3.0" },
      ...desktop(150),
      { tag_name: "v0.2.0" },
    ]);
    await expect(api.releases.latest()).resolves.toMatchObject({
      version: "0.3.0",
    });
    expect(api.asked).toEqual([
      "/repo/releases/latest",
      "/repo/releases?per_page=100",
    ]);
  });

  it("says there is none once the list ends", async () => {
    const api = fakeApi(desktop(250));
    await expect(api.releases.latest()).rejects.toThrow(
      "has no host release (a v* tag)",
    );
    expect(api.asked).toHaveLength(4);
  });

  it("is read once from a server that does not page", async () => {
    const api = fakeApi(
      [...desktop(150), { tag_name: "v0.3.0" }],
      undefined,
      false,
    );
    await expect(api.releases.latest()).resolves.toMatchObject({
      version: "0.3.0",
    });
    expect(api.asked).toEqual([
      "/repo/releases/latest",
      "/repo/releases?per_page=100",
    ]);
  });
});

describe("the next page", () => {
  it("is the address GitHub's Link header names next", () => {
    const base = "https://api.github.com/repos/o/r/releases?per_page=100";
    expect(
      nextPage(
        '<https://api.github.com/repositories/1/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/releases?per_page=100&page=5>; rel="last"',
        base,
      ),
    ).toBe(
      "https://api.github.com/repositories/1/releases?per_page=100&page=2",
    );
    expect(
      nextPage(
        '<https://api.github.com/repositories/1/releases?page=1>; rel="prev"',
        base,
      ),
    ).toBe(undefined);
    expect(nextPage(null, base)).toBe(undefined);
  });
});
