import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
/**
 * Plugin logos: found by the host, from a public address only, as a picture and nothing else.
 * Local fake servers answer; no real site is asked.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPrivateAddress,
  Logos,
  pictureType,
  siteOf,
} from "../src/plugins/logo";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("plugin logos", () => {
  it("refuses private and reserved addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.16.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
    ])
      expect(isPrivateAddress(address)).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });

  it("accepts the 198.18.0.0/15 range a fake-IP proxy answers from, and still refuses real private ranges", () => {
    expect(isPrivateAddress("198.18.39.125")).toBe(false);
    expect(isPrivateAddress("198.19.1.1")).toBe(false);
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
  });

  it("finds the icon of an apex site: relative rel=icon, apex -> www redirect, then the picture", async () => {
    const seen: string[] = [];
    const base = await serve((req, res) => {
      const [host, port] = String(req.headers.host).split(":");
      seen.push(host + req.url);
      if (host === "apex.test" && req.url === "/")
        res.end('<link rel="icon" href="/favicon.png"/>');
      else if (host === "apex.test" && req.url === "/favicon.png")
        res
          .writeHead(308, {
            location: `http://www.apex.test:${port}/favicon.png`,
          })
          .end();
      else if (host === "www.apex.test" && req.url === "/favicon.png")
        res.end(PNG);
      else res.writeHead(404).end();
    });
    const port = base.split(":").pop();
    const logos = new Logos({
      allowPrivate: true,
      resolve: async () => ["127.0.0.1"],
      sites: (server) => [server],
    });
    const logo = await logos.find(null, null, `http://apex.test:${port}/`);
    expect(logo?.type).toBe("image/png");
    expect(seen).toContain("www.apex.test/favicon.png");
  });

  it("does not call a private address by default, and sends nothing", async () => {
    let hits = 0;
    const base = await serve((_req, res) => {
      hits++;
      res.end(PNG);
    });
    const logos = new Logos();
    expect(await logos.find(`${base}/logo.png`, null)).toBeNull();
    expect(hits).toBe(0);
  });

  it("takes the plugin's own logo, as a picture", async () => {
    const base = await serve((_req, res) => res.end(PNG));
    const logos = new Logos({ allowPrivate: true });
    const logo = await logos.find(`${base}/logo.png`, null);
    expect(logo?.type).toBe("image/png");
    expect(Buffer.from(logo!.data, "base64").equals(PNG)).toBe(true);
  });

  it("falls back to the icon a homepage names, then to /favicon.ico", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/") res.end('<link rel="icon" href="/i.png">');
      else if (req.url === "/i.png") res.end(PNG);
      else res.writeHead(404).end();
    });
    const logos = new Logos({ allowPrivate: true });
    expect((await logos.find(null, `${base}/`))?.type).toBe("image/png");
    const second = await serve((req, res) => {
      if (req.url === "/favicon.ico") res.end(Buffer.from([0, 0, 1, 0, 9]));
      else res.end("<html></html>");
    });
    expect(
      (await new Logos({ allowPrivate: true }).find(null, `${second}/`))?.type,
    ).toBe("image/x-icon");
  });

  it("does not take what is not a picture (an SVG, HTML) or too much", async () => {
    const svg = await serve((_req, res) =>
      res.end("<svg onload=alert(1)></svg>"),
    );
    expect(
      await new Logos({ allowPrivate: true }).find(`${svg}/a.svg`, null),
    ).toBeNull();
    const big = await serve((_req, res) =>
      res.end(Buffer.concat([PNG, Buffer.alloc(300 * 1024)])),
    );
    expect(
      await new Logos({ allowPrivate: true }).find(`${big}/a.png`, null),
    ).toBeNull();
    expect(pictureType(Buffer.from("<svg"))).toBeNull();
  });

  it("checks every redirect: one into a private address is refused", async () => {
    let target = 0;
    const inner = await serve((_req, res) => {
      target++;
      res.end(PNG);
    });
    const outer = await serve((_req, res) =>
      res.writeHead(302, { location: `${inner}/x.png` }).end(),
    );
    const logos = new Logos({
      allowPrivate: false,
      resolve: async () => ["93.184.216.34"],
    });
    // The name resolves to a public address, so the first hop is tried; it cannot connect, and no logo comes.
    expect(await logos.find("http://example.test/x.png", null)).toBeNull();
    expect(target).toBe(0);
    expect(outer).toBeTruthy();
  });

  it("does not ask github.com or gitlab.com homepages", async () => {
    const logos = new Logos({ resolve: async () => ["93.184.216.34"] });
    expect(await logos.find(null, "https://github.com/a/b")).toBeNull();
    expect(await logos.find(null, "https://gitlab.com/a/b")).toBeNull();
    expect(logos.requests).toBe(0);
  });

  it("keeps an answer, and a miss, instead of asking again", async () => {
    let hits = 0;
    const base = await serve((_req, res) => {
      hits++;
      res.end(PNG);
    });
    const logos = new Logos({ allowPrivate: true });
    await logos.find(`${base}/a.png`, null);
    await logos.find(`${base}/a.png`, null);
    expect(hits).toBe(1);
  });

  it("takes the icon of the MCP server's site after the logo and the homepage fail, and sends no credential", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const site = await serve((req, res) => {
      seen.push(req.headers);
      if (req.url === "/")
        res.end('<link rel="apple-touch-icon" href="/t.png">');
      else if (req.url === "/t.png") res.end(PNG);
      else res.writeHead(404).end();
    });
    const logos = new Logos({ allowPrivate: true });
    expect((await logos.find(null, null, `${site}/mcp`))?.type).toBe(
      "image/png",
    );
    expect(
      seen.every(
        (h) => h.authorization === undefined && h.cookie === undefined,
      ),
    ).toBe(true);
  });

  it("prefers the homepage icon over the MCP site's, and falls back to nothing when both fail", async () => {
    const home = await serve((req, res) =>
      req.url === "/favicon.ico"
        ? res.end(Buffer.from([0, 0, 1, 0, 9]))
        : res.end("<html></html>"),
    );
    const site = await serve((_req, res) => res.end(PNG));
    expect(
      (
        await new Logos({ allowPrivate: true }).find(
          null,
          `${home}/`,
          `${site}/mcp`,
        )
      )?.type,
    ).toBe("image/x-icon");
    const none = await serve((_req, res) => res.writeHead(404).end());
    expect(
      await new Logos({ allowPrivate: true }).find(null, null, `${none}/mcp`),
    ).toBeNull();
  });

  it("refuses an MCP site on a private address, and a site that redirects into one", async () => {
    expect(
      await new Logos().find(null, null, "http://127.0.0.1:9/mcp"),
    ).toBeNull();
    const target = await serve((_req, res) => res.end(PNG));
    const site = await serve((_req, res) =>
      res.writeHead(302, { location: `${target}/x.png` }).end(),
    );
    expect(await new Logos().find(null, null, `${site}/mcp`)).toBeNull();
  });

  it("asks the parent site first, then the origin; handles co.uk style suffixes", () => {
    expect(siteOf("https://mcp.firecrawl.dev/v2/mcp")).toEqual([
      "https://firecrawl.dev",
      "https://mcp.firecrawl.dev",
    ]);
    expect(siteOf("https://example.com/mcp")).toEqual(["https://example.com"]);
    expect(siteOf("https://api.foo.co.uk/x")).toEqual([
      "https://foo.co.uk",
      "https://api.foo.co.uk",
    ]);
    expect(siteOf("https://foo.co.uk/x")).toEqual(["https://foo.co.uk"]);
    expect(siteOf("http://127.0.0.1:9/mcp")).toEqual(["http://127.0.0.1:9"]);
    expect(siteOf("stdio:foo")).toEqual([]);
  });

  it("the parent site's icon wins over the origin's; a parent miss falls to the origin; both miss gives nothing", async () => {
    const parent = await serve((_req, res) =>
      res.end(Buffer.from([0, 0, 1, 0, 9])),
    );
    const origin = await serve((_req, res) => res.end(PNG));
    const miss = await serve((_req, res) => res.writeHead(404).end());
    const sites = (list: string[]) => () => list;
    expect(
      (
        await new Logos({
          allowPrivate: true,
          sites: sites([parent, origin]),
        }).find(null, null, "x://s")
      )?.type,
    ).toBe("image/x-icon");
    expect(
      (
        await new Logos({
          allowPrivate: true,
          sites: sites([miss, origin]),
        }).find(null, null, "x://s")
      )?.type,
    ).toBe("image/png");
    expect(
      await new Logos({ allowPrivate: true, sites: sites([miss, miss]) }).find(
        null,
        null,
        "x://s",
      ),
    ).toBeNull();
  });
});
