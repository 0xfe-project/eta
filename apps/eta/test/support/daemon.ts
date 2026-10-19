/**
 * A real daemon, in this process, against a real host: the other end of the link for tests.
 *
 * It is the daemon's own code (the node that serves sessions and the link that dials), with a data
 * directory of its own that only it uses, so a test can tell which side touched which files.
 */
import type { MachineView } from "@eta/client-contracts";
import type { DaemonNodeOptions, Identity, LinkState } from "@eta/daemon";
import type { Host } from "../../src/host";
import type { Client } from "./client";
import { join } from "node:path";
import { DaemonLink, DaemonNode, enroll } from "@eta/daemon";
import { afterEach } from "vitest";
import { until } from "./client";
import { tempDir } from "./host";

export interface TestDaemon {
  dataDir: string;
  identity: Identity;
  fingerprint: string;
  node: DaemonNode;
  link: DaemonLink;
  /** What the link has reported, oldest first. */
  states: LinkState[];
  /** The machine id the primary gave it. */
  machineId: string;
  /** Wait for the link to be in this state. */
  reached: (state: LinkState["state"]) => Promise<void>;
  stop: () => Promise<void>;
}

const running: TestDaemon[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

/** Make an install code the way the settings page does. */
export async function makeCode(
  client: Client,
  host: Host,
  name?: string,
): Promise<{ code: string; url: string }> {
  const result = (await client.call("machines", "enroll", {
    ...(name === undefined ? {} : { name }),
    url: `http://127.0.0.1:${host.port}`,
  })) as { code: string; url: string };
  return result;
}

/** Enrol a daemon with a code and start dialing; it is pending until the host approves it. */
export async function startDaemon(
  host: Host,
  client: Client,
  options: {
    name?: string;
    dataDir?: string;
    /** Do not dial; the caller starts the link. */
    idle?: boolean;
    warn?: (message: string) => void;
    /** Sees every text frame that crosses the link, both ways. */
    tap?: (direction: "in" | "out", text: string) => void;
    /** The MCP servers its sessions get. */
    mcp?: Pick<DaemonNodeOptions, "mcpServers">;
  } = {},
): Promise<TestDaemon> {
  const dataDir = options.dataDir ?? (await tempDir("eta-daemon-"));
  const { code, url } = await makeCode(client, host, options.name);
  const { identity, fingerprint } = await enroll({ dataDir, url, code });
  const node = new DaemonNode({
    dataDir,
    version: "test",
    // The real user's akhook file is not this test's business.
    akhookUserConfig: join(dataDir, "no-user-akhook.yml"),
    warn: options.warn ?? (() => undefined),
    ...options.mcp,
  });
  await node.start();
  const states: LinkState[] = [];
  const link = new DaemonLink({
    identity,
    server: node,
    backoff: { minMs: 20, maxMs: 100 },
    heartbeatMs: 200,
    silenceMs: 2_000,
    tap: options.tap,
    onState: (state) => states.push(state),
    warn: () => undefined,
  });
  const daemon: TestDaemon = {
    dataDir,
    identity,
    fingerprint,
    node,
    link,
    states,
    machineId: identity.machineId,
    reached: (state) => until(() => states.at(-1)?.state === state, 10_000),
    async stop() {
      await link.stop();
      await node.close();
    },
  };
  running.push(daemon);
  if (options.idle !== true) link.start();
  return daemon;
}

/** The machine as the host's `machines` list shows it. */
export function machineView(
  client: Client,
  id: string,
): MachineView | undefined {
  return client
    .section<MachineView[]>("machines", "list")
    ?.find((machine) => machine.id === id);
}

/** Approve a daemon the way the user does, from its fingerprint, and wait until it is online. */
export async function approve(
  client: Client,
  daemon: TestDaemon,
): Promise<void> {
  await client.call("machines", "approve", {
    machineId: daemon.machineId,
    fingerprint: daemon.fingerprint,
  });
  await until(
    () => machineView(client, daemon.machineId)?.status === "online",
    10_000,
  );
}
