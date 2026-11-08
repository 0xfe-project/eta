/**
 * The app updating itself, when the user asks and only then.
 *
 * Electrobun's Updater does the work (`Updater` in `electrobun/main`): the update address is
 * `release.baseUrl`, which the build writes into the bundle's `version.json`
 * (`ETA_DESKTOP_UPDATE_URL`, `electrobun.config.ts`); checking reads
 * `<baseUrl>/<channel>-<os>-<arch>-update.json`; downloading takes the chain of bsdiff patches from
 * this build's hash when there is one and the whole `.tar.zst` when there is not, and checks what it
 * prepared; applying hands over to a helper that replaces the bundle once this process has quit, and
 * starts the new one. A build without an address has no updates, and the page is not offered them.
 *
 * Three things are this file's own:
 * - **Never on its own.** Nothing here runs on a timer or at launch; each step is a press of a
 *   button on the page (`apps/web/src/components/workspace/desktop-update.tsx`).
 * - **Only forward.** The Updater calls any other build an update; this one only a newer version.
 * - **The host first.** Applying quits the app, and the app's quit stops the local host first
 *   (`index.ts`), which would refuse the Updater's quit. So the host is stopped before, and if the
 *   update does not go ahead after all it is started again: the old app goes on as it was.
 */
import type {
  ShellUpdateState,
  ShellUpdateView,
} from "@eta/client-contracts/desktop";
import { compareVersions } from "@eta/client-contracts/desktop";

/** What this needs of Electrobun's Updater; the real one is passed in by `index.ts`. */
export interface UpdaterLike {
  checkForUpdate: () => Promise<{
    version: string;
    updateAvailable: boolean;
    error: string;
  }>;
  downloadUpdate: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  updateInfo: () => { updateReady: boolean; error: string };
  onStatusChange: (
    callback:
      | ((entry: {
          status: string;
          message: string;
          details?: { progress?: number; errorMessage?: string };
        }) => void)
      | null,
  ) => void;
}

export interface ShellUpdateOptions {
  updater: UpdaterLike;
  /** This build's version. */
  current: string;
  /** Stop what quitting would: the local host. */
  beforeApply: () => Promise<void>;
  /** The update did not go ahead: bring back what `beforeApply` stopped. */
  afterFailedApply: () => Promise<void>;
}

export interface ShellUpdate {
  view: () => ShellUpdateView;
  check: () => Promise<ShellUpdateView>;
  download: () => Promise<ShellUpdateView>;
  apply: () => Promise<ShellUpdateView>;
}

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createShellUpdate(options: ShellUpdateOptions): ShellUpdate {
  const { updater, current } = options;
  let state: ShellUpdateState = { state: "idle" };
  let lastStatus = "";
  let lastError = "";

  updater.onStatusChange((entry) => {
    lastStatus = entry.status;
    if (entry.status === "error")
      lastError = entry.details?.errorMessage ?? entry.message;
    if (
      state.state === "downloading" &&
      entry.status === "download-progress" &&
      typeof entry.details?.progress === "number"
    )
      state = { ...state, progress: entry.details.progress };
  });

  const view = (): ShellUpdateView => ({ ...state, current });
  const busy = () =>
    state.state === "checking" ||
    state.state === "downloading" ||
    state.state === "applying";

  return {
    view,

    async check() {
      if (busy()) return view();
      state = { state: "checking" };
      try {
        const info = await updater.checkForUpdate();
        if (info.error !== "") throw new Error(info.error);
        const newer =
          info.updateAvailable &&
          (compareVersions(info.version, current) ?? 0) > 0;
        state = newer
          ? { state: "available", version: info.version }
          : { state: "current" };
      } catch (error) {
        state = { state: "failed", during: "check", error: reason(error) };
      }
      return view();
    },

    async download() {
      if (state.state !== "available") return view();
      const { version } = state;
      state = { state: "downloading", version };
      lastError = "";
      try {
        await updater.downloadUpdate();
        const info = updater.updateInfo();
        if (!info.updateReady)
          throw new Error(info.error || lastError || "the update is not ready");
        state = { state: "ready", version };
      } catch (error) {
        state = { state: "failed", during: "download", error: reason(error) };
      }
      return view();
    },

    async apply() {
      if (state.state !== "ready") return view();
      const { version } = state;
      state = { state: "applying", version };
      lastStatus = "";
      lastError = "";
      try {
        await options.beforeApply();
        await updater.applyUpdate();
      } catch (error) {
        lastError = reason(error);
      }
      // Handed over: the app is quitting and the helper starts the new one.
      if (lastStatus === "launching-new-version") return view();
      state = {
        state: "failed",
        during: "apply",
        error: lastError || "the update did not start",
      };
      await options.afterFailedApply().catch(() => undefined);
      return view();
    },
  };
}
