import type { AcpAgentConfig } from "@eta/client-contracts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The fake agent's script: `bun <this>` is an ACP agent on stdio. */
export const FAKE_AGENT = fileURLToPath(
  new URL("./fake-agent.ts", import.meta.url),
);

export interface FakeAgent {
  /** Where the agent keeps its sessions and its log. */
  dir: string;
  config: AcpAgentConfig;
  /** What the agent wrote down: every request it took, in order. */
  log: () => (Record<string, unknown> & { method: string; pid: number })[];
}

/** A configuration that runs the fake agent, with a directory of its own. */
export function fakeAgent(
  id = "fake",
  options: Partial<AcpAgentConfig> = {},
): FakeAgent {
  const dir = mkdtempSync(join(tmpdir(), "eta-acp-fake-"));
  return {
    dir,
    config: {
      id,
      label: "Fake Agent",
      command: process.execPath,
      args: [FAKE_AGENT],
      ...options,
      env: { FAKE_ACP_DIR: dir, ...options.env },
    },
    log: () => {
      try {
        return readFileSync(join(dir, "log.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as never);
      } catch {
        return [];
      }
    },
  };
}

/** An `acp.json` with these agents, in a directory of its own. */
export function configFile(agents: readonly AcpAgentConfig[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "eta-acp-config-")), "acp.json");
  writeFileSync(path, JSON.stringify({ agents }));
  return path;
}

export async function until<T>(
  read: () => T | undefined | false,
  what = "the condition",
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
