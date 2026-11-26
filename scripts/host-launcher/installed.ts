/**
 * The host the app runs, and the one it does not.
 *
 * The app and its host have versions of their own. The app carries no host: the first time it
 * runs one here it downloads it into `~/.eta/desktop/host/` (`download.ts`), and runs it from there
 * from then on. That file is the one the host's upgrade replaces, keeping the build before it
 * beside it as `eta-host.prev` (`apps/daemon/src/swap.ts`). Nothing in the app's bundle changes,
 * which a signature would not survive, and a newer app leaves the host alone: the host is updated
 * from Settings.
 *
 * A host that already serves `~/.eta` (the command line's service, or another start) is opened
 * rather than joined by a second one over the same database; it is not this app's to restart or
 * upgrade.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

/** A host to open: where it answers and the token it wants, empty when it has none. */
export interface RemoteTarget {
  address: string;
  token: string;
}

/** Where the app keeps the host it runs. */
export const hostHome = (home: string): string =>
  join(home, ".eta", "desktop", "host");

/**
 * The host serving `~/.eta` by its own say (`running-host.json`, `apps/eta/src/running.ts`): alive
 * and answering `/up`. What the app asks before it has a host file to ask `eta-host running`, so a
 * running host is opened rather than downloaded for. A service from before the record is not seen
 * here; once downloaded, the host file finds it.
 */
export async function recordedHost(
  dataDir: string,
): Promise<RemoteTarget | undefined> {
  let record: {
    pid: number;
    hostname: string;
    port: number;
    tokenFile: string | null;
  };
  try {
    record = JSON.parse(
      await readFile(join(dataDir, "running-host.json"), "utf8"),
    ) as typeof record;
    process.kill(record.pid, 0);
  } catch {
    return undefined;
  }
  let host = record.hostname;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.includes(":")) host = `[${host}]`;
  const address = `http://${host}:${String(record.port)}`;
  const up = await fetch(`${address}/up`, {
    signal: AbortSignal.timeout(3000),
  }).then(
    (answer) => answer.ok,
    () => false,
  );
  if (!up) return undefined;
  const token =
    record.tokenFile === null
      ? ""
      : (await readFile(record.tokenFile, "utf8").catch(() => "")).trim();
  return { address, token };
}
