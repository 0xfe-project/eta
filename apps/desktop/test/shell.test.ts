import type { Connection } from "../src/bun/connection";
import type { DownloadProgress } from "../src/bun/download";
import type { Failure, HostLaunch, View } from "../src/bun/shell";
import { describe, expect, it, vi } from "vitest";
import { createShell, describe as describeView } from "../src/bun/shell";

const REMOTE = {
  mode: "remote",
  address: "https://mac.ts.net",
  token: "secret",
} as const;
const LOCAL_PAGE = "http://127.0.0.1:4000";

function rig(options: { saved?: Connection; failure?: Failure } = {}) {
  const log: string[] = [];
  let saved = options.saved;
  let onLost: ((failure: "lost" | "token") => void) | undefined;
  const views: View[] = [];
  const startHost = vi.fn(
    async (
      _onProgress: (progress: DownloadProgress) => void,
    ): Promise<HostLaunch> => {
      log.push("startHost");
      return { ready: true as const, page: LOCAL_PAGE, port: 4000 };
    },
  );
  const probe = vi.fn(async (target: { address: string }) => {
    log.push(`probe ${target.address}`);
    return options.failure === undefined
      ? { ok: true as const, origin: target.address }
      : {
          ok: false as const,
          failure: options.failure.reason as "unreachable",
        };
  });
  const shell = createShell({
    read: async () => saved,
    save: async (connection) => {
      log.push(`save ${connection.mode}`);
      saved = connection;
    },
    startHost,
    stopHost: async () => {
      log.push("stopHost");
    },
    probe,
    watch: (_target, lost) => {
      log.push("watch");
      onLost = lost;
      return () => {
        log.push("unwatch");
        onLost = undefined;
      };
    },
    show: (view) => {
      log.push(`show ${view.screen}`);
      views.push(view);
    },
  });
  return {
    log,
    probe,
    saved: () => saved,
    shell,
    startHost,
    view: () => views.at(-1),
    lose: (failure: "lost" | "token") => onLost?.(failure),
  };
}

describe("the first launch", () => {
  it("asks, and starts nothing until it is answered", async () => {
    const { log, shell, view } = rig();
    await shell.boot();
    expect(log).toEqual(["show choose"]);
    expect(view()).toMatchObject({ screen: "choose", returnTo: undefined });
  });

  it("is the local app from then on when local is chosen", async () => {
    const { saved, shell, startHost, view } = rig();
    await shell.boot();
    await expect(shell.choose({ mode: "local" })).resolves.toBeUndefined();
    expect(startHost).toHaveBeenCalledTimes(1);
    expect(saved()).toEqual({ mode: "local" });
    expect(view()).toMatchObject({ screen: "page", page: LOCAL_PAGE });
  });
});

describe("a saved remote connection", () => {
  it("never starts the local host", async () => {
    const { shell, startHost, view } = rig({ saved: REMOTE });
    await shell.boot();
    expect(startHost).not.toHaveBeenCalled();
    expect(view()).toMatchObject({
      screen: "page",
      page: "https://mac.ts.net/?token=secret",
    });
  });

  it("does not start it when the host is unreachable either", async () => {
    const { shell, startHost, view } = rig({
      saved: REMOTE,
      failure: { reason: "unreachable" },
    });
    await shell.boot();
    expect(startHost).not.toHaveBeenCalled();
    expect(view()).toMatchObject({
      screen: "failure",
      failure: { reason: "unreachable" },
    });
  });

  it("is watched while it is on screen", async () => {
    const { log, shell } = rig({ saved: REMOTE });
    await shell.boot();
    expect(log).toContain("watch");
  });

  it("shows the shell's page when the host goes away", async () => {
    const { lose, shell, view } = rig({ saved: REMOTE });
    await shell.boot();
    lose("lost");
    expect(view()).toMatchObject({
      screen: "failure",
      connection: REMOTE,
      failure: { reason: "lost" },
    });
  });

  it("goes back to the page when a retry finds the host", async () => {
    const { lose, shell, view } = rig({ saved: REMOTE });
    await shell.boot();
    lose("lost");
    await expect(shell.retry()).resolves.toBeUndefined();
    expect(view()).toMatchObject({ screen: "page" });
  });

  it("keeps the token out of everything a page hears", async () => {
    const { lose, shell, view } = rig({ saved: REMOTE });
    await shell.boot();
    lose("token");
    expect(JSON.stringify(describeView(view()!))).not.toContain("secret");
    shell.openChooser();
    expect(JSON.stringify(describeView(view()!))).not.toContain("secret");
  });
});

describe("changing the connection", () => {
  it("reaches a new host before leaving the local one", async () => {
    const { log, shell } = rig({ saved: { mode: "local" } });
    await shell.boot();
    log.length = 0;
    await shell.choose(REMOTE);
    expect(log).toEqual([
      "probe https://mac.ts.net",
      "save remote",
      "stopHost",
      "watch",
      "show page",
    ]);
  });

  it("changes nothing when the new host does not answer", async () => {
    const { log, saved, shell } = rig({
      saved: { mode: "local" },
      failure: { reason: "token" },
    });
    await shell.boot();
    log.length = 0;
    await expect(shell.choose(REMOTE)).resolves.toMatchObject({
      reason: "token",
    });
    expect(log).toEqual(["probe https://mac.ts.net"]);
    expect(saved()).toEqual({ mode: "local" });
  });

  it("keeps the local host running while the connection page is open", async () => {
    const { log, shell, startHost, view } = rig({ saved: { mode: "local" } });
    await shell.boot();
    shell.openChooser("zh");
    expect(view()).toMatchObject({ screen: "choose", language: "zh" });
    shell.back();
    expect(view()).toMatchObject({ screen: "page", page: LOCAL_PAGE });
    expect(startHost).toHaveBeenCalledTimes(1);
    expect(log).not.toContain("stopHost");
  });

  it("stops watching while the chooser is open, and starts again on the way back", async () => {
    const { lose, shell, view } = rig({ saved: REMOTE });
    await shell.boot();
    shell.openChooser();
    lose("lost");
    expect(view()).toMatchObject({ screen: "choose" });
    shell.back();
    lose("lost");
    expect(view()).toMatchObject({ screen: "failure" });
  });

  it("starts the local host again when coming back to it", async () => {
    const { saved, shell, startHost, view } = rig({
      saved: { mode: "local" },
    });
    await shell.boot();
    await shell.choose(REMOTE);
    await shell.choose({ mode: "local" });
    expect(startHost).toHaveBeenCalledTimes(2);
    expect(saved()).toEqual({ mode: "local" });
    expect(view()).toMatchObject({ screen: "page", page: LOCAL_PAGE });
  });

  it("takes the same link the phone does", async () => {
    const { saved, shell } = rig();
    await shell.boot();
    await shell.choose({
      mode: "remote",
      address:
        "eta://connect?address=https%3A%2F%2Fmac.ts.net&token=from-the-link",
      token: "",
    });
    expect(saved()).toEqual({
      mode: "remote",
      address: "https://mac.ts.net",
      token: "from-the-link",
    });
  });

  it("keeps the saved token when the field is left empty on the same host", async () => {
    const { saved, shell } = rig({ saved: REMOTE });
    await shell.boot();
    await shell.choose({
      mode: "remote",
      address: "https://mac.ts.net/",
      token: "",
    });
    expect(saved()).toEqual(REMOTE);
  });

  it("does not hand one host's token to another", async () => {
    const { saved, shell } = rig({ saved: REMOTE });
    await shell.boot();
    await shell.choose({ mode: "remote", address: "https://other", token: "" });
    expect(saved()).toEqual({
      mode: "remote",
      address: "https://other",
      token: "",
    });
  });

  it("refuses an address that is not one before asking anything", async () => {
    const { probe, shell } = rig();
    await shell.boot();
    await expect(
      shell.choose({ mode: "remote", address: "not a url", token: "" }),
    ).resolves.toEqual({ reason: "address" });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("a local host that does not start", () => {
  it("says why, and can be left", async () => {
    const shell = rig({ saved: { mode: "local" } });
    shell.startHost.mockResolvedValueOnce({
      ready: false,
      reason: "no host",
    } as never);
    await shell.shell.boot();
    expect(shell.view()).toMatchObject({
      screen: "failure",
      failure: { reason: "host", detail: "no host" },
    });
    await shell.shell.choose(REMOTE);
    expect(shell.view()).toMatchObject({ screen: "page" });
  });
});

describe("a host already running here", () => {
  const FOUND = { address: "http://127.0.0.1:8790", token: "" };

  it("is opened and watched like a remote one, and a try after it went asks again", async () => {
    const { log, lose, shell, startHost, view } = rig({
      saved: { mode: "local" },
    });
    startHost.mockImplementationOnce(async () => {
      log.push("startHost");
      return {
        ready: true as const,
        page: `${FOUND.address}/`,
        external: FOUND,
      };
    });
    await shell.boot();
    expect(view()).toMatchObject({ screen: "page", external: FOUND });
    expect(log).toContain("watch");

    lose("lost");
    expect(view()).toMatchObject({
      screen: "failure",
      failure: { reason: "lost" },
    });
    // Gone: the next try does not open the old address from memory.
    await shell.retry();
    expect(startHost).toHaveBeenCalledTimes(2);
    expect(view()).toMatchObject({ screen: "page", page: LOCAL_PAGE });
  });

  it("is not stopped by going remote: it is not the app's", async () => {
    const { log, shell, startHost } = rig({ saved: { mode: "local" } });
    startHost.mockImplementationOnce(async () => ({
      ready: true as const,
      page: `${FOUND.address}/`,
      external: FOUND,
    }));
    await shell.boot();
    await shell.choose({ mode: "remote", address: REMOTE.address, token: "x" });
    // `stopHost` is called, and stops nothing: the app holds no process for a host it found.
    expect(log).toContain("stopHost");
  });
});

describe("a host that has to be downloaded first", () => {
  const progress = (received: number) => ({
    version: "0.3.0",
    received,
    total: 100,
  });

  it("has a page of its own, shown once, that the progress moves on", async () => {
    const { log, shell, startHost, view } = rig();
    let seen: View | undefined;
    startHost.mockImplementationOnce(async (onProgress) => {
      onProgress(progress(0));
      seen = view();
      onProgress(progress(60));
      expect(describeView(seen as View).progress).toEqual(progress(60));
      return { ready: true as const, page: LOCAL_PAGE, port: 4000 };
    });
    await shell.boot();
    await shell.choose({ mode: "local" });
    expect(log.filter((line) => line === "show download")).toHaveLength(1);
    expect(seen).toMatchObject({ screen: "download" });
    expect(view()).toMatchObject({ screen: "page", page: LOCAL_PAGE });
  });

  it("says why it failed on a page that offers another try and the other way", async () => {
    const { shell, startHost, view } = rig();
    startHost.mockImplementationOnce(async (onProgress) => {
      onProgress(progress(10));
      return {
        ready: false as const,
        reason: "stopped",
        download: { kind: "interrupted", tokenless: false, detail: "stopped" },
      };
    });
    await shell.boot();
    const failure = await shell.choose({ mode: "local" });
    expect(failure).toMatchObject({ reason: "download", kind: "interrupted" });
    expect(view()).toMatchObject({
      screen: "failure",
      failure: { reason: "download", kind: "interrupted" },
    });
    // The failure page's 重试 starts over.
    await expect(shell.retry()).resolves.toBeUndefined();
    expect(view()).toMatchObject({ screen: "page" });
  });

  it("is never started for a remote host", async () => {
    const { shell, startHost } = rig();
    await shell.boot();
    await shell.choose({ mode: "remote", address: REMOTE.address, token: "t" });
    expect(startHost).not.toHaveBeenCalled();
  });
});

describe("a local host that cannot be had before anything downloads", () => {
  it("is explained on the failure page, not on the chooser", async () => {
    const { shell, startHost, view } = rig();
    startHost.mockImplementationOnce(async () => ({
      ready: false as const,
      reason: "offline",
      download: { kind: "offline", tokenless: false, detail: "no answer" },
    }));
    await shell.boot();
    await shell.choose({ mode: "local" });
    expect(view()).toMatchObject({
      screen: "failure",
      connection: { mode: "local" },
      failure: { reason: "download", kind: "offline" },
    });
  });
});
