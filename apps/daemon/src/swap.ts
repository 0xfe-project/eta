/**
 * Replacing the file of a program that may be running, which the daemon and the host both do.
 *
 * The new build is staged beside the executable (`<exe>.next`), so the swap is a rename on one
 * filesystem; it is run once (`tryBuild`) to see that it starts and says what it should; then
 * `swapIn` keeps the file as `<exe>.prev` and renames the new one over it. The name always holds a
 * whole program: a running process keeps the file it started from, and a start finds either build,
 * never neither. Where a hard link cannot be made (a filesystem without them, a file owned by
 * someone else) the old file is moved aside instead, and for a moment the name is empty.
 */
import { execFile } from "node:child_process";
import { chmod, link, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export const stagedPath = (execPath: string): string => `${execPath}.next`;
export const previousPath = (execPath: string): string => `${execPath}.prev`;

/** Run a staged build once; what it printed. A build that cannot start is an error here. */
export async function tryBuild(
  staged: string,
  args: readonly string[],
): Promise<string> {
  await chmod(staged, 0o755);
  const { stdout } = await run(staged, [...args], { timeout: 20_000 });
  return stdout.trim();
}

/** The staged build takes the executable's name; the old file stays as `<exe>.prev`. */
export async function swapIn(execPath: string): Promise<void> {
  const previous = previousPath(execPath);
  await rm(previous, { force: true });
  const linked = await link(execPath, previous).then(
    () => true,
    () => false,
  );
  if (!linked) await rename(execPath, previous);
  try {
    await rename(stagedPath(execPath), execPath);
  } catch (error) {
    if (linked) await rm(previous, { force: true });
    else await rename(previous, execPath);
    throw error;
  }
}

/** `<exe>.prev` takes the executable's name again. */
export const swapBack = (execPath: string): Promise<void> =>
  rename(previousPath(execPath), execPath);
