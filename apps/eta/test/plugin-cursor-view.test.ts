/**
 * The Cursor state of a server is worked out in the view from its address and the saved header,
 * never from what a test saw. The credential's value is in no view.
 */
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_AUTH_HEADER } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { Plugins } from "../src/plugins/service";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const VALUE = "{{SECRET_c7d4e9a1}}";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-cursor-view-"));
  dirs.push(dataDir);
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({ $schema: PLUGIN, name: "demo" }),
  );
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      $schema: MCP,
      mcpServers: {
        drive: {
          type: "streamable-http",
          url: "https://api.cursor.com/rest-mcp/google-drive/mcp",
        },
        other: { type: "streamable-http", url: "https://example.com/mcp" },
        local: { type: "stdio", command: "node" },
      },
    }),
  );
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
  const plugins = new Plugins({
    db,
    dataDir,
    key: Buffer.alloc(32, 1),
    agents: { get: () => ({ runtime: "eta" }) } as never,
    machines: { list: () => [] } as never,
    hub: { onReady: () => {} } as never,
    changed: () => {},
    warn: () => {},
  });
  await plugins.registry.refresh();
  const servers = () =>
    plugins.view().find((entry) => entry.name === "demo")!.servers;
  return { plugins, servers };
}

describe("the Cursor state of a server, from the view", () => {
  it("a Cursor-hosted server with no credential saved is marked, and is not signed in", async () => {
    const { servers } = await setup();
    const drive = servers().find((one) => one.name === "drive")!;
    expect(drive.cursorServer).toBe(true);
    expect(drive.cursorSignedIn).toBe(false);
  });

  it("with the credential header saved it is signed in, whatever the header's case, and the value is in no view", async () => {
    const { plugins, servers } = await setup();
    plugins.setSecretHeader(
      "demo",
      "drive",
      CURSOR_AUTH_HEADER.toUpperCase(),
      `Bearer ${VALUE}`,
    );
    const drive = servers().find((one) => one.name === "drive")!;
    expect(drive.cursorServer).toBe(true);
    expect(drive.cursorSignedIn).toBe(true);
    expect(JSON.stringify(plugins.view())).not.toContain(VALUE);
  });

  it("a header of the same name on another server does not count", async () => {
    const { plugins, servers } = await setup();
    plugins.setSecretHeader("demo", "other", CURSOR_AUTH_HEADER, VALUE);
    const drive = servers().find((one) => one.name === "drive")!;
    expect(drive.cursorSignedIn).toBe(false);
  });

  it("a server that is not on cursor.com, and a stdio one, carry neither field", async () => {
    const { servers } = await setup();
    for (const name of ["other", "local"]) {
      const one = servers().find((s) => s.name === name)!;
      expect(one.cursorServer).toBeUndefined();
      expect(one.cursorSignedIn).toBeUndefined();
    }
  });
});
