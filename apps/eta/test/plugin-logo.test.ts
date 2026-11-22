/**
 * Plugin logos: found by the host, from a public address only, as a picture and nothing else.
 * Local fake servers answer; no real site is asked.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isPrivateAddress, Logos, pictureType } from "../src/plugins/logo";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
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
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"])
      expect(isPrivateAddress(address)).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
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
    expect((await logos.find(null, base + "/"))?.type).toBe("image/png");
    const second = await serve((req, res) => {
      if (req.url === "/favicon.ico") res.end(Buffer.from([0, 0, 1, 0, 9]));
      else res.end("<html></html>");
    });
    expect((await new Logos({ allowPrivate: true }).find(null, second + "/"))?.type).toBe("image/x-icon");
  });

  it("does not take what is not a picture (an SVG, HTML) or too much", async () => {
    const svg = await serve((_req, res) => res.end("<svg onload=alert(1)></svg>"));
    expect(await new Logos({ allowPrivate: true }).find(svg + "/a.svg", null)).toBeNull();
    const big = await serve((_req, res) => res.end(Buffer.concat([PNG, Buffer.alloc(300 * 1024)])));
    expect(await new Logos({ allowPrivate: true }).find(big + "/a.png", null)).toBeNull();
    expect(pictureType(Buffer.from("<svg"))).toBeNull();
  });

  it("checks every redirect: one into a private address is refused", async () => {
    let target = 0;
    const inner = await serve((_req, res) => {
      target++;
      res.end(PNG);
    });
    const outer = await serve((_req, res) => res.writeHead(302, { location: inner + "/x.png" }).end());
    const logos = new Logos({ allowPrivate: false, resolve: async () => ["93.184.216.34"] });
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
    await logos.find(base + "/a.png", null);
    await logos.find(base + "/a.png", null);
    expect(hits).toBe(1);
  });
});
