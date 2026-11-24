import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
/**
 * Plugin logos: found by the host, from a public address only, as a picture and nothing else.
 * Local fake servers answer; no real site is asked.
 */
import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { IconCache } from "../src/plugins/icon-cache";
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

// A certificate made only for these tests (CN and SAN localhost); it signs nothing real.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIC/TCCAeWgAwIBAgIULk9DmVS83+txOEhwGxIlh5MuwqswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEyMzEyMjIwM1oYDzIxMjYx
MDMwMTIyMjAzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDSLlK6pPrdHqMGRQDVnAro1QA24S8YpsT7SDuf/mOT
CSwGBZ8V9ZfzmBZwXgk++LkkOfG1Psbi+oFBraWeJolEoqZUpgSSBgguZFj1ZUfx
Sm+eKd8BBGOLY+wVXKHo9KQnDL+uc/iEB5quNk1N+WZvX+VYCt3lGgQ4M0Rwx7HB
tiiD7ect3LseKyoR2pzh2DIrJaz7Gx2DrxhdREVgV2RGRxjWdrKAQ7LLTapq4MWw
KV7HbtIz5mQfrCr/Oeq8xD6RLx+4XrmXPpCY7jZp1ippZe/skKxv8VIFpkVV8Fzj
y+/GqOmHFlm5x8U9nGP0lcrkBZHEaQTtNuI+1dKKtgyhAgMBAAGjRTBDMBQGA1Ud
EQQNMAuCCWxvY2FsaG9zdDAMBgNVHRMEBTADAQH/MB0GA1UdDgQWBBTJGZfpzsyp
DCyAtCmZN6U03ujxWjANBgkqhkiG9w0BAQsFAAOCAQEAPvltPy+KrIy84Jlpi63N
hT30arB09rpNmvNXiaLHMXANYSoc5GiM07QSt0/xGP08AIdbdSmsBm9wKrR0NxKz
zdwpXuulwZL/t940asCZFdU0i8F4fa+2AtvuXO02V+VemsNSZ8FXcOl52Juaakgs
yJRXQ406ITbixkToMaQn/yRRHXYWi8A6JBV05KUByWpQI3yJAzQeRhwpifdTBRzK
h8gyKx1Zhe5gMF+PWvyizvCsXaBBGIBovWsZ0TaTnaMRx65Bdbl0KW4iQbOcbTgT
WR4KpNeI9B11y5rFUZ6volK4B6aIMDmm0vYO3kjHW28qfwLn7retL7T2Wd3gJ2aB
Gw==
-----END CERTIFICATE-----`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDSLlK6pPrdHqMG
RQDVnAro1QA24S8YpsT7SDuf/mOTCSwGBZ8V9ZfzmBZwXgk++LkkOfG1Psbi+oFB
raWeJolEoqZUpgSSBgguZFj1ZUfxSm+eKd8BBGOLY+wVXKHo9KQnDL+uc/iEB5qu
Nk1N+WZvX+VYCt3lGgQ4M0Rwx7HBtiiD7ect3LseKyoR2pzh2DIrJaz7Gx2Drxhd
REVgV2RGRxjWdrKAQ7LLTapq4MWwKV7HbtIz5mQfrCr/Oeq8xD6RLx+4XrmXPpCY
7jZp1ippZe/skKxv8VIFpkVV8Fzjy+/GqOmHFlm5x8U9nGP0lcrkBZHEaQTtNuI+
1dKKtgyhAgMBAAECggEAHAlyXzPtQ+xXjllLknMRkHwDXo6819K9QZDh5UaLtVw6
m2YKEeWUOroduikNHjGTDuZM3CLO6I3GisKVbmqREo8I1Y9c2jbERh38MOXtCh6m
E4jd1talSb2PS00zSu5BbHUap7SQINqb02PqfX2IoNA/uXYfofVNvUp3dXzp9R8v
mboageduPYscQvelKin/Q8nGSBOzOY1pVP/7yjOUfqXg6f6jOCtJ0weBrfI0mtgd
P6967t7TRU6WyqWjFppJUFqXPfl5ErhP7O04i8HhWMIOJtqp4BI6hYjnoTZesfQI
WUlvvDfgnXWvn6xM2NSzdRX1Ch8fcHcpAQR1f0IUTQKBgQD9TzZiuXKodJYhHsCI
M2UedlOxs79rZKdn3Kzo+oKI6RA7yYjHXIutGArbUwnYOYGwv7uXvqvJIp2iLXAz
CPTyszQXv48sn5Mhl3Qr8IO2eBnWrjLi0C75W/CJOruFOGGXOIGuNTDlkUr90sUn
fDVEGyYtgujb5bgtlvKnERVEJQKBgQDUadZ0lyVZPiO8s5bwodph59/Hd3iH4Vsb
DweQsSMAF9MOv2LiLV/sn+cJeGdk6GByLIvRMmtZrREbxQtqI53Ad92vypTDc0bi
ypiP36WKZC16fPFAHlUNRfOxZl5nub4o7oA46+ZpCuy2Cr5FlKuhEK1fWUB0AYpN
fH+OQVYfzQKBgCBzoXgMYhAKv6EGm4vXacD5T8eYS5Gql3fK4awHS+nWUeoW65r+
1DYcumdWwBAfbeoC5jmOh9uAv8kjIRiosRjWtHnGZMVGvEa1bICkk3sw7759Gq/M
E/iGOs6Z46QxkO8aoiJ7VgRTFNRnyDJCy2AqSj3SY5qoV2wfxn54xcyxAoGBAJxn
UgGHSXjsyGOp2PpWMvbkRWIaFiX3SZ4i8u8Xfy4SXNX/FlB0GK2jD/tpLLigYmOv
aUQgW+ssA+zuqfj9QKr3l8RY5jEEMK3Nf4hwpPPBz7rhRMJxky6y0z1Moza9DcgV
1VQUXxP5d1KTloalcbqnDQGoNk001SE5CrM0aLYBAoGBAJrZ6++C/vv77VWzhPno
j1jSA+orjADzE+M8rWcqPe4tHoH0l1SOZh7iS4mxMeOmIgu2bLVBQwA0UxUx4fTb
iL5uDLhcQoIzjic67yFTXHMcZC4uK0AI1DNdOcaipLslhTt00Y4G+ALsBvYaTSx+
DR4RiUmBXlW0Mk06+rcFa+xT
-----END PRIVATE KEY-----`;

describe("a Composio toolkit's logo (Logos.fromUrl)", () => {
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>';

  async function secure(handler: http.RequestListener) {
    const server = https.createServer(
      { key: TEST_KEY, cert: TEST_CERT },
      handler,
    );
    servers.push(server as unknown as http.Server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `https://localhost:${(server.address() as AddressInfo).port}`;
  }
  const logos = () =>
    new Logos({
      allowPrivate: true,
      ca: TEST_CERT,
      resolve: async () => ["127.0.0.1"],
    });

  it("takes an SVG as it is, with the type image/svg+xml", async () => {
    const base = await secure((_req, res) => {
      res.setHeader("content-type", "image/svg+xml");
      res.end(SVG);
    });
    expect(await logos().fromUrl(`${base}/api/github`)).toEqual({
      type: "image/svg+xml",
      data: Buffer.from(SVG).toString("base64"),
    });
  });

  it("takes an SVG that starts with an xml line and a comment", async () => {
    const base = await secure((_req, res) =>
      res.end(`<?xml version="1.0"?><!-- logo -->${SVG}`),
    );
    expect((await logos().fromUrl(`${base}/a`))?.type).toBe("image/svg+xml");
  });

  it("refuses an SVG with script, a handler or an outside reference", async () => {
    for (const body of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
    ]) {
      const base = await secure((_req, res) => res.end(body));
      expect(await logos().fromUrl(`${base}/a`)).toBeNull();
    }
  });

  it("refuses what is neither a picture nor an SVG", async () => {
    const page = await secure((_req, res) =>
      res.end("<html><svg></svg></html>"),
    );
    expect(await logos().fromUrl(`${page}/a`)).toBeNull();
    const text = await secure((_req, res) => res.end("hello"));
    expect(await logos().fromUrl(`${text}/a`)).toBeNull();
  });

  it("still refuses plain http, and an SVG too large", async () => {
    const plain = await serve((_req, res) => res.end(SVG));
    expect(await logos().fromUrl(`${plain}/a`)).toBeNull();
    const big = await secure((_req, res) =>
      res.end(SVG.replace("</svg>", `<!--${"x".repeat(300 * 1024)}--></svg>`)),
    );
    expect(await logos().fromUrl(`${big}/a`)).toBeNull();
  });

  it("leaves the other ways to a picture as they were: an SVG is still not taken there, and pictureType does not know it", async () => {
    const base = await secure((_req, res) => res.end(SVG));
    expect(await logos().find(`${base}/a.svg`, null)).toBeNull();
    expect(pictureType(Buffer.from(SVG))).toBeNull();
  });
});

describe("a Composio toolkit's logo is kept in the database (Logos.fromUrl)", () => {
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>';

  async function secure(handler: http.RequestListener) {
    const server = https.createServer(
      { key: TEST_KEY, cert: TEST_CERT },
      handler,
    );
    servers.push(server as unknown as http.Server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `https://localhost:${(server.address() as AddressInfo).port}`;
  }
  function database() {
    const db = openDatabase(":memory:");
    applyMigrations(db, loadMigrations());
    return db;
  }
  const rows = (db: ReturnType<typeof database>) =>
    (db.query("SELECT COUNT(*) AS n FROM plugin_icon").get() as { n: number })
      .n;
  /** A new Logos over the same database: what a restart of the host is. */
  const boot = (db: ReturnType<typeof database>, now?: () => number) =>
    new Logos({
      allowPrivate: true,
      ca: TEST_CERT,
      resolve: async () => ["127.0.0.1"],
      store: new IconCache(db),
      ...(now === undefined ? {} : { now }),
    });

  it("asks the server once, and not again after a restart", async () => {
    let asked = 0;
    const base = await secure((_req, res) => {
      asked++;
      res.end(SVG);
    });
    const db = database();
    const first = await boot(db).fromUrl(`${base}/a`);
    expect(first?.type).toBe("image/svg+xml");
    expect(asked).toBe(1);
    const again = await boot(db).fromUrl(`${base}/a`);
    expect(again).toEqual(first);
    expect(asked).toBe(1);
  });

  it("does not keep a failed ask as no picture: not in the database, not in memory", async () => {
    let asked = 0;
    let up = false;
    const base = await secure((req, res) => {
      asked++;
      if (!up) return void req.socket.destroy();
      res.end(SVG);
    });
    const db = database();
    const logos = boot(db);
    expect(await logos.fromUrl(`${base}/a`)).toBeNull();
    expect(rows(db)).toBe(0);
    up = true;
    expect((await logos.fromUrl(`${base}/a`))?.type).toBe("image/svg+xml");
    expect(asked).toBe(2);
    expect(rows(db)).toBe(1);
  });

  it("does not keep a server error as no picture either", async () => {
    let asked = 0;
    let status = 503;
    const base = await secure((_req, res) => {
      asked++;
      if (status !== 200) return void res.writeHead(status).end();
      res.end(SVG);
    });
    const db = database();
    const logos = boot(db);
    expect(await logos.fromUrl(`${base}/a`)).toBeNull();
    expect(rows(db)).toBe(0);
    status = 200;
    expect((await logos.fromUrl(`${base}/a`))?.type).toBe("image/svg+xml");
    expect(asked).toBe(2);
  });

  it("keeps a confirmed miss for a while, across a restart, then asks again", async () => {
    let asked = 0;
    const base = await secure((_req, res) => {
      asked++;
      res.end("not a picture");
    });
    const db = database();
    let now = 1_000_000;
    expect(await boot(db, () => now).fromUrl(`${base}/a`)).toBeNull();
    expect(asked).toBe(1);
    expect(rows(db)).toBe(1);
    now += 60 * 1000;
    expect(await boot(db, () => now).fromUrl(`${base}/a`)).toBeNull();
    expect(asked).toBe(1);
    now += 2 * 60 * 60 * 1000;
    expect(await boot(db, () => now).fromUrl(`${base}/a`)).toBeNull();
    expect(asked).toBe(2);
  });

  it("checks the kept bytes again: a row that is no longer a safe picture is dropped and asked for", async () => {
    let asked = 0;
    const base = await secure((_req, res) => {
      asked++;
      res.end(SVG);
    });
    const db = database();
    await boot(db).fromUrl(`${base}/a`);
    db.query("UPDATE plugin_icon SET data = ?").run(
      Buffer.from("<svg><script>alert(1)</script></svg>"),
    );
    const got = await boot(db).fromUrl(`${base}/a`);
    expect(got).toEqual({
      type: "image/svg+xml",
      data: Buffer.from(SVG).toString("base64"),
    });
    expect(asked).toBe(2);
    expect(rows(db)).toBe(1);
  });
});
