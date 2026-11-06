/**
 * The upgrade as something that outlives whoever asked: the worker's status on disk, starting and
 * cancelling the unit, and the `upgrade` target and `/upgrade/status` of a real host.
 *
 * The service manager is not in these: what is checked is what would be asked of it. It being
 * asked for real is the sandbox's and CI's job.
 */
import type { UpgradeResults } from "@eta/client-contracts";
import type { DetachedRunner } from "@eta/daemon";
import type { HostService } from "../src/upgrade/service";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  announceUpgrade,
  readStatus,
  StatusWriter,
} from "../src/upgrade/status";
import { cancelWorker, followWorker, startWorker } from "../src/upgrade/worker";
import { connect } from "./support/client";
import { tempDir, testHost } from "./support/host";

const quiet = () => undefined;
const busy = { kind: "task", number: 45, name: "x" } as const;

/** Stands in for the service manager, remembering what it was asked. */
function recorder(fails = false) {
  const started: Parameters<DetachedRunner["start"]>[0][] = [];
  const stopped: string[] = [];
  const runner: DetachedRunner = {
    start: (job) => {
      started.push(job);
      return fails
        ? Promise.reject(new Error("no systemd here"))
        : Promise.resolve();
    },
    stop: (name) => {
      stopped.push(name);
      return Promise.resolve();
    },
  };
  return { started, stopped, runner };
}

const request = (dataDir: string, runner: DetachedRunner) => ({
  dataDir,
  program: "/opt/eta-host",
  from: "1.0.0",
  force: false,
  waitMinutes: 10,
  runner,
});

describe("the status on disk", () => {
  it("says nothing before the first upgrade", async () => {
    expect(readStatus(await tempDir())).toBeUndefined();
  });

  it("follows the worker through its phases to the end", async () => {
    const dir = await tempDir();
    const writer = new StatusWriter(dir, "u1", "1.0.0");
    writer.target("1.1.0");
    writer.phase("waiting", [busy]);
    expect(readStatus(dir)).toMatchObject({
      state: "running",
      phase: "waiting",
      to: "1.1.0",
      busy: [busy],
    });
    writer.phase("stopping");
    expect(readStatus(dir)?.busy).toBeUndefined();
    writer.log("Starting 1.1.0.");
    writer.finish("rolled-back", "it exited");
    expect(readStatus(dir)).toMatchObject({
      state: "rolled-back",
      error: "it exited",
      log: ["Starting 1.1.0."],
    });
    expect(readStatus(dir)?.finishedAt).toBeTypeOf("number");
  });

  it("keeps the time the upgrade was announced", async () => {
    const dir = await tempDir();
    announceUpgrade(dir, "u1", "1.0.0", 1234);
    new StatusWriter(dir, "u1", "1.0.0").log("up");
    expect(readStatus(dir)?.startedAt).toBe(1234);
  });

  it("calls a worker that has died lost, whatever it said last", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "upgrade-status.json"),
      JSON.stringify({
        id: "u1",
        pid: 2_147_483_646,
        state: "running",
        phase: "restarting",
        from: "1.0.0",
        startedAt: 1,
        log: [],
      }),
    );
    expect(readStatus(dir)).toMatchObject({
      state: "lost",
      error: expect.stringContaining("restarting"),
    });
  });

  it("gives a worker time to start, and no longer", async () => {
    const dir = await tempDir();
    announceUpgrade(dir, "u1", "1.0.0", 1000);
    expect(readStatus(dir, 2000)?.state).toBe("running");
    expect(readStatus(dir, 60_000)?.state).toBe("lost");
  });

  it("does not take a damaged file for an upgrade", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "upgrade-status.json"), "{ half");
    expect(readStatus(dir)).toBeUndefined();
  });
});

describe("starting the worker", () => {
  it("asks for a unit of its own, with no token on the command line", async () => {
    const dir = await tempDir();
    const { runner, started } = recorder();
    process.env.GH_TOKEN = "s3cret";
    try {
      await startWorker({
        ...request(dir, runner),
        wanted: "1.2.0-rc.1",
        force: true,
      });
    } finally {
      delete process.env.GH_TOKEN;
    }
    const [job] = started;
    expect(job?.name).toBe("io.eta.host-upgrade");
    expect(job?.passEnv).toContain("GH_TOKEN");
    expect(job?.argv.join(" ")).not.toContain("s3cret");
    expect(job?.argv).toEqual([
      "/opt/eta-host",
      "upgrade",
      "1.2.0-rc.1",
      "--force",
      "--wait",
      "10",
      "--worker",
      expect.any(String),
      "--target",
      "/opt/eta-host",
    ]);
  });

  it("is visible at once, before the worker has said anything", async () => {
    const dir = await tempDir();
    const id = await startWorker(request(dir, recorder().runner));
    expect(readStatus(dir)).toMatchObject({ id, state: "running" });
  });

  it("finds the one running instead of starting a second", async () => {
    const dir = await tempDir();
    const { runner, started } = recorder();
    const first = await startWorker(request(dir, runner));
    expect(await startWorker(request(dir, runner))).toBe(first);
    expect(started).toHaveLength(1);
  });

  it("says so when the unit cannot start", async () => {
    const dir = await tempDir();
    await expect(
      startWorker(request(dir, recorder(true).runner)),
    ).rejects.toThrow(/no systemd/);
    expect(readStatus(dir)).toMatchObject({
      state: "failed",
      error: "no systemd here",
    });
  });
});

describe("cancelling", () => {
  it("stops a worker that has not touched the service", async () => {
    const dir = await tempDir();
    new StatusWriter(dir, "u1", "1.0.0").phase("waiting", [busy]);
    const { runner, stopped } = recorder();
    expect(await cancelWorker(dir, runner)).toBe(true);
    expect(stopped).toEqual(["io.eta.host-upgrade"]);
  });

  it("leaves one past that point alone", async () => {
    const dir = await tempDir();
    new StatusWriter(dir, "u1", "1.0.0").phase("stopping");
    const { runner, stopped } = recorder();
    expect(await cancelWorker(dir, runner)).toBe(false);
    expect(stopped).toEqual([]);
  });

  it("has nothing to do with nothing running", async () => {
    const { runner, stopped } = recorder();
    expect(await cancelWorker(await tempDir(), runner)).toBe(false);
    expect(stopped).toEqual([]);
  });
});

describe("following the worker", () => {
  it("prints each line once and exits 0 when it is done", async () => {
    const dir = await tempDir();
    const writer = new StatusWriter(dir, "u1", "1.0.0");
    const lines: string[] = [];
    const following = followWorker(dir, "u1", (l) => lines.push(l), quiet, 1);
    writer.log("one");
    await new Promise((resolve) => setTimeout(resolve, 10));
    writer.log("two");
    writer.finish("done");
    expect(await following).toBe(0);
    expect(lines).toEqual(["one", "two"]);
  });

  it("exits 1 with the worker's words when it failed", async () => {
    const dir = await tempDir();
    new StatusWriter(dir, "u1", "1.0.0").finish("rolled-back", "it exited");
    const errors: string[] = [];
    expect(await followWorker(dir, "u1", quiet, (l) => errors.push(l), 1)).toBe(
      1,
    );
    expect(errors).toEqual(["it exited"]);
  });

  it("does not wait for a status that is not there", async () => {
    expect(await followWorker(await tempDir(), "u1", quiet, quiet, 1)).toBe(1);
  });
});

describe("the update button's target", () => {
  const exe = realpathSync(process.execPath);
  const service = (running = true, program = exe): HostService => ({
    program,
    startCommand: "",
    status: () =>
      Promise.resolve({
        running,
        crashed: false,
        restarting: false,
        pid: running ? 1 : 0,
      }),
    stop: () => Promise.resolve(),
    start: () => Promise.resolve(),
    up: () => Promise.resolve(true),
  });
  const latest = (version: string) => ({
    latest: () => Promise.resolve({ version, assets: [] }),
  });

  async function client(upgrade: Parameters<typeof testHost>[0]) {
    const host = await testHost(upgrade);
    const socket = await connect(`ws://127.0.0.1:${host.port}/ws`, {
      origin: `http://127.0.0.1:${host.port}`,
    });
    await socket.hello();
    return { host, socket };
  }

  const options = {
    compiled: true,
    version: "1.0.0",
    execPath: exe,
    releases: latest("1.1.0"),
    findService: () => Promise.resolve(service()),
    busy: () => [busy],
  };

  it("says what there is and what stands in the way", async () => {
    const { socket } = await client({ upgrade: options });
    expect(await socket.call("upgrade", "check", {})).toEqual({
      version: "1.0.0",
      latest: "1.1.0",
      available: true,
      blocked: null,
      busy: [busy],
      error: null,
    });
  });

  it("knows up to date, and a checkout's build from a release", async () => {
    const up = await client({
      upgrade: { ...options, version: "1.1.0" },
    });
    expect(await up.socket.call("upgrade", "check", {})).toMatchObject({
      available: false,
    });
    const checkout = await client({
      upgrade: { ...options, version: "0f3d99e59084" },
    });
    expect(await checkout.socket.call("upgrade", "check", {})).toMatchObject({
      available: true,
    });
  });

  it.each([
    ["source", { compiled: false }],
    ["no-service", { findService: () => Promise.resolve(undefined) }],
    ["no-service", { findService: () => Promise.resolve(service(false)) }],
    [
      "no-windows-service",
      {
        findService: () => Promise.resolve(undefined),
        platform: "win32" as const,
      },
    ],
    [
      "other-file",
      { findService: () => Promise.resolve(service(true, "/bin/sh")) },
    ],
  ])("is blocked: %s", async (blocked, change) => {
    const { socket } = await client({ upgrade: { ...options, ...change } });
    expect(await socket.call("upgrade", "check", {})).toMatchObject({
      blocked,
    });
    await expect(socket.call("upgrade", "start", {})).rejects.toThrow(
      /cannot upgrade itself/,
    );
  });

  it("still answers when the release cannot be found", async () => {
    const { socket } = await client({
      upgrade: {
        ...options,
        releases: { latest: () => Promise.reject(new Error("no network")) },
      },
    });
    expect(await socket.call("upgrade", "check", {})).toMatchObject({
      latest: null,
      available: false,
      error: "no network",
    });
  });

  it("starts the worker from the file the service runs", async () => {
    const asked: unknown[] = [];
    const { socket } = await client({
      upgrade: {
        ...options,
        start: (request) => {
          asked.push(request);
          return Promise.resolve("u1");
        },
      },
    });
    const started = (await socket.call("upgrade", "start", {
      force: true,
    })) as UpgradeResults["start"];
    expect(started.id).toBe("u1");
    expect(asked).toMatchObject([{ program: exe, from: "1.0.0", force: true }]);
  });

  it("serves the status, and nothing when there has been none", async () => {
    const { host } = await client({ upgrade: options });
    const url = `http://127.0.0.1:${host.port}/upgrade/status`;
    const none = await fetch(url);
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await none.json()).toBeNull();

    new StatusWriter(host.dataDir, "u1", "1.0.0").finish("done");
    expect(await (await fetch(url)).json()).toMatchObject({
      id: "u1",
      state: "done",
    });
  });

  it("keeps the status behind the token", async () => {
    const dir = await tempDir();
    const tokenFile = join(dir, "token");
    await writeFile(tokenFile, "a-long-enough-token-for-the-gate-0123456789");
    const host = await testHost({ tokenFile });
    const answer = await fetch(`http://127.0.0.1:${host.port}/upgrade/status`, {
      redirect: "manual",
    });
    expect(answer.status).toBe(401);
    expect(existsSync(tokenFile)).toBe(true);
  });
});
