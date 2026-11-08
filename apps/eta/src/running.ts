/**
 * Which host already serves this data directory: what `eta-host running` prints, so the desktop app
 * opens that one instead of starting a second over the same database.
 *
 * Two ways to know. A host says so itself: once listening it writes `<dataDir>/running-host.json`
 * (its pid, where it listens, its token file) and takes it away when it stops. A host from before
 * that, or one whose record a crash left behind, is not believed on its word: the pid has to be
 * alive and `/up` has to answer. Then the service the computer's own manager runs (systemd,
 * launchd, a Windows service), which an older build did not record, asked where its flags say it
 * listens.
 */
import type { ServiceStatus } from "@eta/daemon";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { isLoopback } from "./access";
import { RUN_OPTIONS } from "./cli";
import { askUp, hostManager, upUrl } from "./upgrade/service";

/** What a running host writes about itself. */
export interface RunningRecord {
  pid: number;
  /** The address it listens on, a tailnet address already resolved. */
  hostname: string;
  port: number;
  /** Where its token is, when it asks for one. */
  tokenFile: string | null;
  version: string;
}

/** A host to open, as `eta-host running` says it. */
export interface RunningHost {
  /** The origin a page on this computer reaches it at. */
  address: string;
  /** The file its token is in, when it asks for one. */
  tokenFile: string | null;
  /** How it was found. */
  from: "record" | "service";
}

const recordPath = (dataDir: string): string =>
  join(dataDir, "running-host.json");

/** Write the record; what is returned takes it away again, if it is still this process's. */
export function recordRunning(
  dataDir: string,
  record: RunningRecord,
): () => void {
  const path = recordPath(dataDir);
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return () => {
    if (readRecord(dataDir)?.pid === record.pid) rmSync(path, { force: true });
  };
}

function readRecord(dataDir: string): RunningRecord | undefined {
  try {
    const record = JSON.parse(
      readFileSync(recordPath(dataDir), "utf8"),
    ) as RunningRecord;
    return typeof record.pid === "number" && typeof record.port === "number"
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

/** Where a page on this computer reaches a host listening on `hostname`. */
export function localOrigin(hostname: string, port: number): string {
  let host = hostname;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${String(port)}`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A computer's service, in the parts this needs. */
interface InstalledHost {
  argv: string[];
  status: () => Promise<ServiceStatus>;
}

export interface FindOptions {
  dataDir: string;
  /** The rest is here for a test. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
  up?: (url: string) => Promise<boolean>;
  installed?: () => Promise<InstalledHost | undefined>;
}

async function computerService(): Promise<InstalledHost | undefined> {
  const manager = hostManager();
  const argv = await manager.installed();
  return argv === undefined ? undefined : { argv, status: manager.status };
}

/** The host serving `dataDir` that is not this process; undefined when there is none. */
export async function findRunningHost(
  options: FindOptions,
): Promise<RunningHost | undefined> {
  const { dataDir } = options;
  const self = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? alive;
  const up = options.up ?? askUp;

  const record = readRecord(dataDir);
  if (record !== undefined && record.pid !== self && isAlive(record.pid)) {
    const address = localOrigin(record.hostname, record.port);
    if (await up(`${address}/up`))
      return { address, tokenFile: record.tokenFile, from: "record" };
  }

  // No service manager here, or none that answers: that is no service.
  const service = await (options.installed ?? computerService)().catch(
    () => undefined,
  );
  if (service === undefined) return undefined;
  const status = await service.status().catch(() => undefined);
  if (status?.running !== true || status.pid === self) return undefined;
  const args = service.argv.slice(1);
  let url: string;
  try {
    url = await upUrl(args);
  } catch {
    return undefined;
  }
  if (!(await up(url))) return undefined;
  const { values } = parseArgs({
    args,
    options: RUN_OPTIONS,
    strict: false,
    allowPositionals: true,
  });
  const tokenFile =
    typeof values["token-file"] === "string"
      ? values["token-file"]
      : isLoopback(String(values.host))
        ? null
        : join(dataDir, "access-token");
  return {
    address: url.slice(0, -"/up".length),
    tokenFile,
    from: "service",
  };
}
