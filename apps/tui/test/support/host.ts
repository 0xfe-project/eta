/**
 * Real hosts for the connection tests: an in-process host on a free loopback port in a temp
 * directory, and the command line that runs the host from source as a child process.
 */
import type { Host, HostOptions } from "@eta/app/src/host";
import type { HostProgram } from "../../src/connection/types";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { startHost } from "@eta/app/src/host";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach } from "vitest";
import { tempDir } from "./temp";

const hosts = new Set<Host>();

afterEach(async () => {
  for (const host of [...hosts]) await closeHost(host);
});

export interface TestHostOptions {
  /** Puts the host behind the token gate with this token. */
  token?: string;
  /** Reuse a port and data directory, to restart "the same" host. */
  port?: number;
  dataDir?: string;
  /** What `upgrade.check` answers as the host's build; the default makes no network request. */
  version?: string;
  /** Anything else for `startHost`. */
  overrides?: Partial<HostOptions>;
}

export async function testHost(options: TestHostOptions = {}): Promise<Host> {
  const dataDir = options.dataDir ?? (await tempDir("eta-tui-host-"));
  let tokenFile: string | undefined;
  if (options.token !== undefined) {
    tokenFile = join(dataDir, "test-token");
    await writeFile(tokenFile, options.token);
  }
  const version = options.version ?? "dev";
  const host = await startHost({
    dataDir,
    port: options.port ?? 0,
    // Scripted models: the subject is the connection, and a real provider needs the network.
    models: fakeModels([
      assistantMessage({ content: [{ type: "text", text: "fake answer" }] }),
    ]) as never,
    home: dataDir,
    network: false,
    runtimes: false,
    // `upgrade.check` asks GitHub for the latest release unless told otherwise.
    upgrade: {
      version,
      releases: { latest: async () => ({ version }) as never },
      findToken: async () => ({}) as never,
      findService: async () => undefined,
    },
    ...(tokenFile === undefined ? {} : { tokenFile }),
    ...options.overrides,
  });
  hosts.add(host);
  return host;
}

export async function closeHost(host: Host): Promise<void> {
  if (!hosts.delete(host)) return;
  await host.close();
}

export function baseUrl(host: Host): string {
  return `http://127.0.0.1:${host.port}`;
}

/** The host run from source by this Bun: what a temporary host is in these tests. */
export const SOURCE_HOST: HostProgram = {
  command: process.execPath,
  args: [
    resolve(import.meta.dirname, "../../../eta/src/main.ts"),
    "--no-llm",
    "--no-web",
  ],
};

/**
 * An environment for a host child process whose `~/.eta` lands in `home`, and whose
 * `upgrade.check` asks a closed port instead of GitHub.
 */
export function childEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ETA_RELEASES_URL: "http://127.0.0.1:9/releases",
    ETA_TOKEN: "",
  };
}

/** A loopback port nothing listens on: bound once, then released. */
export async function closedPort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = server.port!;
  await server.stop(true);
  return port;
}
