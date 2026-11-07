/**
 * The desktop app is released from the same repository under `desktop-v*` tags. A host takes only
 * `v*` ones, whatever GitHub calls the latest release.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isHostTag, newestHost, Releases } from "../src/upgrade/releases";

interface Listed {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

/** The API with `releases`, newest first, and `latest` as GitHub has it. */
function fakeApi(releases: Listed[], latest?: string) {
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
      if (pathname === "/repo/releases")
        return Response.json(
          releases.map((release) => ({ ...release, assets: [] })),
        );
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
