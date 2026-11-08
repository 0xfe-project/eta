/**
 * The connection controller against real hosts: in-process hosts for resident ones, the host run
 * from source for a temporary one, and scripts where `eta-host` has to misbehave or must not run
 * for real (`install-service`). Timing is shortened; the defaults have their own test.
 */
import type {
  ControllerDeps,
  ControllerTiming,
} from "../../src/connection/controller";
import type {
  ConnectionController,
  ConnectionPhase,
  ConnectionState,
  HostProgram,
} from "../../src/connection/types";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectionController } from "../../src/connection/controller";
import { probeUp } from "../../src/connection/probe";
import { script } from "../support/fake-programs";
import {
  baseUrl,
  childEnv,
  closedPort,
  closeHost,
  SOURCE_HOST,
  testHost,
} from "../support/host";
import { tempDir, until } from "../support/temp";

const TOKEN = "tok-0123456789abcdef";
const FAST: ControllerTiming = {
  giveUpMs: 1_500,
  initialRetryMs: 50,
  maxRetryMs: 200,
  probeTimeoutMs: 500,
  temporaryStartMs: 60_000,
  temporaryStopMs: 10_000,
  installRunMs: 30_000,
  installUpMs: 3_000,
};

type Controller = ConnectionController & { killTemporaryNow: () => void };
const controllers: Controller[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
});

interface Made {
  controller: Controller;
  /** Every phase the controller passed through, in order. */
  phases: ConnectionPhase[];
  states: ConnectionState[];
  config: string;
}

async function make(deps: Partial<ControllerDeps> = {}): Promise<Made> {
  const dir = await tempDir("eta-tui-conf-");
  const config = join(dir, "tui.json");
  const controller = createConnectionController({
    paths: { config, state: join(dir, "tui-state.json") },
    setting: undefined,
    env: {},
    findHost: () => undefined,
    tuiVersion: "dev",
    // Never the real 127.0.0.1:8787.
    localUrl: `http://127.0.0.1:${await closedPort()}`,
    ...deps,
    timing: { ...FAST, ...deps.timing },
  });
  controllers.push(controller);
  const phases: ConnectionPhase[] = [controller.getState().phase];
  const states: ConnectionState[] = [controller.getState()];
  controller.subscribe(() => {
    states.push(controller.getState());
    phases.push(controller.getState().phase);
  });
  return { controller, phases, states, config };
}

const phaseOf = (made: Made) => made.controller.getState().phase;
const named = (made: Made, name: ConnectionPhase["name"]) => () =>
  phaseOf(made).name === name;
const names = (made: Made) => made.phases.map((phase) => phase.name);

async function settings(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `eta-host` as a script, for the paths the real one cannot take here.
 *
 * As `install-service` it writes its pid to `FAKE_INSTALL_PID_FILE` if given, sleeps
 * `FAKE_INSTALL_SLEEP_MS`, and exits with `FAKE_EXIT` after printing `FAKE_OUT`; with
 * `FAKE_REFUSE_IF_ALIVE` it exits 3 instead while the process in `FAKE_PID_FILE` still runs.
 *
 * Otherwise it is a temporary host that writes its pid to `FAKE_PID_FILE` (and as a file name
 * into `FAKE_PID_DIR`, so several can be told apart), waits
 * `FAKE_READY_AFTER_MS` (forever with `FAKE_NEVER_READY`), says the port of a host the test
 * already runs (`FAKE_PORT`), ends on a stop request unless `FAKE_IGNORE_STOP`, and ends by
 * itself after `FAKE_EXIT_AFTER_MS` if given.
 */
function dualProgram(): Promise<HostProgram> {
  return script(`
const env = process.env;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (process.argv.includes("install-service")) {
  if (env.FAKE_INSTALL_PID_FILE) await Bun.write(env.FAKE_INSTALL_PID_FILE, String(process.pid));
  if (env.FAKE_REFUSE_IF_ALIVE) {
    const pid = Number(await Bun.file(env.FAKE_PID_FILE).text());
    if (alive(pid)) {
      console.log("the temporary host " + pid + " is still running");
      process.exit(3);
    }
  }
  await sleep(Number(env.FAKE_INSTALL_SLEEP_MS ?? 0));
  console.log(env.FAKE_OUT ?? "installing");
  process.exit(Number(env.FAKE_EXIT ?? 0));
}
if (env.FAKE_PID_FILE) await Bun.write(env.FAKE_PID_FILE, String(process.pid));
if (env.FAKE_PID_DIR) await Bun.write(env.FAKE_PID_DIR + "/" + process.pid, "");
const ignoreStop = Boolean(env.FAKE_IGNORE_STOP);
if (env.ETA_STOP_PIPE) {
  const { createServer } = await import("node:net");
  createServer((socket) => socket.on("data", () => { if (!ignoreStop) process.exit(0); })).listen(env.ETA_STOP_PIPE);
}
process.on("SIGTERM", () => { if (!ignoreStop) process.exit(0); });
setInterval(() => undefined, 1_000);
if (env.FAKE_NEVER_READY) await new Promise(() => undefined);
await sleep(Number(env.FAKE_READY_AFTER_MS ?? 0));
console.log(JSON.stringify({ port: Number(env.FAKE_PORT) }));
if (env.FAKE_EXIT_AFTER_MS) {
  setTimeout(() => {
    console.error("crashed on purpose");
    process.exit(9);
  }, Number(env.FAKE_EXIT_AFTER_MS));
}
setInterval(() => undefined, 1_000);
`);
}

async function pidIn(file: string): Promise<number> {
  await until(
    async () => (await readFile(file, "utf8").catch(() => "")) !== "",
    10_000,
  );
  return Number(await readFile(file, "utf8"));
}

describe("start", () => {
  it("is idle before start, and offers the first-run choices with a local host that answers", async () => {
    const local = await testHost();
    const made = await make({ localUrl: baseUrl(local) });
    expect(phaseOf(made)).toEqual({ name: "idle" });
    await made.controller.start();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: baseUrl(local),
    });
    expect(made.controller.getState().setting).toBeUndefined();
    expect(made.controller.getState().wire).toBeUndefined();
  });

  it("suggests nothing when no local host answers", async () => {
    const made = await make();
    await made.controller.start();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: undefined,
    });
  });

  it("connects to a resident host from the settings", async () => {
    const host = await testHost();
    const url = baseUrl(host);
    const made = await make({ setting: { mode: "resident", url } });
    await made.controller.start();
    await until(named(made, "connected"));
    expect(phaseOf(made)).toEqual({ name: "connected", url, temporary: false });
    expect(names(made)).toContain("connecting");
    expect(made.phases.find((phase) => phase.name === "connecting")).toEqual({
      name: "connecting",
      url,
      temporary: false,
    });
    const state = made.controller.getState();
    expect(state.setting).toEqual({ mode: "resident", url });
    expect(state.wire?.store.getState().status).toBe("open");
    expect(state.tokenFromEnv).toBe(false);
  });

  it("starts the real host as a temporary one from the settings, without writing them, and stops it", async () => {
    const home = await tempDir("eta-tui-home-");
    const made = await make({
      setting: { mode: "temporary" },
      env: childEnv(home),
      findHost: () => SOURCE_HOST,
    });
    await made.controller.start();
    await until(named(made, "connected"), 60_000, "the temporary host");
    const phase = phaseOf(made) as Extract<
      ConnectionPhase,
      { name: "connected" }
    >;
    expect(phase.temporary).toBe(true);
    expect(phase.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(names(made)).toEqual(
      expect.arrayContaining(["starting-temporary", "connecting", "connected"]),
    );
    expect(names(made).indexOf("starting-temporary")).toBeLessThan(
      names(made).indexOf("connecting"),
    );
    expect(made.controller.getState().setting).toEqual({ mode: "temporary" });
    expect(await settings(made.config)).toBeUndefined();

    await made.controller.stop();
    expect(phaseOf(made)).toEqual({ name: "stopped" });
    expect(await probeUp(phase.url, 500)).toBe(false);
  }, 90_000);
});

describe("tokens", () => {
  it("uses ETA_TOKEN over the settings' token", async () => {
    const host = await testHost({ token: TOKEN });
    const url = baseUrl(host);
    const made = await make({
      setting: { mode: "resident", url, token: "wrong-token-000000" },
      env: { ETA_TOKEN: TOKEN },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    expect(made.controller.getState().tokenFromEnv).toBe(true);
  });

  it("uses the settings' token when ETA_TOKEN is empty", async () => {
    const host = await testHost({ token: TOKEN });
    const url = baseUrl(host);
    const made = await make({
      setting: { mode: "resident", url, token: TOKEN },
      env: { ETA_TOKEN: "" },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    expect(made.controller.getState().tokenFromEnv).toBe(false);
  });

  it("uses a token the user gives over a wrong ETA_TOKEN", async () => {
    const host = await testHost({ token: TOKEN });
    const url = baseUrl(host);
    const made = await make({
      setting: undefined,
      env: { ETA_TOKEN: "wrong-token-000000" },
    });
    await made.controller.connectResident({ url, token: TOKEN });
    await until(named(made, "connected"));
    expect(made.controller.getState().tokenFromEnv).toBe(false);
  });

  it("falls back to ETA_TOKEN when the user gives no token", async () => {
    const host = await testHost({ token: TOKEN });
    const url = baseUrl(host);
    const made = await make({ setting: undefined, env: { ETA_TOKEN: TOKEN } });
    await made.controller.connectResident({ url });
    await until(named(made, "connected"));
    expect(made.controller.getState().tokenFromEnv).toBe(true);
  });

  it("stops at unauthorized when the host refuses the token, and does not retry", async () => {
    const host = await testHost({ token: TOKEN });
    const url = baseUrl(host);
    const made = await make({
      setting: { mode: "resident", url, token: "wrong-token-000000" },
    });
    await made.controller.start();
    await until(named(made, "unauthorized"));
    expect(phaseOf(made)).toEqual({ name: "unauthorized", url });
    const wire = made.controller.getState().wire;
    // Past the grace period it is still unauthorized, not unreachable: nothing is retrying.
    await new Promise((resolve) => setTimeout(resolve, FAST.giveUpMs + 500));
    expect(phaseOf(made)).toEqual({ name: "unauthorized", url });
    if (wire !== undefined) {
      const failure = await wire
        .call("upgrade", "check", {})
        .catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
    }
  });
});

describe("losing and regaining the host", () => {
  it("goes to reconnecting when the host drops, and back to connected when it returns", async () => {
    const host = await testHost();
    const { port, dataDir } = host;
    const url = baseUrl(host);
    const made = await make({
      setting: { mode: "resident", url },
      timing: { giveUpMs: 20_000 },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    const before = Date.now();
    await closeHost(host);
    await until(named(made, "reconnecting"));
    const lost = phaseOf(made) as Extract<
      ConnectionPhase,
      { name: "reconnecting" }
    >;
    expect(lost).toMatchObject({ url, temporary: false });
    expect(lost.since).toBeGreaterThanOrEqual(before - 50);
    expect(lost.since).toBeLessThanOrEqual(Date.now());
    await testHost({ port, dataDir });
    await until(named(made, "connected"), 20_000);
    expect(phaseOf(made)).toEqual({ name: "connected", url, temporary: false });
  });

  it("gives up after the grace period as unreachable, and stops retrying", async () => {
    const port = await closedPort();
    const url = `http://127.0.0.1:${port}`;
    const made = await make({ setting: { mode: "resident", url } });
    const before = Date.now();
    await made.controller.start();
    await until(named(made, "unreachable"), 10_000);
    expect(Date.now() - before).toBeGreaterThanOrEqual(FAST.giveUpMs - 50);
    expect(phaseOf(made)).toEqual({
      name: "unreachable",
      url,
      reason: "timeout",
      output: undefined,
    });
    // A host that appears afterwards is not found: the wire is closed.
    await testHost({ port });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(phaseOf(made).name).toBe("unreachable");
  });

  it("measures the grace period from the drop, across failed attempts", async () => {
    const host = await testHost();
    const url = baseUrl(host);
    const made = await make({ setting: { mode: "resident", url } });
    await made.controller.start();
    await until(named(made, "connected"));
    const dropped = Date.now();
    await closeHost(host);
    await until(named(made, "unreachable"), 10_000);
    const took = Date.now() - dropped;
    expect(took).toBeGreaterThanOrEqual(FAST.giveUpMs - 100);
    expect(took).toBeLessThan(FAST.giveUpMs + 2_000);
  });
});

describe("the version check", () => {
  it("warns once when the host's build differs from the TUI's", async () => {
    const host = await testHost({ version: "1.2.3" });
    const made = await make({
      setting: { mode: "resident", url: baseUrl(host) },
      tuiVersion: "1.0.0",
    });
    await made.controller.start();
    await until(() => made.controller.getState().versionWarning !== undefined);
    expect(made.controller.getState().versionWarning).toEqual({
      host: "1.2.3",
      tui: "1.0.0",
    });
  });

  it("does not warn for equal builds or a dev build", async () => {
    for (const [hostVersion, tuiVersion] of [
      ["1.2.3", "1.2.3"],
      ["dev", "1.2.3"],
      ["1.2.3", "dev"],
    ] as const) {
      let asked = 0;
      const host = await testHost({
        overrides: {
          upgrade: {
            version: hostVersion,
            releases: {
              latest: async () => {
                asked += 1;
                return { version: hostVersion } as never;
              },
            },
            findToken: async () => ({}) as never,
            findService: async () => undefined,
          },
        },
      });
      const made = await make({
        setting: { mode: "resident", url: baseUrl(host) },
        tuiVersion,
      });
      await made.controller.start();
      await until(named(made, "connected"));
      // A dev TUI never compares, so it does not spend GitHub's allowance asking.
      const expected = tuiVersion === "dev" ? 0 : 1;
      if (expected === 1)
        await until(() => asked === 1, 5_000, "upgrade.check");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(asked, `${hostVersion}/${tuiVersion} asked`).toBe(expected);
      expect(
        made.controller.getState().versionWarning,
        `${hostVersion}/${tuiVersion}`,
      ).toBeUndefined();
      await made.controller.stop();
    }
  });

  it("asks only on the first connection of the process, not after a reconnect", async () => {
    let asked = 0;
    const upgrade = {
      version: "1.2.3",
      releases: {
        latest: async () => {
          asked += 1;
          return { version: "1.2.3" } as never;
        },
      },
      findToken: async () => ({}) as never,
      findService: async () => undefined,
    };
    const host = await testHost({ overrides: { upgrade } });
    const { port, dataDir } = host;
    const made = await make({
      setting: { mode: "resident", url: baseUrl(host) },
      tuiVersion: "1.0.0",
      timing: { giveUpMs: 20_000 },
    });
    await made.controller.start();
    await until(() => made.controller.getState().versionWarning !== undefined);
    expect(asked).toBe(1);
    await closeHost(host);
    await until(named(made, "reconnecting"));
    await testHost({ port, dataDir, overrides: { upgrade } });
    await until(named(made, "connected"), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(asked).toBe(1);
  });

  it("does not ask again after moving to another host", async () => {
    let asked = 0;
    const upgrade = {
      version: "1.2.3",
      releases: {
        latest: async () => {
          asked += 1;
          return { version: "1.2.3" } as never;
        },
      },
      findToken: async () => ({}) as never,
      findService: async () => undefined,
    };
    const first = await testHost({ overrides: { upgrade } });
    const second = await testHost({ overrides: { upgrade } });
    const made = await make({
      setting: { mode: "resident", url: baseUrl(first) },
      tuiVersion: "1.0.0",
    });
    await made.controller.start();
    await until(() => asked === 1);
    await made.controller.connectResident({ url: baseUrl(second) });
    await until(named(made, "connected"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(asked).toBe(1);
  });

  it("skips quietly when upgrade.check fails", async () => {
    const host = await testHost({
      overrides: {
        upgrade: {
          version: "9.9.9",
          busy: () => {
            throw new Error("busy broke");
          },
          releases: { latest: async () => ({ version: "9.9.9" }) as never },
          findToken: async () => ({}) as never,
          findService: async () => undefined,
        },
      },
    });
    const made = await make({
      setting: { mode: "resident", url: baseUrl(host) },
      tuiVersion: "1.0.0",
    });
    await made.controller.start();
    await until(named(made, "connected"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(phaseOf(made).name).toBe("connected");
    expect(made.controller.getState().versionWarning).toBeUndefined();
  });

  it("does not call upgrade.check on a host that does not have it", async () => {
    // A host without the upgrade plugin: a socket that says hello with no ops and records calls.
    const calls: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, srv) {
        if (srv.upgrade(request)) return undefined;
        return new Response("ok");
      },
      websocket: {
        open(socket) {
          socket.send(
            JSON.stringify({ type: "hello", ops: [], mounted: [], state: {} }),
          );
        },
        message(_socket, message) {
          calls.push(String(message));
        },
      },
    });
    try {
      const made = await make({
        setting: { mode: "resident", url: `http://127.0.0.1:${server.port}` },
        tuiVersion: "1.0.0",
      });
      await made.controller.start();
      await until(named(made, "connected"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(calls).toEqual([]);
      expect(made.controller.getState().versionWarning).toBeUndefined();
      expect(await made.controller.handoverBusy()).toBeUndefined();
      expect(calls).toEqual([]);
    } finally {
      void server.stop(true);
    }
  });
});

describe("connectResident", () => {
  it("rejects an address that is not one", async () => {
    const made = await make();
    await made.controller.start();
    await expect(
      made.controller.connectResident({ url: "ftp://nope" }),
    ).rejects.toThrow();
    expect(phaseOf(made).name).toBe("first-run");
    expect(await settings(made.config)).toBeUndefined();
  });

  it("saves the normalised address with its token and connects", async () => {
    const host = await testHost({ token: TOKEN });
    const made = await make();
    await made.controller.start();
    await made.controller.connectResident({
      url: ` ws://127.0.0.1:${host.port}/ws `,
      token: TOKEN,
    });
    const url = baseUrl(host);
    expect(await settings(made.config)).toEqual({
      connection: { mode: "resident", url, token: TOKEN },
    });
    await until(named(made, "connected"));
    expect(phaseOf(made)).toEqual({ name: "connected", url, temporary: false });
    expect(made.controller.getState().setting).toEqual({
      mode: "resident",
      url,
      token: TOKEN,
    });
    expect(made.controller.getState().saveProblem).toBeUndefined();
  });

  it("saves no token key without a token, and keeps the other settings", async () => {
    const host = await testHost();
    const made = await make();
    await writeFile(made.config, '{"locale": "zh"}');
    await made.controller.start();
    await made.controller.connectResident({ url: baseUrl(host) });
    expect(await settings(made.config)).toEqual({
      locale: "zh",
      connection: { mode: "resident", url: baseUrl(host) },
    });
  });

  it("still connects when the settings cannot be written, and says why", async () => {
    const host = await testHost();
    const made = await make();
    await writeFile(made.config, "{ broken");
    await made.controller.start();
    await made.controller.connectResident({ url: baseUrl(host) });
    expect(made.controller.getState().saveProblem).toEqual({
      reason: "invalid-json",
      file: made.config,
    });
    expect(await readFile(made.config, "utf8")).toBe("{ broken");
    await until(named(made, "connected"));
  });

  it("stops the temporary host in use first, and closes its wire", async () => {
    const target = await testHost();
    const resident = await testHost();
    const pidFile = join(await tempDir(), "pid");
    const program = await dualProgram();
    const made = await make({
      env: { FAKE_PORT: String(target.port), FAKE_PID_FILE: pidFile },
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: false });
    await until(named(made, "connected"));
    const pid = await pidIn(pidFile);
    const oldWire = made.controller.getState().wire!;
    await made.controller.connectResident({ url: baseUrl(resident) });
    expect(alive(pid)).toBe(false);
    expect(oldWire.store.getState().status).not.toBe("open");
    await until(named(made, "connected"));
    expect(phaseOf(made)).toEqual({
      name: "connected",
      url: baseUrl(resident),
      temporary: false,
    });
  });
});

describe("startTemporary", () => {
  it("asks how to install the host when there is none", async () => {
    const made = await make();
    await made.controller.start();
    await made.controller.startTemporary({ persist: true });
    expect(phaseOf(made)).toEqual({
      name: "host-missing",
      wanted: "temporary",
    });
    expect(await settings(made.config)).toBeUndefined();
  });

  it("saves the temporary mode when asked to persist", async () => {
    const target = await testHost();
    const program = await dualProgram();
    const made = await make({
      env: { FAKE_PORT: String(target.port) },
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: true });
    await until(named(made, "connected"));
    expect(phaseOf(made)).toEqual({
      name: "connected",
      url: baseUrl(target),
      temporary: true,
    });
    expect(await settings(made.config)).toEqual({
      connection: { mode: "temporary" },
    });
    expect(made.controller.getState().setting).toEqual({ mode: "temporary" });
  });

  it("leaves the settings alone without persist, while the state says temporary", async () => {
    const target = await testHost();
    const program = await dualProgram();
    const made = await make({
      setting: { mode: "resident", url: "http://127.0.0.1:1" },
      env: { FAKE_PORT: String(target.port) },
      findHost: () => program,
    });
    await writeFile(
      made.config,
      '{"connection": {"mode": "resident", "url": "http://127.0.0.1:1"}}',
    );
    await made.controller.startTemporary({ persist: false });
    await until(named(made, "connected"));
    expect(made.controller.getState().setting).toEqual({ mode: "temporary" });
    expect(await settings(made.config)).toEqual({
      connection: { mode: "resident", url: "http://127.0.0.1:1" },
    });
  });

  it("is unreachable with the output when the temporary host does not start", async () => {
    const program = await script(
      `console.error("no port for you"); process.exit(2);`,
    );
    const made = await make({ findHost: () => program });
    await made.controller.start();
    await made.controller.startTemporary({ persist: true });
    await until(named(made, "unreachable"));
    const phase = phaseOf(made) as Extract<
      ConnectionPhase,
      { name: "unreachable" }
    >;
    expect(phase.reason).toBe("temporary-failed");
    expect(phase.output).toContain("no port for you");
    expect(names(made)).toContain("starting-temporary");
    expect(await settings(made.config)).toBeUndefined();
  });

  it("is unreachable at once, with the output, when the temporary host ends while in use", async () => {
    const target = await testHost();
    const program = await dualProgram();
    const made = await make({
      env: { FAKE_PORT: String(target.port), FAKE_EXIT_AFTER_MS: "1500" },
      findHost: () => program,
      timing: { giveUpMs: 60_000 },
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: false });
    await until(named(made, "connected"));
    const wire = made.controller.getState().wire!;
    await until(named(made, "unreachable"), 10_000);
    const phase = phaseOf(made) as Extract<
      ConnectionPhase,
      { name: "unreachable" }
    >;
    expect(phase.reason).toBe("temporary-exited");
    expect(phase.output).toContain("crashed on purpose");
    // The wire is closed though the host it pointed at is still up.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wire.store.getState().status).not.toBe("open");
    expect(phaseOf(made).name).toBe("unreachable");
  });
});

describe("installResident", () => {
  it("asks how to install the host when there is none", async () => {
    const made = await make();
    await made.controller.start();
    await made.controller.installResident();
    expect(phaseOf(made)).toEqual({ name: "host-missing", wanted: "install" });
  });

  it("installs, waits for the service, connects to it and saves it", async () => {
    const local = await testHost();
    const program = await dualProgram();
    const made = await make({
      localUrl: baseUrl(local),
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.installResident();
    await until(named(made, "connected"));
    expect(made.phases).toContainEqual({ name: "installing", step: "running" });
    expect(made.phases).toContainEqual({
      name: "installing",
      step: "waiting-up",
    });
    const order = names(made);
    expect(order.indexOf("installing")).toBeLessThan(
      order.indexOf("connecting"),
    );
    expect(phaseOf(made)).toEqual({
      name: "connected",
      url: baseUrl(local),
      temporary: false,
    });
    expect(await settings(made.config)).toEqual({
      connection: { mode: "resident", url: baseUrl(local) },
    });
  });

  it("fails in the running step when install-service fails", async () => {
    const program = await dualProgram();
    const made = await make({
      env: { FAKE_EXIT: "1", FAKE_OUT: "Access is denied." },
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.installResident();
    await until(named(made, "install-failed"));
    const phase = phaseOf(made) as Extract<
      ConnectionPhase,
      { name: "install-failed" }
    >;
    expect(phase.step).toBe("running");
    expect(phase.output).toContain("Access is denied.");
    expect(await settings(made.config)).toBeUndefined();
  });

  it("fails in the waiting step when the service never answers", async () => {
    const program = await dualProgram();
    const made = await make({
      env: { FAKE_OUT: "Installed." },
      findHost: () => program,
      timing: { installUpMs: 1_200 },
    });
    await made.controller.start();
    await made.controller.installResident();
    await until(named(made, "install-failed"), 10_000);
    const phase = phaseOf(made) as Extract<
      ConnectionPhase,
      { name: "install-failed" }
    >;
    expect(phase.step).toBe("waiting-up");
    expect(phase.output).toContain("Installed.");
    expect(await settings(made.config)).toBeUndefined();
  });
});

describe("handover", () => {
  it("is refused when the host in use is not a temporary one", async () => {
    const host = await testHost();
    const made = await make({
      setting: { mode: "resident", url: baseUrl(host) },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    await expect(made.controller.handover()).rejects.toThrow();
    expect(phaseOf(made).name).toBe("connected");
  });

  it("stops the temporary host, installs the service and moves to it", async () => {
    const temporaryTarget = await testHost();
    const local = await testHost();
    const program = await dualProgram();
    const pidFile = join(await tempDir(), "pid");
    const made = await make({
      env: { FAKE_PORT: String(temporaryTarget.port), FAKE_PID_FILE: pidFile },
      localUrl: baseUrl(local),
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: true });
    await until(named(made, "connected"));
    const pid = await pidIn(pidFile);
    await made.controller.handover();
    expect(alive(pid)).toBe(false);
    await until(named(made, "connected"));
    expect(phaseOf(made)).toEqual({
      name: "connected",
      url: baseUrl(local),
      temporary: false,
    });
    expect(made.phases).toContainEqual({ name: "installing", step: "running" });
    expect(await settings(made.config)).toEqual({
      connection: { mode: "resident", url: baseUrl(local) },
    });
  });

  it("starts the temporary host again when the handover fails and the failure is dismissed", async () => {
    const temporaryTarget = await testHost();
    const program = await dualProgram();
    const made = await make({
      env: { FAKE_PORT: String(temporaryTarget.port), FAKE_EXIT: "1" },
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: false });
    await until(named(made, "connected"));
    await made.controller.handover();
    await until(named(made, "install-failed"));
    await made.controller.dismissFailure();
    await until(named(made, "connected"));
    expect(phaseOf(made)).toEqual({
      name: "connected",
      url: baseUrl(temporaryTarget),
      temporary: true,
    });
    const after = names(made).slice(names(made).lastIndexOf("install-failed"));
    expect(after).toContain("starting-temporary");
    expect(await settings(made.config)).toBeUndefined();
  });
});

describe("handoverBusy", () => {
  it("says what a restart would stop", async () => {
    const busy = [
      { kind: "task" as const, name: "Write the report", number: 3 },
    ];
    const host = await testHost({
      overrides: {
        upgrade: {
          version: "dev",
          busy: () => busy,
          releases: { latest: async () => ({ version: "dev" }) as never },
          findToken: async () => ({}) as never,
          findService: async () => undefined,
        },
      },
    });
    const made = await make({
      setting: { mode: "resident", url: baseUrl(host) },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    expect(await made.controller.handoverBusy()).toEqual(busy);
  });

  it("is undefined when not connected or when the call fails", async () => {
    const made = await make();
    await made.controller.start();
    expect(await made.controller.handoverBusy()).toBeUndefined();

    const host = await testHost({
      overrides: {
        upgrade: {
          version: "dev",
          busy: () => {
            throw new Error("busy broke");
          },
          releases: { latest: async () => ({ version: "dev" }) as never },
          findToken: async () => ({}) as never,
          findService: async () => undefined,
        },
      },
    });
    const connected = await make({
      setting: { mode: "resident", url: baseUrl(host) },
    });
    await connected.controller.start();
    await until(named(connected, "connected"));
    expect(await connected.controller.handoverBusy()).toBeUndefined();
  });
});

describe("dismissFailure", () => {
  it("goes back to the first-run choices, looking for a local host again", async () => {
    const port = await closedPort();
    const localUrl = `http://127.0.0.1:${port}`;
    const program = await dualProgram();
    const made = await make({
      localUrl,
      env: { FAKE_EXIT: "1" },
      findHost: () => program,
    });
    await made.controller.start();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: undefined,
    });
    await made.controller.installResident();
    await until(named(made, "install-failed"));
    await testHost({ port });
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: localUrl,
    });
  });

  it("goes back to the first-run choices from host-missing", async () => {
    const made = await make();
    await made.controller.start();
    await made.controller.startTemporary({ persist: true });
    expect(phaseOf(made).name).toBe("host-missing");
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: undefined,
    });
  });

  it("goes back to the same unreachable choices it came from", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    const made = await make({ setting: { mode: "resident", url } });
    await made.controller.start();
    await until(named(made, "unreachable"), 10_000);
    const unreachable = phaseOf(made);
    await made.controller.startTemporary({ persist: false });
    expect(phaseOf(made)).toEqual({
      name: "host-missing",
      wanted: "temporary",
    });
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toEqual(unreachable);
  });

  it("goes back to the unreachable choices after a failed install from there", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    const program = await dualProgram();
    const made = await make({
      setting: { mode: "resident", url },
      env: { FAKE_EXIT: "1" },
      findHost: () => program,
    });
    await made.controller.start();
    await until(named(made, "unreachable"), 10_000);
    const unreachable = phaseOf(made);
    await made.controller.installResident();
    await until(named(made, "install-failed"));
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toEqual(unreachable);
  });
});

describe("stop", () => {
  it("closes the wire and is stopped, again and again", async () => {
    const host = await testHost();
    const made = await make({
      setting: { mode: "resident", url: baseUrl(host) },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    const wire = made.controller.getState().wire!;
    await made.controller.stop();
    expect(phaseOf(made)).toEqual({ name: "stopped" });
    expect(wire.store.getState().status).not.toBe("open");
    await made.controller.stop();
    expect(phaseOf(made)).toEqual({ name: "stopped" });
  });

  it("waits for the temporary host to end", async () => {
    const target = await testHost();
    const program = await dualProgram();
    const pidFile = join(await tempDir(), "pid");
    const made = await make({
      env: { FAKE_PORT: String(target.port), FAKE_PID_FILE: pidFile },
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: false });
    await until(named(made, "connected"));
    const pid = await pidIn(pidFile);
    await Promise.all([made.controller.stop(), made.controller.stop()]);
    expect(alive(pid)).toBe(false);
    expect(phaseOf(made)).toEqual({ name: "stopped" });
  });

  it("is not left by a drop or a timer that fires afterwards", async () => {
    const host = await testHost();
    const made = await make({
      setting: { mode: "resident", url: baseUrl(host) },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    await made.controller.stop();
    await closeHost(host);
    await new Promise((resolve) => setTimeout(resolve, FAST.giveUpMs + 500));
    expect(phaseOf(made)).toEqual({ name: "stopped" });
  });
});

describe("killTemporaryNow", () => {
  it("kills the temporary host without waiting", async () => {
    const target = await testHost();
    const program = await dualProgram();
    const pidFile = join(await tempDir(), "pid");
    const made = await make({
      env: { FAKE_PORT: String(target.port), FAKE_PID_FILE: pidFile },
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: false });
    await until(named(made, "connected"));
    const pid = await pidIn(pidFile);
    const result = made.controller.killTemporaryNow();
    expect(result).toBeUndefined();
    await until(() => !alive(pid), 5_000, "the temporary host to die");
  });
});

describe("the state object", () => {
  it("is a new object on every change, and an old one is never changed", async () => {
    const host = await testHost();
    const made = await make({
      setting: { mode: "resident", url: baseUrl(host) },
    });
    const idle = made.controller.getState();
    const frozen = structuredClone({ ...idle, wire: undefined });
    await made.controller.start();
    await until(named(made, "connected"));
    expect({ ...idle, wire: undefined }).toEqual(frozen);
    expect(idle.phase).toEqual({ name: "idle" });
    for (let index = 1; index < made.states.length; index += 1)
      expect(made.states[index]).not.toBe(made.states[index - 1]);
    // Listeners are told only of changes; the last state they saw is the current one.
    expect(made.states.at(-1)).toBe(made.controller.getState());
  });

  it("stops telling a listener after it unsubscribes", async () => {
    const made = await make();
    let heard = 0;
    const off = made.controller.subscribe(() => {
      heard += 1;
    });
    off();
    await made.controller.start();
    expect(heard).toBe(0);
  });
});

/** The pids the temporary hosts of `dualProgram` wrote into `dir`, once there are `count`. */
async function pidsIn(dir: string, count: number): Promise<number[]> {
  await until(async () => (await readdir(dir)).length >= count, 10_000);
  return (await readdir(dir)).map(Number);
}

const elapsed = (since: number) => Date.now() - since;

describe("the grace period", () => {
  it("gives up on a first attempt that never gets an answer", async () => {
    // Accepts the connection and never answers the upgrade: a host that is hung or stopped.
    const silent = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => undefined),
    });
    try {
      const url = `http://127.0.0.1:${silent.port}`;
      const made = await make({ setting: { mode: "resident", url } });
      const before = Date.now();
      await made.controller.start();
      await until(named(made, "unreachable"), 10_000);
      expect(elapsed(before)).toBeGreaterThanOrEqual(FAST.giveUpMs - 50);
      expect(elapsed(before)).toBeLessThan(FAST.giveUpMs + 1_000);
      expect(phaseOf(made)).toEqual({
        name: "unreachable",
        url,
        reason: "timeout",
        output: undefined,
      });
      expect(made.controller.getState().wire).toBeUndefined();
    } finally {
      void silent.stop(true);
    }
  });

  it("counts from the first attempt when that attempt fails late, not from the failure", async () => {
    // Every attempt fails after 600 ms; the grace period still ends 1.5 s after the start.
    const slow = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return new Response("no", { status: 503 });
      },
    });
    try {
      const made = await make({
        setting: { mode: "resident", url: `http://127.0.0.1:${slow.port}` },
      });
      const before = Date.now();
      await made.controller.start();
      await until(named(made, "unreachable"), 10_000);
      expect(elapsed(before)).toBeGreaterThanOrEqual(FAST.giveUpMs - 50);
      expect(elapsed(before)).toBeLessThan(FAST.giveUpMs + 400);
    } finally {
      void slow.stop(true);
    }
  });
});

describe("a refused token", () => {
  it("closes the wire: the host sees no more connections once it is unauthorized", async () => {
    let hits = 0;
    const gate = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        if (new URL(request.url).pathname === "/ws") hits += 1;
        return new Response("unauthorized", { status: 401 });
      },
    });
    try {
      const made = await make({
        setting: { mode: "resident", url: `http://127.0.0.1:${gate.port}` },
      });
      await made.controller.start();
      await until(named(made, "unauthorized"));
      // The probe that found the 401 may still be on its way in.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const seen = hits;
      // Retries run every 50 to 200 ms here: a wire left open would add several.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(hits).toBe(seen);
      expect(phaseOf(made).name).toBe("unauthorized");
    } finally {
      void gate.stop(true);
    }
  });

  it("is noticed while reconnecting, when the host comes back with another token", async () => {
    const host = await testHost({ token: TOKEN });
    const { port, dataDir } = host;
    const url = baseUrl(host);
    const made = await make({
      setting: { mode: "resident", url, token: TOKEN },
      timing: { giveUpMs: 20_000 },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    await closeHost(host);
    await until(named(made, "reconnecting"));
    await testHost({ port, dataDir, token: "another-token-0123456789" });
    await until(
      () => ["unauthorized", "unreachable"].includes(phaseOf(made).name),
      20_000,
    );
    expect(phaseOf(made)).toEqual({ name: "unauthorized", url });
  });
});

describe("the handover's order", () => {
  it("runs install-service only once the temporary host has ended", async () => {
    const temporaryTarget = await testHost();
    const local = await testHost();
    const program = await dualProgram();
    const pidFile = join(await tempDir(), "pid");
    const made = await make({
      env: {
        FAKE_PORT: String(temporaryTarget.port),
        FAKE_PID_FILE: pidFile,
        FAKE_REFUSE_IF_ALIVE: "1",
      },
      localUrl: baseUrl(local),
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: false });
    await until(named(made, "connected"));
    await made.controller.handover();
    await until(
      () => ["connected", "install-failed"].includes(phaseOf(made).name),
      10_000,
    );
    expect(phaseOf(made)).toEqual({
      name: "connected",
      url: baseUrl(local),
      temporary: false,
    });
  });
});

describe("actions that overlap", () => {
  it("stop ends a temporary host that is still starting, without waiting for it to be ready", async () => {
    const program = await dualProgram();
    const pidFile = join(await tempDir(), "pid");
    const made = await make({
      env: { FAKE_PID_FILE: pidFile, FAKE_NEVER_READY: "1" },
      findHost: () => program,
      timing: { temporaryStartMs: 60_000 },
    });
    await made.controller.start();
    const starting = made.controller.startTemporary({ persist: false });
    const pid = await pidIn(pidFile);
    expect(phaseOf(made).name).toBe("starting-temporary");
    const before = Date.now();
    await made.controller.stop();
    expect(elapsed(before)).toBeLessThan(5_000);
    expect(alive(pid)).toBe(false);
    await starting;
    expect(phaseOf(made)).toEqual({ name: "stopped" });
  });

  it("killTemporaryNow kills a temporary host that is still starting", async () => {
    const program = await dualProgram();
    const pidFile = join(await tempDir(), "pid");
    const made = await make({
      env: { FAKE_PID_FILE: pidFile, FAKE_NEVER_READY: "1" },
      findHost: () => program,
      timing: { temporaryStartMs: 60_000 },
    });
    await made.controller.start();
    void made.controller.startTemporary({ persist: false });
    const pid = await pidIn(pidFile);
    made.controller.killTemporaryNow();
    await until(() => !alive(pid), 5_000, "the starting host to die");
  });

  it("stop ends install-service while it runs", async () => {
    const program = await dualProgram();
    const installPid = join(await tempDir(), "install-pid");
    const made = await make({
      env: {
        FAKE_INSTALL_PID_FILE: installPid,
        FAKE_INSTALL_SLEEP_MS: "60000",
      },
      findHost: () => program,
      timing: { installRunMs: 60_000 },
    });
    await made.controller.start();
    const installing = made.controller.installResident();
    const pid = await pidIn(installPid);
    expect(phaseOf(made)).toEqual({ name: "installing", step: "running" });
    const before = Date.now();
    await made.controller.stop();
    expect(elapsed(before)).toBeLessThan(5_000);
    await until(() => !alive(pid), 5_000, "install-service to die");
    await installing;
    expect(phaseOf(made)).toEqual({ name: "stopped" });
  });

  it("a newer action wins: a temporary host that starts after connectResident is stopped and never used", async () => {
    const temporaryTarget = await testHost();
    const resident = await testHost();
    const program = await dualProgram();
    const pidFile = join(await tempDir(), "pid");
    const made = await make({
      env: {
        FAKE_PORT: String(temporaryTarget.port),
        FAKE_PID_FILE: pidFile,
        FAKE_READY_AFTER_MS: "1500",
      },
      findHost: () => program,
    });
    await made.controller.start();
    const starting = made.controller.startTemporary({ persist: false });
    const pid = await pidIn(pidFile);
    const from = made.phases.length;
    await made.controller.connectResident({ url: baseUrl(resident) });
    await until(named(made, "connected"));
    await starting;
    await until(() => !alive(pid), 10_000, "the superseded host to be stopped");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(phaseOf(made)).toEqual({
      name: "connected",
      url: baseUrl(resident),
      temporary: false,
    });
    const later = made.phases.slice(from);
    expect(
      later.filter((phase) => "temporary" in phase && phase.temporary),
    ).toEqual([]);
    expect(made.controller.getState().setting).toEqual({
      mode: "resident",
      url: baseUrl(resident),
    });
  });

  it("killTemporaryNow reaches a temporary host that is stopping and ignores the request", async () => {
    const target = await testHost();
    const program = await dualProgram();
    const pidFile = join(await tempDir(), "pid");
    const made = await make({
      env: {
        FAKE_PORT: String(target.port),
        FAKE_PID_FILE: pidFile,
        FAKE_IGNORE_STOP: "1",
      },
      findHost: () => program,
      timing: { temporaryStopMs: 30_000 },
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: false });
    await until(named(made, "connected"));
    const pid = await pidIn(pidFile);
    const stopping = made.controller.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(pid)).toBe(true);
    made.controller.killTemporaryNow();
    await until(() => !alive(pid), 5_000, "the stopping host to die");
    await stopping;
  });

  it("killTemporaryNow reaches a start that a second start replaced", async () => {
    const program = await dualProgram();
    const pidDir = await tempDir();
    const made = await make({
      env: { FAKE_PID_DIR: pidDir, FAKE_NEVER_READY: "1" },
      findHost: () => program,
      timing: { temporaryStartMs: 60_000 },
    });
    await made.controller.start();
    void made.controller.startTemporary({ persist: false });
    await pidsIn(pidDir, 1);
    void made.controller.startTemporary({ persist: false });
    const pids = await pidsIn(pidDir, 2);
    made.controller.killTemporaryNow();
    await until(
      () => pids.every((pid) => !alive(pid)),
      5_000,
      "both starts to die",
    );
  });

  it("stop ends a start that a second start replaced", async () => {
    const program = await dualProgram();
    const pidDir = await tempDir();
    const made = await make({
      env: { FAKE_PID_DIR: pidDir, FAKE_NEVER_READY: "1" },
      findHost: () => program,
      timing: { temporaryStartMs: 60_000 },
    });
    await made.controller.start();
    void made.controller.startTemporary({ persist: false });
    await pidsIn(pidDir, 1);
    void made.controller.startTemporary({ persist: false });
    const pids = await pidsIn(pidDir, 2);
    const before = Date.now();
    await made.controller.stop();
    expect(elapsed(before)).toBeLessThan(5_000);
    expect(pids.filter((pid) => alive(pid))).toEqual([]);
  });
});

describe("stopping", () => {
  it("is stopped from the moment stop is called, while the temporary host is still ending", async () => {
    const target = await testHost();
    const program = await dualProgram();
    const made = await make({
      env: { FAKE_PORT: String(target.port) },
      findHost: () => program,
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: false });
    await until(named(made, "connected"));
    const from = made.phases.length;
    const stopping = made.controller.stop();
    expect(phaseOf(made)).toEqual({ name: "stopped" });
    await stopping;
    const after = made.phases.slice(from).map((phase) => phase.name);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((name) => name !== "stopped")).toEqual([]);
  });
});
