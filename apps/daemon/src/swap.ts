/**
 * Replacing the file of a program that may be running, which the daemon and the host both do.
 *
 * The new build is staged beside the executable (`<exe>.next`), so the swap is a rename on one
 * filesystem; it is run once (`tryBuild`) to see that it starts and says what it should; then
 * `swapIn` keeps the file as `<exe>.prev` and renames the new one over it. The name always holds a
 * whole program: a running process keeps the file it started from, and a start finds either build,
 * never neither. Where a hard link cannot be made (a filesystem without them, a file owned by
 * someone else) the old file is moved aside instead, and for a moment the name is empty.
 *
 * It is always a new file under the name, never a write into the old one: on macOS arm64 a page of
 * a signed program that changes under a running process kills it.
 *
 * Windows keeps a running program's file open: it can be given another name, but not be deleted or
 * replaced, and that holds for every name it has. So there the file is always moved aside, whoever
 * is still running it (`eta-host upgrade` following a worker is), and a `.prev` something still
 * runs is moved out of the way to go when that process has (`sweepPrevious`). The same goes for a
 * build being rolled back.
 */
import { execFile } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { chmod, link, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A first run of a large new file on Windows waits for its antivirus to read all of it. */
const TRIAL_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 20_000;
/** An antivirus reading a new file holds it for a moment, and Windows refuses a rename meanwhile. */
const RENAME_TRIES = process.platform === "win32" ? 25 : 1;
const RENAME_RETRY_MS = 200;

async function move(from: string, to: string): Promise<void> {
  for (let tries = 1; ; tries += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (tries === RENAME_TRIES) throw error;
      await sleep(RENAME_RETRY_MS);
    }
  }
}

export const stagedPath = (execPath: string): string => `${execPath}.next`;
export const previousPath = (execPath: string): string => `${execPath}.prev`;

/** Run a staged build once; what it printed. A build that cannot start is an error here. */
export async function tryBuild(
  staged: string,
  args: readonly string[],
): Promise<string> {
  await chmod(staged, 0o755);
  const { stdout } = await run(staged, [...args], {
    timeout: TRIAL_TIMEOUT_MS,
  });
  return stdout.trim();
}

/** The staged build takes the executable's name; the old file stays as `<exe>.prev`. */
export async function swapIn(
  execPath: string,
  windows: boolean = process.platform === "win32",
): Promise<void> {
  const previous = previousPath(execPath);
  await rm(previous, { force: true }).catch(async (error: unknown) => {
    if (!windows) throw error;
    await rename(previous, `${previous}.${process.pid}.old`);
  });
  const linked =
    !windows &&
    (await link(execPath, previous).then(
      () => true,
      () => false,
    ));
  if (!linked) await move(execPath, previous);
  try {
    await move(stagedPath(execPath), execPath);
  } catch (error) {
    if (linked) await rm(previous, { force: true });
    else await move(previous, execPath);
    throw error;
  }
}

/** What `swapIn` moved aside on Windows and whatever ran it has let go of by now. */
export function sweepPrevious(execPath: string): void {
  const dir = dirname(execPath);
  const stale = `${basename(previousPath(execPath))}.`;
  for (const file of readdirSync(dir)) {
    if (!file.startsWith(stale) || !file.endsWith(".old")) continue;
    try {
      rmSync(join(dir, file), { force: true });
    } catch {
      // Still running: the next upgrade looks again.
    }
  }
}

/**
 * `<exe>.prev` takes the executable's name again. On Windows the failed build goes first: something
 * can hold a file that has just run for longer than is worth waiting, and being moved out of the
 * way, unlike being replaced, is what a held file allows.
 */
export async function swapBack(
  execPath: string,
  windows: boolean = process.platform === "win32",
): Promise<void> {
  const previous = previousPath(execPath);
  if (windows) await move(execPath, `${previous}.${process.pid}.failed.old`);
  await move(previous, execPath);
}
