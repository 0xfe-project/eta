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
  UpgradeTokenView,
  UpgradeUpstreamSource,
  UpgradeUpstreamView,
} from "@eta/client-contracts";
import type { SettingStore } from "../inbox/setting";
import type { HostService } from "./service";
import process from "node:process";
import { COMPILED } from "../resources";
import { loadSecretKey } from "../secret";
import { VERSION } from "../version";
import { Args, productPlugin } from "../wire";
import { Releases, releaseToken } from "./releases";
import { findHostService, sameFile } from "./service";
import { readStatus } from "./status";
import {
  cleanToken,
  openToken,
  sealToken,
  TOKEN_SETTING,
  tokenHost,
} from "./token";
import { versionOrder } from "./upgrade";
import {
  BUILT_UPSTREAM,
  chooseUpstream,
  parseUpstream,
  UPSTREAM_SETTING,
  upstreamLabel,
} from "./upstream";
import { cancelWorker, startWorker } from "./worker";

const STATUS_PATH = "/upgrade/status";
/** What the page's button gives agents to end before it gives up, as the command line does. */
const WAIT_MINUTES = 10;

export interface UpgradePluginOptions {
  dataDir: string;
  /** What a restart would stop. */
  busy: () => UpgradeBusy[];
  settings: Pick<SettingStore, "get" | "set" | "delete">;
  /** The rest is here for a test. */
  version?: string;
  compiled?: boolean;
  execPath?: string;
  platform?: NodeJS.Platform;
  releases?: Pick<Releases, "latest">;
  findToken?: typeof releaseToken;
  findService?: () => Promise<HostService | undefined>;
  start?: typeof startWorker;
  cancel?: typeof cancelWorker;
}

/** The desktop app's host is in the app: a service is not the way for it, on any platform. */
const noService = (options: UpgradePluginOptions): UpgradeBlock =>
  (options.platform ?? process.platform) === "win32" &&
  process.env.ETA_DESKTOP_SUMMARY === undefined
    ? "no-windows-service"
    : "no-service";

/** Only a compiled host that its own running service runs can be restarted from the page. */
async function blockedBy(
  options: UpgradePluginOptions,
): Promise<{ blocked: UpgradeBlock | null; service?: HostService }> {
  if (!(options.compiled ?? COMPILED)) return { blocked: "source" };
  const service = await (options.findService ?? findHostService)();
  const status = await service?.status();
  if (service === undefined || status?.running !== true)
    return { blocked: noService(options) };
  return sameFile(service.program, options.execPath ?? process.execPath)
    ? { blocked: null, service }
    : { blocked: "other-file" };
}

/** Which upstream counts here, and what the page needs to say about it. */
function currentUpstream({ settings }: UpgradePluginOptions): {
  text: string;
  view: UpgradeUpstreamView;
} {
  const stored = settings.get(UPSTREAM_SETTING);
  const saved = typeof stored === "string" ? stored : undefined;
  const { source, text } = chooseUpstream({ saved });
  return {
    text,
    view: {
      label: upstreamLabel(text),
      // `chooseUpstream` only says `flag` when given one, and no page can.
      source: source as UpgradeUpstreamSource,
      saved: saved === undefined ? null : upstreamLabel(saved),
      fallback: upstreamLabel(BUILT_UPSTREAM),
    },
  };
}

async function check(options: UpgradePluginOptions): Promise<UpgradeCheckView> {
  const version = options.version ?? VERSION;
  const { blocked } = await blockedBy(options).catch(() => ({
    blocked: noService(options),
  }));
  const { text, view: upstream } = currentUpstream(options);
  const stored = options.settings.get(TOKEN_SETTING);
  const token: UpgradeTokenView = {
    host: null,
    from: null,
    saved: tokenHost(stored) ?? null,
  };
  try {
    const parsed = parseUpstream(text);
    if (parsed.kind !== "other") token.host = parsed.host;
    const found = await (options.findToken ?? releaseToken)(
      parsed,
      process.env,
      stored === undefined
        ? undefined
        : openToken(loadSecretKey(options.dataDir), stored),
    );
    token.from = found.from ?? null;
    const releases =
      options.releases ??
      new Releases({ upstream: text, token: () => Promise.resolve(found) });
    const latest = (await releases.latest()).version;
    const order = versionOrder(latest, version);
    return {
      version,
      latest,
      available: latest !== version && (order === undefined || order > 0),
      blocked,
      busy: options.busy(),
      upstream,
      token,
      error: null,
    };
  } catch (error) {
    return {
      version,
      latest: null,
      available: false,
      blocked,
      busy: options.busy(),
      upstream,
      token,
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
        wire.handle("upgrade", "setUpstream", async (call) => {
          const given = new Args(call).optionalString("upstream");
          if (given === undefined) options.settings.delete(UPSTREAM_SETTING);
          else options.settings.set(UPSTREAM_SETTING, parseUpstream(given).api);
          const result: UpgradeResults["setUpstream"] =
            currentUpstream(options).view;
          return { result };
        }),
        wire.handle("upgrade", "setToken", async (call) => {
          const given = new Args(call).optionalString("token");
          const { settings, dataDir } = options;
          if (given === undefined) settings.delete(TOKEN_SETTING);
          else {
            const { host, kind } = parseUpstream(currentUpstream(options).text);
            if (kind === "other")
              throw new Error(
                "this upstream is not GitHub: it takes ETA_RELEASES_TOKEN",
              );
            const token = cleanToken(given);
            const key = loadSecretKey(dataDir);
            settings.set(TOKEN_SETTING, sealToken(key, { host, token }));
          }
          const result: UpgradeResults["setToken"] = {
            saved: tokenHost(settings.get(TOKEN_SETTING)) ?? null,
          };
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
