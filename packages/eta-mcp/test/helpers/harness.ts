/**
 * Test setup: a temporary directory, a manager on a controllable clock, and fake servers.
 */
import type { McpManagerOptions } from "../../src/manager";
import type { McpConfigSource, McpServerEntry } from "../../src/types";
import type { FakeSpec } from "./fake-mcp";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager } from "../../src/manager";

const fixture = fileURLToPath(
  new URL("../fixtures/stdio-server.ts", import.meta.url),
);

export interface Harness {
  dir: string;
  manager: McpManager;
  /** The clock the manager runs on, in ms; `advance` moves it. */
  clock: { now: number };
  advance: (ms: number) => void;
  /** How many times the fake stdio servers were spawned. */
  starts: () => number;
  /** A stdio server entry running the fake with this spec. */
  stdio: (
    spec: FakeSpec,
    extra?: Partial<McpServerEntry>,
    env?: Record<string, string>,
  ) => McpServerEntry;
  source: (
    servers: Record<string, McpServerEntry>,
    name?: string,
  ) => McpConfigSource;
  cleanup: () => Promise<void>;
}

const harnesses: Harness[] = [];

export async function setup(
  options: Partial<McpManagerOptions> = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "eta-mcp-test-"));
  const clock = { now: 1_000_000 };
  const startsFile = join(dir, "starts.log");
  const manager = new McpManager({
    cacheFile: join(dir, "cache.json"),
    outputDir: join(dir, "outputs"),
    checkIntervalMs: 0,
    now: () => clock.now,
    resolvers: false,
    ...options,
  });
  const harness: Harness = {
    dir,
    manager,
    clock,
    advance: (ms) => {
      clock.now += ms;
    },
    starts: () => {
      try {
        return readFileSync(startsFile, "utf8").split("\n").filter(Boolean)
          .length;
      } catch {
        return 0;
      }
    },
    stdio: (spec, extra = {}, env = {}) => ({
      command: "bun",
      args: [fixture],
      ...extra,
      // `extra.env` adds to the fake's variables rather than replacing them.
      env: {
        FAKE_MCP: JSON.stringify(spec),
        FAKE_MCP_STARTS: startsFile,
        ...env,
        ...extra.env,
      },
    }),
    source: (servers, name = "test") => ({ name, servers }),
    cleanup: async () => {
      await manager.closeAll();
      await rm(dir, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

export async function cleanupAll(): Promise<void> {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
}

/** A tool with sensible defaults. */
export function tool(
  name: string,
  extra: Record<string, unknown> = {},
): FakeSpec["tools"][number] {
  return { name, description: `${name} tool`, ...extra };
}
