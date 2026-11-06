/**
 * Where a running upgrade says how it is going: `<dataDir>/upgrade-status.json`.
 *
 * A file, because whoever reads it (the page through the host, the `eta-host upgrade` that started
 * it) comes and goes while the worker lives through the restart. Not in the database, because that
 * is what a roll-back puts back. Written by renaming a whole file over it, so a reader never sees
 * half of one.
 *
 * The reader of a status may be the new build reading what the old one wrote, so a field only ever
 * gets added.
 */
import type {
  UpgradeBusy,
  UpgradePhase,
  UpgradeState,
  UpgradeStatusView,
} from "@eta/client-contracts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** The worker gets this long to start and say its pid. */
const START_GRACE_MS = 30_000;
const LOG_LINES = 200;

/** What is on disk: the view, and who to ask whether it is still true. */
interface StoredStatus extends UpgradeStatusView {
  /** The worker; 0 until it has started. */
  pid: number;
}

const statusPath = (dataDir: string): string =>
  join(dataDir, "upgrade-status.json");

function write(dataDir: string, status: StoredStatus): void {
  mkdirSync(dataDir, { recursive: true });
  const path = statusPath(dataDir);
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(status), { mode: 0o600 });
  renameSync(part, path);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStored(dataDir: string): StoredStatus | undefined {
  try {
    const status = JSON.parse(
      readFileSync(statusPath(dataDir), "utf8"),
    ) as StoredStatus;
    return typeof status.id === "string" ? status : undefined;
  } catch {
    return undefined;
  }
}

/** The last upgrade, if there was one. One that says it is running with nobody doing it is `lost`. */
export function readStatus(
  dataDir: string,
  now: number = Date.now(),
): UpgradeStatusView | undefined {
  const stored = readStored(dataDir);
  if (stored === undefined) return undefined;
  const { pid, ...status } = stored;
  const gone =
    pid === 0 ? now - status.startedAt > START_GRACE_MS : !alive(pid);
  if (status.state !== "running" || !gone) return status;
  return {
    ...status,
    state: "lost",
    error: `the upgrade stopped by itself during ${status.phase}`,
  };
}

/** Before the worker exists, so nobody who asks right after a start sees the last one. */
export function announceUpgrade(
  dataDir: string,
  id: string,
  from: string,
  now: number = Date.now(),
): void {
  write(dataDir, {
    id,
    pid: 0,
    state: "running",
    phase: "starting",
    from,
    startedAt: now,
    log: [],
  });
}

/** The worker never started. */
export function abandonUpgrade(
  dataDir: string,
  id: string,
  error: string,
): void {
  const stored = readStored(dataDir);
  if (stored?.id === id)
    write(dataDir, {
      ...stored,
      state: "failed",
      finishedAt: Date.now(),
      error,
    });
}

/** The worker's side: every change goes to the file at once, because the next moment may be its last. */
export class StatusWriter {
  readonly #dataDir: string;
  #status: StoredStatus;

  constructor(dataDir: string, id: string, from: string) {
    this.#dataDir = dataDir;
    const announced = readStored(dataDir);
    this.#status = {
      id,
      pid: process.pid,
      state: "running",
      phase: "starting",
      from,
      startedAt: announced?.id === id ? announced.startedAt : Date.now(),
      log: [],
    };
    this.#save();
  }

  #save(): void {
    write(this.#dataDir, this.#status);
  }

  log(line: string): void {
    this.#status.log = [...this.#status.log, line].slice(-LOG_LINES);
    this.#save();
  }

  target(version: string): void {
    this.#status.to = version;
    this.#save();
  }

  phase(phase: UpgradePhase, busy?: UpgradeBusy[]): void {
    const { busy: _, ...status } = this.#status;
    this.#status = {
      ...status,
      phase,
      ...(busy === undefined ? {} : { busy }),
    };
    this.#save();
  }

  finish(state: Exclude<UpgradeState, "running">, error?: string): void {
    this.#status = {
      ...this.#status,
      state,
      finishedAt: Date.now(),
      ...(error === undefined ? {} : { error }),
    };
    this.#save();
  }
}
