/**
 * The run file: how a shell finds the backend that is already running, instead of starting a
 * second one over the same sessions (SERVER-REFACTOR.md §8 "service-claim", §10 `run/`).
 *
 * Three moves, each from a way this goes wrong:
 *
 * - **Claim before listening.** The file is created exclusively (`wx`) with `state: "starting"`
 *   and this pid, so two launches racing each other cannot both become the backend: the loser sees
 *   a live claim and stands down. A claim whose pid is dead is stale and is taken over.
 * - **Publish once listening.** The claim is replaced atomically (temp + rename) by the ready
 *   descriptor, so a reader sees either the claim or the whole descriptor, never half a file.
 * - **Release only what is ours.** On shutdown the file goes only if it still names this pid —
 *   a backend that was replaced must not delete its successor's file.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServiceDescriptor } from "@eta/client-contracts";

/** Whether a pid is a running process (EPERM: it exists, it is just not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The descriptor in a run file, or undefined when the file is missing or is not one. */
export async function readServiceFile(
  path: string,
): Promise<ServiceDescriptor | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  return isServiceDescriptor(raw) ? raw : undefined;
}

export function isServiceDescriptor(
  value: unknown,
): value is ServiceDescriptor {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.pid !== "number" ||
    typeof candidate.startedAt !== "number"
  )
    return false;
  if (candidate.state === "starting") return true;
  return (
    candidate.state === "ready" &&
    typeof candidate.protocol === "number" &&
    typeof candidate.host === "string" &&
    typeof candidate.port === "number" &&
    typeof candidate.dataDir === "string" &&
    typeof candidate.version === "string"
  );
}

export type ClaimOutcome =
  | {
      kind: "claimed";
      publish(
        descriptor: Omit<
          Extract<ServiceDescriptor, { state: "ready" }>,
          "pid" | "startedAt" | "state"
        >,
      ): Promise<void>;
      release(): Promise<void>;
    }
  | { kind: "taken"; owner: ServiceDescriptor };

/**
 * Become the backend this file describes, or learn who already is. `alive` is injectable so a
 * test can describe a stale owner without a dead process to point at.
 */
export async function claimServiceFile(
  path: string,
  options: {
    pid?: number;
    now?: () => number;
    alive?: (pid: number) => boolean;
  } = {},
): Promise<ClaimOutcome> {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const alive = options.alive ?? pidAlive;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const startedAt = now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(
        path,
        `${JSON.stringify({ state: "starting", pid, startedAt })}\n`,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readServiceFile(path);
      if (owner !== undefined && owner.pid !== pid && alive(owner.pid))
        return { kind: "taken", owner };
      // Stale (its process is gone) or unreadable: take it over and try again.
      await rm(path, { force: true });
      continue;
    }
    const owns = async (): Promise<boolean> =>
      (await readServiceFile(path))?.pid === pid;
    return {
      kind: "claimed",
      async publish(descriptor) {
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(
          temp,
          `${JSON.stringify({ state: "ready", pid, startedAt, ...descriptor }, null, "\t")}\n`,
          {
            mode: 0o600,
          },
        );
        await rename(temp, path);
      },
      async release() {
        if (await owns()) await rm(path, { force: true });
      },
    };
  }
  throw new Error(`could not claim ${path}`);
}
