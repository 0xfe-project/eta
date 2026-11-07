/**
 * The host the app runs, and the one it does not.
 *
 * The app and its host have versions of their own. The host the app carries (`host/` in the
 * bundle) is only a seed: the first launch copies it to `~/.eta/desktop/host/`, and the app runs it
 * from there from then on. That file is the one the host's upgrade replaces, keeping the build
 * before it beside it as `eta-host.prev` (`apps/daemon/src/swap.ts`), and nothing in the app's
 * bundle changes, which a signature would not survive. A newer app does not put its seed over a
 * host that is already there: the host is updated from Settings, or by the next seed once the
 * user's copy is gone.
 *
 * A host that already serves `~/.eta` (the command line's service, or another start) is opened
 * rather than joined by a second one over the same database; it is not this app's to restart or
 * upgrade. The host's file is what is asked (`eta-host running`), so the app knows of every kind of
 * service the host does.
 */
import type { RemoteTarget } from "./remote";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";

const RUNNING_TIMEOUT_MS = 15_000;

/** Where the app keeps the host it runs. */
export const hostHome = (home: string): string =>
  join(home, ".eta", "desktop", "host");

/** The host to run: the copy in `dir`, made from `seed` first if there is none. */
export async function installHost(seed: string, dir: string): Promise<string> {
  const file = join(dir, basename(seed));
  if (existsSync(file)) return file;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Whole or not at all: a launch that dies halfway leaves a part, never a broken host.
  const part = `${file}.${String(process.pid)}.part`;
  await copyFile(seed, part);
  await chmod(part, 0o755);
  await rename(part, file);
  return file;
}

/** What `eta-host running` prints. */
interface Running {
  address: string;
  tokenFile: string | null;
}

/**
 * The host already serving the data directory, as somewhere to open; undefined when there is none,
 * or when asking does not work, which is the same as before this was asked.
 */
export async function runningHost(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RemoteTarget | undefined> {
  let output: string;
  try {
    const child = Bun.spawn(command, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), RUNNING_TIMEOUT_MS);
    output = await new Response(child.stdout).text();
    clearTimeout(timer);
    if ((await child.exited) !== 0) return undefined;
  } catch {
    return undefined;
  }
  // The last line: anything a build prints before its answer is not the answer.
  const line = output.trim().split("\n").at(-1) ?? "";
  let found: Running | null;
  try {
    found = JSON.parse(line) as Running | null;
  } catch {
    return undefined;
  }
  if (found === null || typeof found.address !== "string") return undefined;
  const token =
    found.tokenFile === null
      ? ""
      : (await readFile(found.tokenFile, "utf8").catch(() => "")).trim();
  return { address: found.address, token };
}
