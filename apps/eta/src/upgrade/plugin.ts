/**
 * The `upgrade` target, and `/upgrade/status`: what the page's update button stands on.
 *
 * The actions go over the socket like any other, and are the user's: nothing an agent has reaches
 * them. The status is plain HTTP on purpose. The socket is the first thing to go in a restart and
 * the last to come back, while a page that polls this address needs nothing but an answer or the
 * lack of one, and it is the one thing that can tell a host restarting from an upgrade that ended.
 */
import type {
  UpgradeBlock,
  UpgradeBusy,
  UpgradeCheckView,
  UpgradeResults,
} from "@eta/client-contracts";
import type { HostService } from "./service";
import { realpathSync } from "node:fs";
import process from "node:process";
import { COMPILED } from "../resources";
import { VERSION } from "../version";
import { Args, productPlugin } from "../wire";
import { Releases } from "./releases";
import { findHostService } from "./service";
import { readStatus } from "./status";
import { versionOrder } from "./upgrade";
import { cancelWorker, startWorker } from "./worker";

const STATUS_PATH = "/upgrade/status";
/** What the page's button gives agents to end before it gives up, as the command line does. */
const WAIT_MINUTES = 10;

export interface UpgradePluginOptions {
  dataDir: string;
  /** What a restart would stop. */
  busy: () => UpgradeBusy[];
  /** The rest is here for a test. */
  version?: string;
  compiled?: boolean;
  execPath?: string;
  releases?: Pick<Releases, "latest">;
  findService?: () => Promise<HostService | undefined>;
  start?: typeof startWorker;
  cancel?: typeof cancelWorker;
}

function sameFile(one: string, other: string): boolean {
  try {
    return realpathSync(one) === realpathSync(other);
  } catch {
    return false;
  }
}

/** Only a compiled host that its own running service runs can be restarted from the page. */
async function blockedBy(
  options: UpgradePluginOptions,
): Promise<{ blocked: UpgradeBlock | null; service?: HostService }> {
  if (!(options.compiled ?? COMPILED)) return { blocked: "source" };
  const service = await (options.findService ?? findHostService)();
  const status = await service?.status();
  if (service === undefined || status?.running !== true)
    return { blocked: "no-service" };
  return sameFile(service.program, options.execPath ?? process.execPath)
    ? { blocked: null, service }
    : { blocked: "other-file" };
}

async function check(options: UpgradePluginOptions): Promise<UpgradeCheckView> {
  const version = options.version ?? VERSION;
  const { blocked } = await blockedBy(options).catch(() => ({
    blocked: "no-service" as const,
  }));
  const releases =
    options.releases ??
    new Releases(
      process.env.ETA_RELEASES_URL ? { url: process.env.ETA_RELEASES_URL } : {},
    );
  try {
    const latest = (await releases.latest()).version;
    const order = versionOrder(latest, version);
    return {
      version,
      latest,
      available: latest !== version && (order === undefined || order > 0),
      blocked,
      busy: options.busy(),
      error: null,
    };
  } catch (error) {
    return {
      version,
      latest: null,
      available: false,
      blocked,
      busy: options.busy(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function upgradePlugin(
  options: UpgradePluginOptions,
  applied: () => void,
) {
  return productPlugin(
    "upgrade",
    ({ wire }) => {
      const offs = [
        wire.handle("upgrade", "check", async () => ({
          result: await check(options),
        })),
        wire.handle("upgrade", "start", async (call) => {
          const force = new Args(call).optionalBoolean("force") === true;
          const { blocked, service } = await blockedBy(options);
          if (service === undefined)
            throw new Error(`this host cannot upgrade itself: ${blocked}`);
          const id = await (options.start ?? startWorker)({
            dataDir: options.dataDir,
            program: service.program,
            from: options.version ?? VERSION,
            force,
            waitMinutes: WAIT_MINUTES,
          });
          const result: UpgradeResults["start"] = { id };
          return { result };
        }),
        wire.handle("upgrade", "cancel", async () => {
          const cancelled = await (options.cancel ?? cancelWorker)(
            options.dataDir,
          );
          const result: UpgradeResults["cancel"] = { cancelled };
          return { result };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}

/** Behind the same token as the page, like everything but `/up`. */
export function upgradeRoutes(
  request: Request,
  dataDir: string,
): Response | undefined {
  if (new URL(request.url).pathname !== STATUS_PATH) return undefined;
  return Response.json(readStatus(dataDir) ?? null, {
    headers: { "cache-control": "no-store" },
  });
}
