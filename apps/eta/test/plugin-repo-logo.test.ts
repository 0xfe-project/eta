import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
/**
 * A market entry's own logo, read lazily from the plugin's manifest in its GitHub repository.
 * A local fake server stands in for raw.githubusercontent.com; the real Cursor repository is not asked.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logos, MAX_REPO_LOOKUPS } from "../src/plugins/logo";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
const REPO = "https://github.com/cursor/plugins.git";
const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Files by path under /cursor/plugins/main/; `delay` holds each answer, `seen` records every request. */
async function raw(files: Record<string, string | Buffer>, delay = 0) {
  const seen: string[] = [];
  const state: { now: number; peak: number; fail: number | "hang" | null } = {
    now: 0,
    peak: 0,
    fail: null,
  };
  const server = http.createServer((req, res) => {
    seen.push(String(req.url));
    state.now++;
    state.peak = Math.max(state.peak, state.now);
    setTimeout(() => {
      state.now--;
      // No answer at all: the client times out. Cut it loose later so the server can close.
      if (state.fail === "hang")
        return void setTimeout(() => req.socket.destroy(), 1000);
      if (state.fail !== null) return void res.writeHead(state.fail).end();
      const prefix = "/cursor/plugins/main/";
      const file = req.url?.startsWith(prefix)
        ? files[req.url.slice(prefix.length)]
        : undefined;
      if (file === undefined) res.writeHead(404).end();
      else res.end(file);
    }, delay);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clock = { at: 1_000_000 };
  const logos = new Logos({
    allowPrivate: true,
    rawBase: base,
    now: () => clock.at,
    timeoutMs: 300,
  });
  return { base, seen, state, clock, logos };
}

describe("a market entry's own logo from its repository", () => {
  it("reads the manifest's relative logo and serves that file", async () => {
    const { logos, seen } = await raw({
      "third_party/google-drive/.cursor-plugin/plugin.json": JSON.stringify({
        name: "google-drive",
        logo: "assets/logo.svg",
      }),
      "third_party/google-drive/assets/logo.svg": SVG,
    });
    const logo = await logos.fromRepo(REPO, "main", "third_party/google-drive");
    expect(logo?.type).toBe("image/svg+xml");
    expect(Buffer.from(logo!.data, "base64").toString()).toBe(SVG);
    expect(seen).toEqual([
      "/cursor/plugins/main/third_party/google-drive/.cursor-plugin/plugin.json",
      "/cursor/plugins/main/third_party/google-drive/assets/logo.svg",
    ]);
  });

  it("falls back to .claude-plugin/plugin.json, and takes a png", async () => {
    const { logos } = await raw({
      "p/.claude-plugin/plugin.json": JSON.stringify({ logo: "./icon.png" }),
      "p/icon.png": PNG,
    });
    expect((await logos.fromRepo(REPO, "main", "p"))?.type).toBe("image/png");
  });

  it("a manifest without a logo, or no manifest, gives nothing (the card keeps its letter)", async () => {
    const { logos } = await raw({
      "a/.cursor-plugin/plugin.json": JSON.stringify({ name: "a" }),
    });
    expect(await logos.fromRepo(REPO, "main", "a")).toBeNull();
    expect(await logos.fromRepo(REPO, "main", "none")).toBeNull();
  });

  it("refuses an oversize picture, an unsafe SVG, a path that leaves the plugin and a full address", async () => {
    const { logos, seen } = await raw({
      "big/.cursor-plugin/plugin.json": JSON.stringify({ logo: "big.png" }),
      "big/big.png": Buffer.concat([PNG, Buffer.alloc(300 * 1024)]),
      "evil/.cursor-plugin/plugin.json": JSON.stringify({ logo: "x.svg" }),
      "evil/x.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "up/.cursor-plugin/plugin.json": JSON.stringify({
        logo: "../big/big.png",
      }),
      "abs/.cursor-plugin/plugin.json": JSON.stringify({
        logo: "http://127.0.0.1/x.png",
      }),
    });
    for (const path of ["big", "evil", "up", "abs"])
      expect(await logos.fromRepo(REPO, "main", path)).toBeNull();
    expect(
      seen.some((one) => one.includes("..") || one.includes("127.0.0.1")),
    ).toBe(false);
  });

  it("does not call a private address by default", async () => {
    const { base, seen } = await raw({
      "p/.cursor-plugin/plugin.json": JSON.stringify({ logo: "l.png" }),
      "p/l.png": PNG,
    });
    expect(
      await new Logos({ rawBase: base }).fromRepo(REPO, "main", "p"),
    ).toBeNull();
    expect(seen).toEqual([]);
  });

  it("asks nothing for a repository that is not on github.com", async () => {
    const { logos, seen } = await raw({});
    for (const repo of [
      "https://gitlab.com/a/b.git",
      "ssh://git@github.com/a/b.git",
      "http://github.com/a/b",
    ])
      expect(await logos.fromRepo(repo, "main", "p")).toBeNull();
    expect(await logos.fromRepo(REPO, "../x", "p")).toBeNull();
    expect(seen).toEqual([]);
  });

  it("keeps an answer: the same entry is not asked twice, a miss too", async () => {
    const { logos, seen } = await raw({
      "p/.cursor-plugin/plugin.json": JSON.stringify({ logo: "l.png" }),
      "p/l.png": PNG,
    });
    await logos.fromRepo(REPO, "main", "p");
    await logos.fromRepo(REPO, "main", "p");
    expect(seen.length).toBe(2);
    await logos.fromRepo(REPO, "main", "q");
    const after = seen.length;
    await logos.fromRepo(REPO, "main", "q");
    expect(seen.length).toBe(after);
  });

  it("runs at most four lookups at once, and all of them finish", async () => {
    const files: Record<string, string | Buffer> = {};
    for (let i = 0; i < 12; i++) {
      files[`p${i}/.cursor-plugin/plugin.json`] = JSON.stringify({
        logo: "l.png",
      });
      files[`p${i}/l.png`] = PNG;
    }
    const { logos, state } = await raw(files, 30);
    const all = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        logos.fromRepo(REPO, "main", `p${i}`),
      ),
    );
    expect(all.every((one) => one?.type === "image/png")).toBe(true);
    expect(MAX_REPO_LOOKUPS).toBe(4);
    expect(logos.peak).toBe(4);
    expect(state.peak).toBeLessThanOrEqual(4);
  });

  describe("a failed lookup is not an answer", () => {
    const files = {
      "p/.cursor-plugin/plugin.json": JSON.stringify({ logo: "l.png" }),
      "p/l.png": PNG,
    };

    it('a 5xx or no answer at all is not kept as "no picture": the next try after a short wait finds it', async () => {
      for (const fail of [500, 503, "hang"] as const) {
        const { logos, state, clock } = await raw(files);
        state.fail = fail;
        expect(await logos.fromRepo(REPO, "main", "p")).toBeNull();
        state.fail = null;
        // Inside the short backoff nothing is asked, so the failure is not hammered...
        clock.at += 30_000;
        expect(await logos.fromRepo(REPO, "main", "p")).toBeNull();
        // ...and after it, long before a kept miss (an hour) would end, the picture is found.
        let found = null as Awaited<ReturnType<typeof logos.fromRepo>>;
        for (let tries = 0; tries < 3 && !found; tries++) {
          clock.at += 2 * 60 * 1000 + 1000;
          found = await logos.fromRepo(REPO, "main", "p");
        }
        expect(found?.type, String(fail)).toBe("image/png");
      }
    });

    it("a 404 is an answer and is kept for an hour; a 429 or 408 is not", async () => {
      const { logos, state, clock, seen } = await raw(files);
      expect(await logos.fromRepo(REPO, "main", "none")).toBeNull();
      const asked = seen.length;
      clock.at += 10 * 60 * 1000;
      expect(await logos.fromRepo(REPO, "main", "none")).toBeNull();
      expect(seen.length).toBe(asked);
      state.fail = 429;
      expect(await logos.fromRepo(REPO, "main", "p")).toBeNull();
      state.fail = null;
      clock.at += 3 * 60 * 1000;
      expect((await logos.fromRepo(REPO, "main", "p"))?.type).toBe("image/png");
    });

    it("a failure does not overwrite an earlier hit, even once it is stale", async () => {
      const { logos, state, clock } = await raw(files);
      const first = await logos.fromRepo(REPO, "main", "p");
      expect(first?.type).toBe("image/png");
      clock.at += 25 * 60 * 60 * 1000;
      state.fail = 500;
      expect((await logos.fromRepo(REPO, "main", "p"))?.data).toBe(first!.data);
      state.fail = null;
      clock.at += 3 * 60 * 1000;
      expect((await logos.fromRepo(REPO, "main", "p"))?.data).toBe(first!.data);
    });
  });
});
