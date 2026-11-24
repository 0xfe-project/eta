import type { SessionMeta } from "@eta/server";
/**
 * The global switch of an installed plugin: off, it gives no agent skills or servers, whatever each
 * agent enabled; on, the agents' own choice decides again. Read straight from the service.
 */
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { Plugins } from "../src/plugins/service";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-switch-"));
  dirs.push(dataDir);
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(join(dir, "skills", "greet"), { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({ $schema: PLUGIN, name: "demo" }),
  );
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      $schema: MCP,
      mcpServers: { hello: { type: "stdio", command: "node" } },
    }),
  );
  await writeFile(
    join(dir, "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: Greets.\n---\n\nBody.\n",
  );
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  // The agents are not the point here: the rows only name them.
  db.exec("PRAGMA foreign_keys = OFF");
  const changes: number[] = [];
  const plugins = new Plugins({
    db,
    dataDir,
    key: Buffer.alloc(32, 1),
    agents: { get: () => ({ runtime: "eta" }) } as never,
    machines: { list: () => [] } as never,
    hub: { onReady: () => {} } as never,
    changed: () => changes.push(1),
    warn: () => {},
  });
  await plugins.registry.refresh();
  plugins.rows.setEnabled("ada", ["demo"]);
  const meta = (agentId: string): SessionMeta =>
    ({ agentId, runtime: "codex" }) as SessionMeta;
  return { plugins, meta, changes };
}

describe("the global switch of a plugin", () => {
  it("is on for a plugin that exists already, and offers an enabled agent its skills and servers", async () => {
    const { plugins, meta } = await setup();
    const view = plugins.view().find((entry) => entry.name === "demo")!;
    expect(view.enabled).toBe(true);
    expect(plugins.skillDirsFor(meta("ada"))).toHaveLength(1);
    expect(plugins.mcpSourcesFor("ada")).toHaveLength(1);
    expect(plugins.active("ada").map((entry) => entry.name)).toEqual(["demo"]);
  });

  it("offers an agent that enabled it nothing while it is off, and everything again when it is on", async () => {
    const { plugins, meta, changes } = await setup();
    const seen = changes.length;
    plugins.setEnabled("demo", false);
    expect(changes.length).toBe(seen + 1);
    expect(plugins.view().find((entry) => entry.name === "demo")!.enabled).toBe(
      false,
    );
    expect(plugins.skillDirsFor(meta("ada"))).toEqual([]);
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
    const extras = await plugins.runtimeExtrasFor(meta("ada"));
    expect(extras.mcpServers ?? []).toEqual([]);
    expect(extras.skills ?? "").toBe("");
    expect(plugins.active("ada")).toEqual([]);
    // It is not reported as skipped for the agent either: it was switched off, nothing is wrong.
    expect(plugins.skipped("ada")).toEqual([]);
    // Still installed, and the agent still has it enabled.
    expect(plugins.rows.enabled("ada")).toEqual(["demo"]);
    expect(plugins.registry.get("demo")).toBeDefined();

    plugins.setEnabled("demo", true);
    expect(plugins.skillDirsFor(meta("ada"))).toHaveLength(1);
    expect(plugins.mcpSourcesFor("ada")).toHaveLength(1);
    expect(plugins.rows.enabled("ada")).toEqual(["demo"]);
  });

  it("gives an agent that did not enable it nothing, with the switch on, and is not changed by toggling", async () => {
    const { plugins, meta } = await setup();
    expect(plugins.skillDirsFor(meta("bob"))).toEqual([]);
    plugins.setEnabled("demo", false);
    plugins.setEnabled("demo", true);
    expect(plugins.skillDirsFor(meta("bob"))).toEqual([]);
    expect(plugins.mcpSourcesFor("bob")).toEqual([]);
    expect(plugins.rows.enabled("bob")).toEqual([]);
    expect(plugins.rows.enabled("ada")).toEqual(["demo"]);
  });

  it("changes what a session was opened with, so open sessions are reopened", async () => {
    const { plugins } = await setup();
    const before = plugins.stampOf("ada");
    plugins.setEnabled("demo", false);
    expect(plugins.stampOf("ada")).not.toBe(before);
    plugins.setEnabled("demo", true);
    expect(plugins.stampOf("ada")).toBe(before);
  });

  it("forgets the switch when the plugin's source is removed, and refuses a plugin that is not there", async () => {
    const { plugins } = await setup();
    expect(() => plugins.setEnabled("nope", false)).toThrow();
    plugins.rows.setDisabled("demo", true);
    plugins.rows.removeSource("demo");
    expect(plugins.rows.disabled().size).toBe(0);
  });
});
