import type {
  AppUpdate,
  PackageUpdate,
  ShellInfo,
  UpdateProgress,
} from "nsh/updater";
import { openUrl, platform, signal, Storage } from "nsh";
import {
  checkForPackage,
  checkForUpdate,
  downloadPackage,
  downloadUpdate,
  installAndRestart,
  runningPackage,
  shellInfo,
} from "nsh/updater";
import { startProgress } from "../components/progress-notification";
import { uiText } from "../i18n";
import { problemText } from "./problem-text";

/** The update channels a release build names in `nsh.json`'s
 * `updater.channels` (scripts/nsh-client.ts): an rc build is only on `rc`, a
 * full release on both. */
export type ClientChannel = "stable" | "rc";

/** What the app can do about a newer release.
 * - `package`: a signed package of the app's code (Android): it downloads and
 *   runs from the app's next start.
 * - `app`: the whole app. On the desktop it downloads and replaces the app;
 *   on Android `url` is the APK, which the system installs. */
export type ClientOffer =
  | { kind: "package"; version: string; build: number; notes?: string | null }
  | { kind: "app"; version: string; update: AppUpdate };

const channelKey = "eta.client.update.channel";
const dismissedKey = "eta.client.update.dismissed";

function describe(error: unknown) {
  return problemText(error);
}

function readShell(): ShellInfo | undefined {
  try {
    return shellInfo();
  } catch {
    return undefined;
  }
}

const desktop = ["macos", "linux", "windows"].includes(platform.os);
const android = platform.os === "android" && platform.name !== "harmonyos";
const shell = readShell();

/** A release build that knows where its updates are: `nsh.json` has
 * `"updater"` only in builds made with ETA_CLIENT_UPDATE_URL, never in
 * development runs or on the web, where `shellInfo().version` is null. */
export const clientUpdatable = (desktop || android) && !!shell?.version;
/** The desktops replace the app and restart it; Android runs a package from
 * its next start and leaves an APK to the system. */
export const clientPlatform: "desktop" | "android" | undefined =
  !clientUpdatable ? undefined : desktop ? "desktop" : "android";

/** The version this run's code is: a package's when one runs, else the
 * installed app's. */
export function clientVersion() {
  return runningPackage()?.version ?? shell?.version ?? undefined;
}

/** A prerelease build starts on the rc channel, a full release on stable. */
function defaultChannel(): ClientChannel {
  return shell?.version?.includes("-") ? "rc" : "stable";
}

function createClientUpdate() {
  const channel = signal<ClientChannel>(defaultChannel());
  const offer = signal<ClientOffer | undefined>(undefined);
  const checking = signal(false);
  const checked = signal(false);
  const progress = signal<UpdateProgress | undefined>(undefined);
  const downloading = signal(false);
  /** The offer is downloaded: the desktop can restart into it, Android runs
   * it from its next start. */
  const ready = signal(false);
  const restarting = signal(false);
  const failure = signal("");
  /** The version whose notice the user closed; the settings still show it. */
  const dismissed = signal<string | undefined>(undefined);
  let started = false;

  const busy = () => checking() || downloading() || restarting();

  async function check() {
    if (!clientUpdatable || busy()) return;
    checking.set(true);
    failure.set("");
    const asked = channel();
    try {
      const next = await find();
      if (channel() === asked) {
        // A download already made stays usable while the offer is the same.
        if (next?.version !== offer()?.version || next?.kind !== offer()?.kind)
          ready.set(false);
        offer.set(next);
        checked.set(true);
      }
    } catch (error) {
      if (channel() === asked) failure.set(describe(error));
    } finally {
      checking.set(false);
    }
    // A channel changed meanwhile asks again, for its own offer.
    if (channel() !== asked) await check();
  }

  async function find(): Promise<ClientOffer | undefined> {
    // Android: a package needs no new APK, so it comes first. Packages come
    // from the build's own channel (nsh has no channel for them).
    if (android && shell?.packages) {
      const found: PackageUpdate | null = await checkForPackage();
      if (found)
        return {
          kind: "package",
          version: found.version,
          build: found.build,
          notes: found.notes,
        };
    }
    const update = await checkForUpdate(
      desktop ? { channel: channel() } : undefined,
    );
    // `shell`: the code already is this release, only the APK is behind.
    // Nothing a user needs to act on, so it is not offered.
    if (!update || update.shell) return undefined;
    return { kind: "app", version: update.version, update };
  }

  async function download() {
    const current = offer();
    if (!current || busy() || ready()) return;
    failure.set("");
    if (current.kind === "app" && !current.update.canInstall) {
      // Android's APK: the system downloads and installs it.
      try {
        const { opened } = await openUrl(current.update.url);
        if (!opened) failure.set(uiText("appUpdateNotOpened"));
      } catch (error) {
        failure.set(describe(error));
      }
      return;
    }
    downloading.set(true);
    const note = startProgress({
      id: "client-update",
      icon: "download",
      title: uiText("downloadUpdate"),
      detail: current.version,
    });
    const onProgress = (next: UpdateProgress) => {
      progress.set(next);
      note.update({
        progress: next.total ? next.received / next.total : undefined,
      });
    };
    try {
      if (current.kind === "package") await downloadPackage(onProgress);
      else await downloadUpdate(onProgress);
      ready.set(true);
      note.complete({
        title: uiText("appUpdateReady", { version: current.version }),
        detail:
          current.kind === "package"
            ? uiText("reopenEtaToUse", { version: current.version })
            : uiText("restartToUpdate"),
        showWhenQuick: true,
      });
    } catch (error) {
      const message = describe(error);
      failure.set(message);
      note.fail({
        title: uiText("downloadUpdate"),
        detail: message,
        onRetry: () => void download(),
      });
    } finally {
      progress.set(undefined);
      downloading.set(false);
    }
  }

  /** Desktop: replaces the app and opens the new one; settles only when it
   * failed, leaving the app as it was. */
  async function restart() {
    if (!ready() || busy() || offer()?.kind !== "app") return;
    restarting.set(true);
    failure.set("");
    try {
      await installAndRestart();
    } catch (error) {
      failure.set(describe(error));
    } finally {
      restarting.set(false);
    }
  }

  function changeChannel(next: ClientChannel) {
    if (next === channel()) return;
    channel.set(next);
    void Storage.setItem(channelKey, next).catch(() => {});
    if (!ready()) {
      offer.set(undefined);
      checked.set(false);
      void check();
    }
  }

  function dismiss() {
    const version = offer()?.version;
    dismissed.set(version);
    if (version) void Storage.setItem(dismissedKey, version).catch(() => {});
  }

  /** Once per run, after the app has settled; quietly, as nothing asked. */
  function start(delay = 4000) {
    if (started || !clientUpdatable) return;
    started = true;
    void Promise.all([
      Storage.getItem(channelKey).catch(() => null),
      Storage.getItem(dismissedKey).catch(() => null),
    ]).then(([storedChannel, storedDismissed]) => {
      if (storedChannel === "stable" || storedChannel === "rc")
        channel.set(storedChannel);
      if (storedDismissed) dismissed.set(storedDismissed);
      setTimeout(() => void check(), delay);
    });
  }

  const percentage = () => {
    const current = progress();
    return current?.total
      ? Math.min(100, Math.round((100 * current.received) / current.total))
      : undefined;
  };

  /** The notice shows a found offer until the user closes it for that
   * version, or while its download or restart runs. */
  const notice = () => {
    const current = offer();
    if (!current) return undefined;
    if (dismissed() === current.version && !downloading() && !ready())
      return undefined;
    return current;
  };

  return {
    channel,
    offer,
    checking,
    checked,
    progress,
    percentage,
    downloading,
    ready,
    restarting,
    failure,
    busy,
    notice,
    check,
    download,
    restart,
    changeChannel,
    dismiss,
    start,
  };
}

/** One per app: the notice and the settings page show the same state. */
export const clientUpdate = createClientUpdate();
