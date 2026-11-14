/**
 * A real daemon, in this process, against a real host: the other end of the link for tests.
 *
 * It is the daemon's own code (the node that serves sessions and the link that dials), with a data
 * directory of its own that only it uses, so a test can tell which side touched which files.
 */
import type { MachineView } from "@eta/client-contracts";
import type { Identity, LinkState } from "@eta/daemon";
import type { Host } from "../../src/host";
import type { Client } from "./client";
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
    /** More of the node's options: its version, how it says it was started, its runtimes. */
    node?: Partial<ConstructorParameters<typeof DaemonNode>[0]>;
  } = {},
): Promise<TestDaemon> {
  const dataDir = options.dataDir ?? (await tempDir("eta-daemon-"));
  const { code, url } = await makeCode(client, host, options.name);
  const { identity, fingerprint } = await enroll({ dataDir, url, code });
  const node = new DaemonNode({
    dataDir,
    version: "test",
    // The real home (its personas, its `~/.eta/mcp.json`) is not this test's business.
    home: dataDir,
    warn: options.warn ?? (() => undefined),
    ...options.node,
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

/** Every status the browser was shown for the machine, oldest first, from frame `from` on. */
function statusesShown(
  client: Client,
  id: string,
  from = 0,
): MachineView["status"][] {
  const shown: MachineView["status"][] = [];
  for (const frame of client.frames.slice(from)) {
    const sections =
      frame.type === "hello"
        ? frame.state.machines?.sections
        : frame.type === "state" && frame.target === "machines"
          ? (frame.snapshot?.sections ?? frame.patch?.sections)
          : undefined;
    const list = sections?.list as MachineView[] | undefined;
    const machine = list?.find((each) => each.id === id);
    if (machine !== undefined) shown.push(machine.status);
  }
  return shown;
}

/**
 * Cut the daemon's link and wait until it is back on a new connection, the browser having been
 * shown the machine offline and then online again.
 *
 * "Offline" is read from the frames the browser received, not from what it shows now: the test
 * daemon dials again after about 20ms, so the machine can be online again before a poll of the
 * current view comes round, and a wait for that view to say "offline" then never ends.
 */
export async function dropLink(
  host: Host,
  client: Client,
  daemon: TestDaemon,
): Promise<void> {
  const hub = host.product.hub;
  const before = hub.link(daemon.machineId);
  if (before === undefined) throw new Error("the daemon is not linked");
  const from = client.frames.length;
  daemon.link.drop();
  await until(() =>
    statusesShown(client, daemon.machineId, from).includes("offline"),
  );
  await until(() => {
    const link = hub.link(daemon.machineId);
    return link !== undefined && link.epoch !== before.epoch;
  });
  await until(() => {
    const shown = statusesShown(client, daemon.machineId, from);
    return shown.lastIndexOf("online") > shown.indexOf("offline");
  });
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
