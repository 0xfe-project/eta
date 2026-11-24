import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
/**
 * A logo is made small before the host keeps it: a picture over MAX_ICON_BYTES is shrunk to fit and
 * is still a hit; one that fits, an svg and one that cannot be shrunk are kept as they came. Local
 * fake servers stand in for the repository and the site; nothing here reaches the network.
 */
import http from "node:http";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { IconCache } from "../src/plugins/icon-cache";
import { Logos } from "../src/plugins/logo";

/** The most bytes of one kept logo (the host's MAX_ICON_BYTES); written out so this file runs on code that lacks it. */
const MAX_ICON_BYTES = 16 * 1024;
const REPO = "https://github.com/cursor/plugins.git";
const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A square png of noise: it does not compress, so a big one stays big until it is scaled down. */
function noisePng(size: number): Buffer {
  let seed = 7;
  const rows = Array.from({ length: size }, () => {
    const row = Buffer.alloc(1 + size * 3);
    for (let i = 1; i < row.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      row[i] = (seed >> 16) & 0xff;
    }
    return row;
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

/** Files by full request path; every answer is the file, or 404. */
async function serve(files: Record<string, string | Buffer>) {
  const server = http.createServer((req, res) => {
    const file = files[String(req.url)];
    if (file === undefined) res.writeHead(404).end();
    else res.end(file);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const manifest = (name: string, logo: string) => ({
  [`/cursor/plugins/main/${name}/.cursor-plugin/plugin.json`]: JSON.stringify({
    logo,
  }),
});
const file = (name: string, logo: string, bytes: string | Buffer) => ({
  ...manifest(name, logo),
  [`/cursor/plugins/main/${name}/${logo}`]: bytes,
});

async function boot(files: Record<string, string | Buffer>) {
  const base = await serve(files);
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  const store = new IconCache(db);
  const warnings: string[] = [];
  const logos = new Logos({
    allowPrivate: true,
    rawBase: base,
    timeoutMs: 3000,
    store,
    warn: (message) => warnings.push(message),
  });
  return { base, store, logos, warnings };
}
const ask = (path: string, homepage: string | null = null) => ({
  repo: REPO,
  ref: "main",
  path,
  homepage,
});
const length = (logo: { data: string } | null | undefined) =>
  Buffer.from(logo!.data, "base64").length;

describe("a logo is made small before it is kept", () => {
  it("shrinks a png over the limit, keeps it as a hit, and keeps the small one", async () => {
    const big = noisePng(192);
    expect(big.length).toBeGreaterThan(MAX_ICON_BYTES);
    const { store, logos } = await boot(file("a", "logo.png", big));
    const logo = await logos.fromRepo(REPO, "main", "a");
    expect(logo?.type).toBe("image/png");
    expect(length(logo)).toBeLessThanOrEqual(MAX_ICON_BYTES);
    // The answer, the kept bytes and a host that starts again all say the same.
    expect(store.peek(REPO, "main", "a")?.bytes?.byteLength).toBe(length(logo));
    const answer = logos.cached([ask("a")])[0];
    expect(answer?.status).toBe("hit");
    const again = new Logos({ store }).cached([ask("a")])[0];
    expect(again?.status).toBe("hit");
  });

  it("shrinks a jpeg the same way, and it stays a jpeg", async () => {
    const jpeg = Buffer.from(
      await new Bun.Image(noisePng(192)).jpeg({ quality: 95 }).buffer(),
    );
    expect(jpeg.length).toBeGreaterThan(MAX_ICON_BYTES);
    const { logos } = await boot(file("b", "logo.jpg", jpeg));
    const logo = await logos.fromRepo(REPO, "main", "b");
    expect(logo?.type).toBe("image/jpeg");
    expect(length(logo)).toBeLessThanOrEqual(MAX_ICON_BYTES);
    expect(logos.cached([ask("b")])[0]?.status).toBe("hit");
  });

  it("leaves a picture that fits exactly as it came", async () => {
    const small = noisePng(8);
    expect(small.length).toBeLessThanOrEqual(MAX_ICON_BYTES);
    const { store, logos } = await boot(file("c", "logo.png", small));
    const logo = await logos.fromRepo(REPO, "main", "c");
    expect(Buffer.from(logo!.data, "base64").equals(small)).toBe(true);
    expect(
      Buffer.from(store.peek(REPO, "main", "c")!.bytes!).equals(small),
    ).toBe(true);
  });

  it("does not touch an svg, and says nothing", async () => {
    const { logos, warnings } = await boot(file("d", "logo.svg", SVG));
    const logo = await logos.fromRepo(REPO, "main", "d");
    expect(logo?.type).toBe("image/svg+xml");
    expect(Buffer.from(logo!.data, "base64").toString()).toBe(SVG);
    expect(warnings).toEqual([]);
  });

  it("keeps a picture it cannot shrink as it came, and says why; the logo is not lost", async () => {
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(MAX_ICON_BYTES + 4096, 1),
    ]);
    const { logos, warnings } = await boot(file("e", "logo.png", broken));
    const logo = await logos.fromRepo(REPO, "main", "e");
    expect(Buffer.from(logo!.data, "base64").equals(broken)).toBe(true);
    expect(logos.cached([ask("e")])[0]?.status).toBe("hit");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("kept as it was");
  });

  it("shrinks a homepage icon too, under the entry's own key", async () => {
    const big = noisePng(192);
    const { base, store, logos } = await boot({ "/favicon.ico": big });
    const homepage = `${base}/`;
    const logo = await logos.forEntry(REPO, "main", "none", homepage);
    expect(logo?.type).toBe("image/png");
    expect(length(logo)).toBeLessThanOrEqual(MAX_ICON_BYTES);
    expect(
      store.peek(REPO, "main", `#site:${homepage}`)?.bytes?.byteLength,
    ).toBeLessThanOrEqual(MAX_ICON_BYTES);
  });
});
