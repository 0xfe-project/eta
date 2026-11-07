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
import type { Probe, RemoteFailure, RemoteTarget } from "./remote";
import { parseConnectLink } from "@eta/client-contracts/connect-link";
import { hostOrigin } from "./connection";
import { remotePage } from "./remote";

export type Failure =
  | { reason: RemoteFailure; detail?: string }
  /** The host on screen stopped answering. */
  | { reason: "lost"; detail?: undefined }
  /** The local host did not start: `detail` says why. */
  | { reason: "host"; detail: string };

/** What starting the local host came to. */
export type HostLaunch =
  | { ready: true; page: string; port?: number; external?: RemoteTarget }
  | { ready: false; reason: string };

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
  | { screen: "failure"; connection: Connection; failure: Failure };

export type Choice = { mode: "local" } | ({ mode: "remote" } & HostAddress);

interface ShellDependencies {
  read: () => Promise<Connection | undefined>;
  save: (connection: Connection) => Promise<void>;
  startHost: () => Promise<HostLaunch>;
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

  const fail = (at: Connection, failure: Failure) => {
    stopWatching();
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
      const launch = await deps.startHost();
      if (!launch.ready) return { reason: "host", detail: launch.reason };
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
      if (failure !== undefined) fail(saved, failure);
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

    /** The failure screen's 重试. */
    async retry(): Promise<Failure | undefined> {
      return connection === undefined ? undefined : await enter(connection);
    },

    /** From 设置 or the failure screen. The page behind it stays as it was until a choice works. */
    openChooser(language?: string): void {
      if (view === undefined || view.screen === "choose") return;
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
