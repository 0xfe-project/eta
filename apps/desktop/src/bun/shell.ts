/**
 * What the window shows, and the order things happen when that changes.
 *
 * `index.ts` owns the window and the host process; this owns the decisions, so they can be tested
 * without either. The rules that matter:
 *
 * - **Remote never starts the local host.** `reach` is the only caller of `startHost`, and only
 *   for a local connection.
 * - **A new place is reached before the old one is left.** Saving, stopping the local host and
 *   replacing the window all come after the new one answered, so a typo costs nothing.
 * - **The local host keeps running while the connection page is open.** Going back is immediate,
 *   and nothing has changed until the user picks something that works.
 * - **The token stops here.** `describe` is all a page ever hears about the connection.
 * - **A host already running here is opened, not joined.** `startHost` may answer with one that
 *   serves the same data (`installed.ts`); it is watched like a remote host, and when it goes the
 *   next try starts over, which may start the app's own.
 */
import type { HostAddress } from "@eta/client-contracts/connect-link";
import type { Connection } from "./connection";
import type { DownloadFailure, DownloadProgress } from "./download";
import type { Probe, RemoteFailure, RemoteTarget } from "./remote";
import { parseConnectLink } from "@eta/client-contracts/connect-link";
import { hostOrigin } from "./connection";
import { remotePage } from "./remote";

export type Failure =
  | { reason: RemoteFailure; detail?: string }
  /** The host on screen stopped answering. */
  | { reason: "lost"; detail?: undefined }
  /** The local host did not start: `detail` says why. */
  | { reason: "host"; detail: string }
  /** There is no local host, and getting one did not work. */
  | {
      reason: "download";
      detail: string;
      kind: DownloadFailure["kind"];
      tokenless: boolean;
    };

/** What starting the local host came to. */
export type HostLaunch =
  | { ready: true; page: string; port?: number; external?: RemoteTarget }
  | { ready: false; reason: string; download?: DownloadFailure };

export interface PageView {
  screen: "page";
  page: string;
  port?: number;
  connection: Connection;
  /** A local host the app did not start: where it is, to watch it. */
  external?: RemoteTarget;
}

export type View =
  | PageView
  | {
      screen: "choose";
      connection: Connection | undefined;
      /** What 返回 goes back to; a first launch has nothing to go back to. */
      returnTo: PageView | Extract<View, { screen: "failure" }> | undefined;
      language: string | undefined;
    }
  | { screen: "failure"; connection: Connection; failure: Failure }
  /** The local host is being downloaded; `progress` moves without the view being shown again. */
  | {
      screen: "download";
      connection: Connection;
      progress: DownloadProgress | undefined;
    };

export type Choice = { mode: "local" } | ({ mode: "remote" } & HostAddress);

interface ShellDependencies {
  read: () => Promise<Connection | undefined>;
  save: (connection: Connection) => Promise<void>;
  /** Start the local host; `onProgress` hears a download, when there has to be one first. */
  startHost: (
    onProgress: (progress: DownloadProgress) => void,
  ) => Promise<HostLaunch>;
  stopHost: () => Promise<void>;
  probe: (target: RemoteTarget) => Promise<Probe>;
  /** Start watching a remote host; the answer stops it. */
  watch: (
    target: RemoteTarget,
    onLost: (failure: "lost" | "token") => void,
  ) => () => void;
  show: (view: View) => void;
}

/** What a page may know: where, never how to get in. */
export function describe(view: View) {
  const { connection } = view;
  return {
    screen: view.screen,
    connection:
      connection === undefined
        ? null
        : {
            mode: connection.mode,
            address:
              connection.mode === "remote" ? connection.address : undefined,
            hasToken: connection.mode === "remote" && connection.token !== "",
          },
    failure: view.screen === "failure" ? view.failure : null,
    progress: view.screen === "download" ? (view.progress ?? null) : null,
    canReturn: view.screen === "choose" && view.returnTo !== undefined,
    language: view.screen === "choose" ? view.language : undefined,
  };
}

export function createShell(deps: ShellDependencies) {
  let connection: Connection | undefined;
  let local: PageView | undefined;
  let view: View | undefined;
  let stopWatching = () => {};

  const show = (next: View) => {
    view = next;
    deps.show(next);
  };

  // What 重试 tries again: the connection that failed, even one never reached before.
  const fail = (at: Connection, failure: Failure) => {
    stopWatching();
    connection = at;
    show({ screen: "failure", connection: at, failure });
  };

  function showPage(page: PageView) {
    stopWatching();
    const { connection: at } = page;
    connection = at;
    const watched = at.mode === "remote" ? at : page.external;
    stopWatching =
      watched === undefined
        ? () => {}
        : deps.watch(watched, (reason) => {
            // Gone is gone: the next try asks again what runs here.
            if (page === local) local = undefined;
            fail(at, { reason });
          });
    show(page);
  }

  async function reach(target: Connection): Promise<PageView | Failure> {
    if (target.mode === "local") {
      if (local !== undefined) return local;
      // The download has a page of its own, shown once; what it has got to is read off the view.
      let downloading: Extract<View, { screen: "download" }> | undefined;
      const launch = await deps.startHost((progress) => {
        if (downloading === undefined) {
          stopWatching();
          downloading = { screen: "download", connection: target, progress };
          show(downloading);
        } else downloading.progress = progress;
      });
      if (!launch.ready) {
        const failure: Failure =
          launch.download === undefined
            ? { reason: "host", detail: launch.reason }
            : {
                reason: "download",
                detail: launch.download.detail,
                kind: launch.download.kind,
                tokenless: launch.download.tokenless,
              };
        // On a page of its own, with 重试 and the way to a remote host: the chooser has nowhere to
        // say why this computer cannot run one, and a download's page has gone by now.
        fail(target, failure);
        return failure;
      }
      local = {
        screen: "page",
        page: launch.page,
        ...(launch.port === undefined ? {} : { port: launch.port }),
        connection: target,
        ...(launch.external === undefined ? {} : { external: launch.external }),
      };
      return local;
    }
    const probe = await deps.probe(target);
    if (!probe.ok)
      return {
        reason: probe.failure,
        ...(probe.detail === undefined ? {} : { detail: probe.detail }),
      };
    const reached = { ...target, address: probe.origin };
    return {
      screen: "page",
      page: remotePage(reached),
      connection: reached,
    };
  }

  /** Go to `target` if it answers. On a failure nothing has changed, and the caller says so. */
  async function enter(target: Connection): Promise<Failure | undefined> {
    const reached = await reach(target);
    if ("reason" in reached) return reached;
    await deps.save(reached.connection);
    if (reached.connection.mode === "remote" && local !== undefined) {
      local = undefined;
      await deps.stopHost();
    }
    showPage(reached);
    return undefined;
  }

  return {
    /** The first thing the window shows. */
    async boot(): Promise<void> {
      const saved = await deps.read();
      if (saved === undefined) {
        show({
          screen: "choose",
          connection: undefined,
          returnTo: undefined,
          language: undefined,
        });
        return;
      }
      connection = saved;
      const failure = await enter(saved);
      if (failure !== undefined && view?.screen !== "failure")
        fail(saved, failure);
    },

    current: (): View | undefined => view,

    /** From the connection page. A failure is the page's to show: nothing else moved. */
    async choose(choice: Choice): Promise<Failure | undefined> {
      if (choice.mode === "local") return await enter({ mode: "local" });
      const { address, token: typed } =
        parseConnectLink(choice.address) ?? choice;
      const origin = hostOrigin(address);
      if (origin === undefined) return { reason: "address" };
      // An empty token field on the host already saved means "the token you have".
      const token =
        typed.trim() === "" &&
        connection?.mode === "remote" &&
        connection.address === origin
          ? connection.token
          : typed.trim();
      return await enter({ mode: "remote", address: origin, token });
    },

    /** Start the local host again, as after an update of the app that did not go ahead. */
    async restartLocal(): Promise<void> {
      if (connection?.mode !== "local") return;
      local = undefined;
      const failure = await enter(connection);
      if (failure !== undefined && view?.screen !== "failure")
        fail(connection, failure);
    },

    /** The failure screen's 重试. */
    async retry(): Promise<Failure | undefined> {
      return connection === undefined ? undefined : await enter(connection);
    },

    /** From 设置 or the failure screen. The page behind it stays as it was until a choice works. */
    openChooser(language?: string): void {
      // A download runs to its end or its failure; the failure page offers the way out.
      if (
        view === undefined ||
        view.screen === "choose" ||
        view.screen === "download"
      )
        return;
      stopWatching();
      show({
        screen: "choose",
        connection,
        returnTo: view,
        language,
      });
    },

    /** 返回: the page or the failure the chooser was opened from. */
    back(): void {
      if (view?.screen !== "choose" || view.returnTo === undefined) return;
      if (view.returnTo.screen === "page") showPage(view.returnTo);
      else show(view.returnTo);
    },

    close(): void {
      stopWatching();
    },
  };
}
