/**
 * A remote plugin server that signs in with OAuth, as an external runtime gets it: the sign-in
 * token the user stored is in the server's headers when the session opens.
 */
import type { SessionMeta } from "@eta/server";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpServerKey } from "@eta/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { CredentialRows } from "../src/mcp/credentials";
import { Plugins } from "../src/plugins/service";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const URL_OF_REMOTE = "https://example.com/mcp";
const ACCESS = "access-token-0123456789";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-session-token-"));
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
        remote: {
          type: "streamable-http",
          url: URL_OF_REMOTE,
          headers: { "X-Api-Key": "from-file" },
        },
      },
    }),
  );
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
  const key = Buffer.alloc(32, 1);
  const plugins = new Plugins({
    db,
    dataDir,
    key,
    agents: { get: () => ({ runtime: "codex" }) } as never,
    machines: { list: () => [] } as never,
    hub: { onReady: () => {} } as never,
    changed: () => {},
    warn: () => {},
  });
  await plugins.registry.refresh();
  plugins.rows.setEnabled("ada", ["demo"]);
  const meta = { agentId: "ada", runtime: "codex" } as SessionMeta;
  const store = new CredentialRows(db, key);
  return { plugins, meta, store };
}

describe("the sign-in token of an OAuth server, for an external runtime", () => {
  it("is the server's Authorization header, next to the plugin's own", async () => {
    const { plugins, meta, store } = await setup();
    await store.set(mcpServerKey(URL_OF_REMOTE), "tokens", {
      access_token: ACCESS,
      token_type: "Bearer",
      expires_in: 3600,
    });
    const extras = await plugins.runtimeExtrasFor(meta);
    expect(extras.mcpServers).toEqual([
      {
        name: "demo-remote",
        type: "http",
        url: URL_OF_REMOTE,
        headers: {
          "X-Api-Key": "from-file",
          Authorization: `Bearer ${ACCESS}`,
        },
      },
    ]);
  });
});
