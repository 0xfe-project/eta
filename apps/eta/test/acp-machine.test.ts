/**
 * An external agent's file belongs to one machine, and after the upgrade the page asks per machine.
 * rc.3 had one `~/.eta/acp.json` and no machine in that page at all, so the single point an
 * upgrade can lose the agents is here: the file has to come out under **this** machine, with the
 * runtime ids (`acp.<id>`) an agent row still points at.
 *
 * The catalog is a stand-in: what an agent's command answers is another test's subject
 * (`acp-service.test.ts`, `admin.test.ts`), and starting real ones here would test nothing about
 * the file.
 */
import type { AcpAgentView, AcpMachineList } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpConfigFile, acpRuntimeId } from "@eta/runtime-acp";
import { afterEach, describe, expect, it } from "vitest";
import { AcpService } from "../src/acp/service";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { MachineStore } from "../src/machines/store";
import { tempDir } from "./support/host";

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/** The file an rc.3 host wrote: `cwd` and `autoAllow` on every agent, and no machines anywhere. */
const RC3_FILE = {
  agents: [
    {
      id: "claude",
      label: "Claude Code",
      command: "claude-code-acp",
      args: ["--experimental"],
      env: { ANTHROPIC_API_KEY: "not-a-real-key" },
      cwd: "/home/someone/work/api",
      autoAllow: true,
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      command: "gemini",
      args: [],
      env: {},
      cwd: "/home/someone/work/web",
      autoAllow: false,
    },
  ],
};

async function machine(home: string) {
  const db = openDatabase(databasePath(join(await tempDir(), "eta.sqlite")));
  open.push(db);
  applyMigrations(db, loadMigrations());
  const config = new AcpConfigFile(join(home, ".eta", "acp.json"));
  mkdirSync(join(home, ".eta"), { recursive: true });
  // The catalog as the page sees it: the file is read every time, so nothing is cached here.
  const catalog = {
    snapshot: (): AcpAgentView[] =>
      config.read().map((agent) => ({
        id: agent.id,
        label: agent.label,
        command: agent.command,
        args: agent.args,
        env: {},
        runtime: acpRuntimeId(agent.id),
        status: "available" as const,
      })),
    stale: () => false,
    views: async () => [],
    view: async () => undefined,
    invalidate: () => undefined,
    test: async () => ({ ok: true, message: "" }),
  };
  const machines = new MachineStore(db);
  const service = new AcpService({
    local: { catalog, config } as never,
    machines: {
      get: (id) => machines.get(id),
      primary: () => machines.primary(),
    },
    link: () => undefined,
    agents: () => [],
    changed: () => undefined,
  });
  return { db, machines, config, service };
}

const lists = (service: AcpService): Record<string, AcpMachineList> =>
  service.lists();

const ids = (list: AcpMachineList | undefined): string[] =>
  list === undefined || list.agents === undefined
    ? []
    : list.agents.map((agent) => agent.id);

describe("whose acp.json it is", () => {
  it("puts the primary's file under the primary machine, with the runtime ids agents use", async () => {
    const home = await tempDir();
    const m = await machine(home);
    m.machines.ensurePrimary({
      name: "host",
      home: "/home/someone",
      os: "linux",
    });
    const primary = m.machines.primary()!;
    writeFileSync(
      join(home, ".eta", "acp.json"),
      JSON.stringify(RC3_FILE, null, 2),
    );

    const shown = lists(m.service);
    expect(Object.keys(shown)).toEqual([primary.id]);
    expect(ids(shown[primary.id])).toEqual(["claude", "gemini"]);
    // The runtime id is what an existing agent row points at, and what the agent form offers.
    expect(shown[primary.id]!.agents!.map((agent) => agent.runtime)).toEqual([
      "acp.claude",
      "acp.gemini",
    ]);
    // cwd and autoAllow are read past: they are not agents' fields any more, and the page has
    // nothing to edit for them.
    const [first] = shown[primary.id]!.agents!;
    expect(first).not.toHaveProperty("cwd");
    expect(first).not.toHaveProperty("autoAllow");
  });

  it("shows nothing until this machine is one, which the host makes sure of at start", async () => {
    const home = await tempDir();
    const m = await machine(home);
    writeFileSync(
      join(home, ".eta", "acp.json"),
      JSON.stringify(RC3_FILE, null, 2),
    );
    // A database from before the primary was recorded: no machine owns the file yet.
    expect(lists(m.service)).toEqual({});
    // `startHost` does this before any page can ask (`product.ts`).
    const primary = m.machines.ensurePrimary({
      name: "host",
      home: "/home/someone",
      os: "linux",
    });
    expect(ids(lists(m.service)[primary.id])).toEqual(["claude", "gemini"]);
  });

  it("says why a file that cannot be read whole is that machine's, not an empty list", async () => {
    const home = await tempDir();
    const m = await machine(home);
    const primary = m.machines.ensurePrimary({
      name: "host",
      home: "/home/someone",
      os: "linux",
    });
    writeFileSync(join(home, ".eta", "acp.json"), '{"agents": [{"id": "cla');
    const shown = lists(m.service);
    expect(Object.keys(shown)).toEqual([primary.id]);
    expect(shown[primary.id]!.agents).toBeUndefined();
    expect(shown[primary.id]!.error).toMatch(/is not valid JSON/);
    // And the agents it could not read are not written over (the file is the same on disk).
    await expect(
      m.service.save(primary.id, { id: "other", command: "x" }, undefined),
    ).rejects.toThrow(/is not valid JSON/);
  });
});
