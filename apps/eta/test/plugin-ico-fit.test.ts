import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
/**
 * A site's .ico over the size limit is cut down to the pictures that fit, as it is: Bun.Image cannot
 * decode an ico, so nothing is re-encoded. One whose every picture is over the limit is kept as it
 * came, and the reason is said. A local fake server stands in for the site; nothing reaches the
 * network.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { IconCache } from "../src/plugins/icon-cache";
import { Logos } from "../src/plugins/logo";

const MAX_ICON_BYTES = 16 * 1024;
const REPO = "https://github.com/cursor/plugins.git";
const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** An ico of pictures `[side, payload bytes]`; the payloads are filler, a cut never reads them. */
function ico(pictures: [number, number][]): Buffer {
  const head = Buffer.alloc(6 + 16 * pictures.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pictures.length, 4);
  let offset = head.length;
  const payloads = pictures.map(([side, size], index) => {
    const at = 6 + 16 * index;
    head[at] = side === 256 ? 0 : side;
    head[at + 1] = side === 256 ? 0 : side;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(size, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += size;
    return Buffer.alloc(size, side);
  });
  return Buffer.concat([head, ...payloads]);
}
/** The pictures of an ico: side and payload, in directory order. */
function pictures(bytes: Buffer): [number, Buffer][] {
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const at = 6 + 16 * index;
    const size = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    return [bytes[at] || 256, bytes.subarray(offset, offset + size)];
  });
}

async function boot(favicon: Buffer) {
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") res.end(favicon);
    else res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  const warnings: string[] = [];
  const logos = new Logos({
    allowPrivate: true,
    timeoutMs: 3000,
    store: new IconCache(db),
    warn: (message) => warnings.push(message),
  });
  return { homepage: `${base}/`, logos, warnings };
}

describe("an ico over the limit is cut down to the pictures that fit", () => {
  it("keeps the largest pictures that fit, byte for byte, and stays an ico", async () => {
    const big = ico([
      [64, 17000],
      [48, 9000],
      [32, 4000],
      [24, 2500],
      [16, 1000],
    ]);
    expect(big.length).toBeGreaterThan(MAX_ICON_BYTES);
    const { homepage, logos, warnings } = await boot(big);
    const logo = await logos.forEntry(REPO, "main", "none", homepage);
    expect(logo?.type).toBe("image/x-icon");
    const kept = Buffer.from(logo!.data, "base64");
    expect(kept.length).toBeLessThanOrEqual(MAX_ICON_BYTES);
    expect(kept.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
    const original = pictures(big);
    const sides = pictures(kept).map(([side]) => side);
    // 64 is over the limit alone; 48 and 32 come first, then what still fits of the rest.
    expect(sides).toContain(48);
    expect(sides).toContain(32);
    expect(sides).not.toContain(64);
    for (const [side, payload] of pictures(kept))
      expect(payload.equals(original.find(([s]) => s === side)![1])).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("leaves an ico that fits exactly as it came", async () => {
    const small = ico([
      [32, 4000],
      [16, 1000],
    ]);
    const { homepage, logos } = await boot(small);
    const logo = await logos.forEntry(REPO, "main", "none", homepage);
    expect(Buffer.from(logo!.data, "base64").equals(small)).toBe(true);
  });

  it("keeps an ico whose every picture is over the limit as it came, and says why", async () => {
    const huge = ico([[120, MAX_ICON_BYTES + 4000]]);
    const { homepage, logos, warnings } = await boot(huge);
    const logo = await logos.forEntry(REPO, "main", "none", homepage);
    expect(Buffer.from(logo!.data, "base64").equals(huge)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("kept as it was");
  });
});
