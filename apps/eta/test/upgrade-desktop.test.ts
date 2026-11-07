/**
 * The desktop app as the host's service, from the host's side: what it is asked over the app's
 * port, and the host that already serves a data directory. The app's side of the port is
 * `apps/desktop/test/service.test.ts`.
 */
import type { ServiceStatus } from "@eta/daemon";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRunningHost, localOrigin, recordRunning } from "../src/running";
import {
  DESKTOP_SERVICE_ENV,
  DESKTOP_SERVICE_TOKEN_ENV,
  desktopRunner,
  desktopService,
  takeDesktopShell,
} from "../src/upgrade/desktop";
import { tempDir } from "./support/host";

/** The app's port, remembering what it was asked. */
function fakeApp(state: Record<string, unknown>) {
  const asked: { path: string; body: unknown; auth: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const auth = request.headers.get("authorization");
      const body: unknown =
        request.method === "POST" ? await request.json() : undefined;
      asked.push({ path: pathname, body, auth });
      if (auth !== "Bearer t0ken") return new Response("no", { status: 401 });
      return Response.json(pathname === "/service" ? state : { ok: true });
    },
  });
  return { asked, server, shell: { url: server.url.origin, token: "t0ken" } };
}

const servers: { stop: (force: boolean) => unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
});

describe("the app's address", () => {
  it("is taken out of the environment: what the host starts does not get it", () => {
    const env: NodeJS.ProcessEnv = {
      [DESKTOP_SERVICE_ENV]: "http://127.0.0.1:1",
      [DESKTOP_SERVICE_TOKEN_ENV]: "secret",
      OTHER: "kept",
    };
    expect(takeDesktopShell(env)).toEqual({
      url: "http://127.0.0.1:1",
      token: "secret",
    });
    expect(env).toEqual({ OTHER: "kept" });
    takeDesktopShell({});
  });
});

describe("the app as a service", () => {
  it("is nothing outside the app", async () => {
    takeDesktopShell({});
    expect(await desktopService()).toBeUndefined();
    expect(desktopRunner()).toBeUndefined();
  });

  it("says what the app says, and asks it to stop and start the host", async () => {
    const app = fakeApp({
      program: "/home/u/.eta/desktop/host/eta-host",
      port: 1,
      running: true,
      crashed: false,
      pid: 42,
    });
    servers.push(app.server);
    const service = await desktopService(app.shell);
    expect(service?.program).toBe("/home/u/.eta/desktop/host/eta-host");
    expect(await service?.status()).toEqual<ServiceStatus>({
      running: true,
      crashed: false,
      restarting: false,
      pid: 42,
    });
    await service?.stop();
    await service?.start();
    expect(app.asked.map((call) => call.path)).toEqual([
      "/service",
      "/service",
      "/service/stop",
      "/service/start",
    ]);
    expect(app.asked.every((call) => call.auth === "Bearer t0ken")).toBe(true);
    // Nothing listens on port 1.
    expect(await service?.up()).toBe(false);
  });

  it("is an error when the app refuses, not a host that is down", async () => {
    const app = fakeApp({});
    servers.push(app.server);
    await expect(
      desktopService({ ...app.shell, token: "wrong" }),
    ).rejects.toThrow(/401/);
  });

  it("hands the worker to the app with what it passes along", async () => {
    const app = fakeApp({});
    servers.push(app.server);
    const runner = desktopRunner(app.shell);
    process.env.ETA_TEST_PASSED = "yes";
    try {
      await runner?.start({
        name: "io.eta.host-upgrade",
        argv: ["/x/eta-host", "upgrade", "--worker", "1"],
        passEnv: ["ETA_TEST_PASSED", "ETA_TEST_NOT_SET"],
      });
    } finally {
      delete process.env.ETA_TEST_PASSED;
    }
    await runner?.stop("io.eta.host-upgrade");
    expect(app.asked.map(({ path, body }) => ({ path, body }))).toEqual([
      {
        path: "/worker/start",
        body: {
          name: "io.eta.host-upgrade",
          argv: ["/x/eta-host", "upgrade", "--worker", "1"],
          env: { ETA_TEST_PASSED: "yes" },
        },
      },
      { path: "/worker/stop", body: { name: "io.eta.host-upgrade" } },
    ]);
  });
});

describe("a host already serving the data directory", () => {
  const none = async () => undefined;

  it("is the one that recorded itself, if it is alive and answers", async () => {
    const dataDir = await tempDir();
    const forget = recordRunning(dataDir, {
      pid: 4242,
      hostname: "0.0.0.0",
      port: 8790,
      tokenFile: "/t",
      version: "1.0.0",
    });
    const asked: string[] = [];
    const found = await findRunningHost({
      dataDir,
      pid: 1,
      isAlive: (pid) => pid === 4242,
      up: async (url) => {
        asked.push(url);
        return true;
      },
      installed: none,
    });
    expect(found).toEqual({
      address: "http://127.0.0.1:8790",
      tokenFile: "/t",
      from: "record",
    });
    expect(asked).toEqual(["http://127.0.0.1:8790/up"]);

    // A record a crash left behind, or one that does not answer, is nothing.
    expect(
      await findRunningHost({
        dataDir,
        pid: 1,
        isAlive: () => false,
        up: async () => true,
        installed: none,
      }),
    ).toBeUndefined();
    expect(
      await findRunningHost({
        dataDir,
        pid: 1,
        isAlive: () => true,
        up: async () => false,
        installed: none,
      }),
    ).toBeUndefined();

    // Its own record is not another host.
    expect(
      await findRunningHost({
        dataDir,
        pid: 4242,
        isAlive: () => true,
        up: async () => true,
        installed: none,
      }),
    ).toBeUndefined();

    forget();
    expect(
      await findRunningHost({
        dataDir,
        pid: 1,
        isAlive: () => true,
        up: async () => true,
        installed: none,
      }),
    ).toBeUndefined();
  });

  it("leaves another process's record where it is", async () => {
    const dataDir = await tempDir();
    const forget = recordRunning(dataDir, {
      pid: 1,
      hostname: "127.0.0.1",
      port: 1,
      tokenFile: null,
      version: "1",
    });
    await writeFile(
      join(dataDir, "running-host.json"),
      JSON.stringify({
        pid: 2,
        hostname: "127.0.0.1",
        port: 2,
        tokenFile: null,
        version: "1",
      }),
    );
    forget();
    expect(
      await findRunningHost({
        dataDir,
        pid: 3,
        isAlive: () => true,
        up: async () => true,
        installed: none,
      }),
    ).toMatchObject({ address: "http://127.0.0.1:2" });
  });

  it("is the computer's service when it runs and answers, with its token beyond loopback", async () => {
    const dataDir = await tempDir();
    const service =
      (argv: string[], running = true) =>
      async () => ({
        argv,
        status: async (): Promise<ServiceStatus> => ({
          running,
          crashed: false,
          restarting: false,
          pid: 77,
        }),
      });
    const found = await findRunningHost({
      dataDir,
      pid: 1,
      up: async () => true,
      installed: service(["/usr/bin/eta-host", "--port", "8790"]),
    });
    expect(found).toEqual({
      address: "http://127.0.0.1:8790",
      tokenFile: null,
      from: "service",
    });
    expect(
      await findRunningHost({
        dataDir,
        pid: 1,
        up: async () => true,
        installed: service([
          "/usr/bin/eta-host",
          "--port",
          "8790",
          "--host",
          "0.0.0.0",
        ]),
      }),
    ).toEqual({
      address: "http://127.0.0.1:8790",
      tokenFile: join(dataDir, "access-token"),
      from: "service",
    });
    expect(
      await findRunningHost({
        dataDir,
        pid: 1,
        up: async () => true,
        installed: service(["/usr/bin/eta-host"], false),
      }),
    ).toBeUndefined();
    expect(
      await findRunningHost({
        dataDir,
        pid: 1,
        up: async () => true,
        installed: async () => {
          throw new Error("no systemd here");
        },
      }),
    ).toBeUndefined();
  });

  it("is reached on loopback when it listens everywhere", () => {
    expect(localOrigin("0.0.0.0", 1)).toBe("http://127.0.0.1:1");
    expect(localOrigin("::", 1)).toBe("http://[::1]:1");
    expect(localOrigin("100.64.0.1", 1)).toBe("http://100.64.0.1:1");
  });
});
