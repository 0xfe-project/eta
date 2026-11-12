/**
 * The controller asks `eta-host running` before it starts a host on this computer, and offers the
 * host it names instead. `eta-host` is a script here: it answers `running` with what the test
 * puts in a file, and logs every other start, so a test can tell no host was started.
 */
import type {
  ControllerDeps,
  ControllerTiming,
} from "../../src/connection/controller";
import type {
  ConnectionController,
  ConnectionPhase,
  HostProgram,
} from "../../src/connection/types";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectionController } from "../../src/connection/controller";
import { script } from "../support/fake-programs";
import { baseUrl, closedPort, closeHost, testHost } from "../support/host";
import { tempDir, until } from "../support/temp";

const FAST: ControllerTiming = {
  giveUpMs: 1_500,
  initialRetryMs: 50,
  maxRetryMs: 200,
  probeTimeoutMs: 500,
  temporaryStartMs: 30_000,
  temporaryStopMs: 10_000,
  installRunMs: 30_000,
  installUpMs: 3_000,
  runningMs: 10_000,
};

type Controller = ConnectionController & { killTemporaryNow: () => void };
const controllers: Controller[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
});

/**
 * `eta-host` as a script. As `running` it prints the file `FAKE_ANSWER_FILE` (`null` when it is
 * missing) after `FAKE_RUNNING_DELAY_MS`, hangs with `FAKE_RUNNING_HANG`, names itself by pid in
 * `FAKE_RUNNING_PID_DIR`, and exits with
 * `FAKE_RUNNING_EXIT`. As `install-service` it exits with `FAKE_INSTALL_EXIT`. Otherwise it is a
 * temporary host saying the port `FAKE_PORT` after `FAKE_READY_AFTER_MS`, ending on a stop request
 * unless `FAKE_IGNORE_STOP`.
 * Every start appends its arguments to `FAKE_LOG`.
 */
function hostScript(): Promise<HostProgram> {
  return script(`
import { appendFileSync, readFileSync } from "node:fs";
const env = process.env;
const args = process.argv.slice(2);
appendFileSync(env.FAKE_LOG, JSON.stringify(args) + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (args[0] === "running") {
  if (env.FAKE_RUNNING_PID_DIR) appendFileSync(env.FAKE_RUNNING_PID_DIR + "/" + process.pid, "");
  if (env.FAKE_RUNNING_HANG) await new Promise(() => setInterval(() => undefined, 1_000));
  await sleep(Number(env.FAKE_RUNNING_DELAY_MS ?? 0));
  let answer = "null";
  try { answer = readFileSync(env.FAKE_ANSWER_FILE, "utf8"); } catch {}
  console.log(answer);
  process.exit(Number(env.FAKE_RUNNING_EXIT ?? 0));
}
if (args[0] === "install-service") {
  console.log("installed");
  process.exit(Number(env.FAKE_INSTALL_EXIT ?? 0));
}
const ignoreStop = Boolean(env.FAKE_IGNORE_STOP);
if (env.ETA_STOP_PIPE) {
  const { createServer } = await import("node:net");
  createServer((socket) => socket.on("data", () => { if (!ignoreStop) process.exit(0); })).listen(env.ETA_STOP_PIPE);
}
process.on("SIGTERM", () => { if (!ignoreStop) process.exit(0); });
await sleep(Number(env.FAKE_READY_AFTER_MS ?? 0));
console.log(JSON.stringify({ port: Number(env.FAKE_PORT) }));
setInterval(() => undefined, 1_000);
`);
}

interface Made {
  controller: Controller;
  phases: ConnectionPhase[];
  config: string;
  /** Says what `running` answers from now on. */
  answer: (value: unknown) => Promise<void>;
  /** The arguments of every start of `eta-host`, in order. */
  starts: () => Promise<string[][]>;
  /** How many starts were not `running`: temporary hosts and `install-service`. */
  hostStarts: () => Promise<number>;
}

async function make(
  options: {
    env?: NodeJS.ProcessEnv;
    deps?: Partial<ControllerDeps>;
    timing?: Partial<ControllerTiming>;
  } = {},
): Promise<Made> {
  const dir = await tempDir("eta-tui-existing-");
  const config = join(dir, "tui.json");
  const log = join(dir, "starts.log");
  const answerFile = join(dir, "answer.json");
  const program = await hostScript();
  const controller = createConnectionController({
    paths: { config, state: join(dir, "tui-state.json") },
    setting: undefined,
    env: { FAKE_LOG: log, FAKE_ANSWER_FILE: answerFile, ...options.env },
    findHost: () => program,
    tuiVersion: "dev",
    // Never the real 127.0.0.1:8787.
    localUrl: `http://127.0.0.1:${await closedPort()}`,
    ...options.deps,
    timing: { ...FAST, ...options.timing },
  });
  controllers.push(controller);
  const phases: ConnectionPhase[] = [controller.getState().phase];
  controller.subscribe(() => phases.push(controller.getState().phase));
  const starts = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);
  return {
    controller,
    phases,
    config,
    answer: (value) => writeFile(answerFile, JSON.stringify(value)),
    starts,
    hostStarts: async () =>
      (await starts()).filter((args) => args[0] !== "running").length,
  };
}

const phaseOf = (made: Made) => made.controller.getState().phase;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid of the one `eta-host running` started so far, once it has started. */
async function askingPid(dir: string): Promise<number> {
  await until(async () => (await readdir(dir)).length > 0, 10_000);
  const names = await readdir(dir);
  expect(names).toHaveLength(1);
  return Number(names[0]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const named = (made: Made, name: ConnectionPhase["name"]) => () =>
  phaseOf(made).name === name;

async function settings(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

const OTHER = "http://127.0.0.1:54321";
const TOKEN = "tok-0123456789abcdef";

describe("first-run", () => {
  it("suggests the host `eta-host running` names, over one answering at the local address", async () => {
    const local = await testHost();
    const made = await make({ deps: { localUrl: baseUrl(local) } });
    await made.answer({ address: OTHER, tokenFile: null, from: "record" });
    await made.controller.start();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: OTHER,
    });
    expect(await made.starts()).toEqual([["running"]]);
  });

  it("suggests the local address when `eta-host running` names none", async () => {
    const local = await testHost();
    const made = await make({ deps: { localUrl: baseUrl(local) } });
    await made.controller.start();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: baseUrl(local),
    });
  });

  it("suggests the local address when `eta-host running` cannot say", async () => {
    const local = await testHost();
    const made = await make({
      deps: { localUrl: baseUrl(local) },
      env: { FAKE_RUNNING_EXIT: "2" },
    });
    await made.answer({ address: OTHER, tokenFile: null, from: "record" });
    await made.controller.start();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: baseUrl(local),
    });
  });
});

describe("before a temporary host", () => {
  it("offers the host already running instead, with the token from its file, and starts none", async () => {
    const tokenFile = join(await tempDir(), "access-token");
    await writeFile(tokenFile, "tok-from-file\n");
    const made = await make();
    await made.controller.start();
    await made.answer({ address: OTHER, tokenFile, from: "record" });
    await made.controller.startTemporary({ persist: true });
    expect(phaseOf(made)).toEqual({
      name: "existing-host",
      url: OTHER,
      token: { kind: "read", value: "tok-from-file" },
      wanted: "temporary",
    });
    expect(await made.hostStarts()).toBe(0);
    expect(await settings(made.config)).toBeUndefined();
  });

  it("names the token file it could not read", async () => {
    const missing = join(await tempDir(), "access-token");
    const made = await make();
    await made.controller.start();
    await made.answer({ address: OTHER, tokenFile: missing, from: "service" });
    await made.controller.startTemporary({ persist: true });
    expect(phaseOf(made)).toMatchObject({
      name: "existing-host",
      token: { kind: "unreadable", file: missing },
    });
  });

  it("starts the temporary host once `eta-host running` has had its time", async () => {
    const target = await testHost();
    const hanging = await make({
      env: { FAKE_PORT: String(target.port), FAKE_RUNNING_HANG: "1" },
      deps: { setting: { mode: "temporary" } },
      timing: { runningMs: 1_000 },
    });
    const begun = Date.now();
    await hanging.controller.start();
    await until(named(hanging, "connected"));
    expect(Date.now() - begun).toBeLessThan(6_000);
    expect(await hanging.hostStarts()).toBe(1);
    expect(hanging.phases.map((phase) => phase.name)).not.toContain(
      "existing-host",
    );
  });

  it("asks before the temporary host from the settings, and goes back to the first-run choices", async () => {
    const made = await make({ deps: { setting: { mode: "temporary" } } });
    await made.answer({ address: OTHER, tokenFile: null, from: "record" });
    await made.controller.start();
    expect(phaseOf(made)).toMatchObject({
      name: "existing-host",
      url: OTHER,
      token: { kind: "none" },
      wanted: "temporary",
    });
    expect(await made.hostStarts()).toBe(0);
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: OTHER,
    });
    expect(await made.hostStarts()).toBe(0);
  });

  it("asks before the unreachable choices' temporary host, and goes back to those choices", async () => {
    const port = await closedPort();
    const made = await make({
      deps: {
        setting: { mode: "resident", url: `http://127.0.0.1:${port}` },
      },
    });
    await made.controller.start();
    await until(named(made, "unreachable"), 10_000);
    const unreachable = phaseOf(made);
    await made.answer({ address: OTHER, tokenFile: null, from: "record" });
    await made.controller.startTemporary({ persist: false });
    expect(phaseOf(made)).toMatchObject({ name: "existing-host", url: OTHER });
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toEqual(unreachable);
    expect(await made.hostStarts()).toBe(0);
  });

  it("does not take its own temporary host, replaced and still ending, for another", async () => {
    const target = await testHost();
    const made = await make({
      env: {
        FAKE_PORT: String(target.port),
        FAKE_IGNORE_STOP: "1",
        FAKE_READY_AFTER_MS: "1000",
        FAKE_RUNNING_DELAY_MS: "2000",
      },
      timing: { temporaryStopMs: 4_000 },
    });
    await made.controller.start();
    const first = made.controller.startTemporary({ persist: false });
    await until(async () => (await made.hostStarts()) === 1, 10_000);
    // The first host is starting. From here `running` names it; the second start replaces it, and
    // it becomes ready and is told to stop (which it ignores) while the second start asks.
    await made.answer({
      address: baseUrl(target),
      tokenFile: null,
      from: "record",
    });
    await made.controller.startTemporary({ persist: false });
    await first;
    await until(named(made, "connected"));
    expect(await made.hostStarts()).toBe(2);
    expect(made.phases.map((phase) => phase.name)).not.toContain(
      "existing-host",
    );
  });
});

describe("before installing the service", () => {
  it("offers the host already running instead, and does not run install-service", async () => {
    const made = await make();
    await made.controller.start();
    await made.answer({ address: OTHER, tokenFile: null, from: "service" });
    await made.controller.installResident();
    expect(phaseOf(made)).toEqual({
      name: "existing-host",
      url: OTHER,
      token: { kind: "none" },
      wanted: "install",
    });
    expect(await made.hostStarts()).toBe(0);
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: OTHER,
    });
  });

  it("runs install-service when `eta-host running` cannot say", async () => {
    const made = await make({
      env: { FAKE_RUNNING_EXIT: "1", FAKE_INSTALL_EXIT: "4" },
    });
    await made.controller.start();
    await made.answer({ address: OTHER, tokenFile: null, from: "service" });
    await made.controller.installResident();
    expect(phaseOf(made)).toMatchObject({
      name: "install-failed",
      step: "running",
    });
    expect((await made.starts()).at(-1)).toEqual(["install-service"]);
  });
});

describe("in a handover", () => {
  it("asks once its own temporary host is stopped, and goes back to the first-run choices", async () => {
    const target = await testHost();
    const made = await make({ env: { FAKE_PORT: String(target.port) } });
    await made.controller.start();
    await made.controller.startTemporary({ persist: true });
    await until(named(made, "connected"));
    await made.answer({ address: OTHER, tokenFile: null, from: "service" });
    await made.controller.handover();
    expect(phaseOf(made)).toMatchObject({
      name: "existing-host",
      url: OTHER,
      wanted: "install",
    });
    const starts = await made.starts();
    expect(starts.filter((args) => args[0] === "install-service")).toEqual([]);
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: OTHER,
    });
    expect(await made.hostStarts()).toBe(1);
  });

  it("asks before starting the temporary host again after a failed install", async () => {
    const target = await testHost();
    const made = await make({
      env: { FAKE_PORT: String(target.port), FAKE_INSTALL_EXIT: "3" },
    });
    await made.controller.start();
    await made.controller.startTemporary({ persist: true });
    await until(named(made, "connected"));
    await made.controller.handover();
    expect(phaseOf(made)).toMatchObject({ name: "install-failed" });
    await made.answer({ address: OTHER, tokenFile: null, from: "record" });
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toMatchObject({
      name: "existing-host",
      url: OTHER,
      wanted: "temporary",
    });
    // The temporary host and install-service; no second temporary host.
    expect(await made.hostStarts()).toBe(2);
    await made.controller.dismissFailure();
    expect(phaseOf(made)).toEqual({
      name: "first-run",
      suggestedUrl: OTHER,
    });
    expect(await made.hostStarts()).toBe(2);
  });
});

describe("when the loopback address in the settings does not answer", () => {
  it("connects to the host running here at another address, for this run, with the token from its file", async () => {
    const host = await testHost({ token: TOKEN });
    const tokenFile = join(await tempDir(), "access-token");
    await writeFile(tokenFile, `${TOKEN}\n`);
    const configured = `http://127.0.0.1:${await closedPort()}`;
    const setting = { mode: "resident", url: configured } as const;
    const made = await make({
      deps: { setting },
      timing: { giveUpMs: 20_000 },
    });
    await made.answer({ address: baseUrl(host), tokenFile, from: "record" });
    await made.controller.start();
    await until(named(made, "connected"));
    expect(phaseOf(made)).toEqual({
      name: "connected",
      url: baseUrl(host),
      temporary: false,
    });
    const state = made.controller.getState();
    expect(state.fallback).toEqual({ configured, url: baseUrl(host) });
    expect(state.setting).toEqual(setting);
    expect(await settings(made.config)).toBeUndefined();
    expect(made.phases.map((phase) => phase.name)).not.toContain(
      "reconnecting",
    );
    expect(await made.starts()).toEqual([["running"]]);
  });

  it("goes to the token form when the host found asks for a token its file cannot give", async () => {
    const host = await testHost({ token: TOKEN });
    const configured = `http://127.0.0.1:${await closedPort()}`;
    const made = await make({
      deps: { setting: { mode: "resident", url: configured } },
      timing: { giveUpMs: 20_000 },
    });
    await made.answer({
      address: baseUrl(host),
      tokenFile: join(await tempDir(), "missing-token"),
      from: "record",
    });
    await made.controller.start();
    await until(named(made, "unauthorized"));
    expect(phaseOf(made)).toEqual({ name: "unauthorized", url: baseUrl(host) });
    expect(await settings(made.config)).toBeUndefined();
  });

  it("retries as before when `eta-host running` names none", async () => {
    const configured = `http://127.0.0.1:${await closedPort()}`;
    const made = await make({
      deps: { setting: { mode: "resident", url: configured } },
    });
    await made.controller.start();
    await until(named(made, "reconnecting"));
    await until(named(made, "unreachable"), 10_000);
    expect(phaseOf(made)).toMatchObject({
      name: "unreachable",
      url: configured,
    });
    expect(await made.starts()).toEqual([["running"]]);
    expect(made.controller.getState().fallback).toBeUndefined();
  });

  it("retries as before when `eta-host running` names the same address", async () => {
    const configured = `http://127.0.0.1:${await closedPort()}`;
    const made = await make({
      deps: { setting: { mode: "resident", url: configured } },
    });
    await made.answer({ address: configured, tokenFile: null, from: "record" });
    await made.controller.start();
    await until(named(made, "unreachable"), 10_000);
    expect(phaseOf(made)).toMatchObject({
      name: "unreachable",
      url: configured,
    });
    expect(made.phases.map((phase) => phase.name)).toContain("reconnecting");
    expect(await made.starts()).toEqual([["running"]]);
  });

  it("does not ask for an address that is not this computer", async () => {
    const configured = "http://eta-tui-test.invalid:8787";
    const made = await make({
      deps: { setting: { mode: "resident", url: configured } },
      timing: { giveUpMs: 20_000 },
    });
    await made.answer({ address: OTHER, tokenFile: null, from: "record" });
    await made.controller.start();
    await until(named(made, "reconnecting"), 20_000);
    expect(await made.starts()).toEqual([]);
  });

  it("asks again when the host in use drops, and moves to the one found", async () => {
    const first = await testHost();
    const second = await testHost();
    const setting = { mode: "resident", url: baseUrl(first) } as const;
    const made = await make({
      deps: { setting },
      timing: { giveUpMs: 20_000 },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    expect(await made.starts()).toEqual([]);
    await made.answer({
      address: baseUrl(second),
      tokenFile: null,
      from: "record",
    });
    await closeHost(first);
    await until(
      () => made.controller.getState().fallback?.url === baseUrl(second),
      10_000,
    );
    await until(named(made, "connected"));
    expect(phaseOf(made)).toEqual({
      name: "connected",
      url: baseUrl(second),
      temporary: false,
    });
    expect(made.controller.getState().fallback).toEqual({
      configured: baseUrl(first),
      url: baseUrl(second),
    });
    expect(made.controller.getState().setting).toEqual(setting);
    expect(await settings(made.config)).toBeUndefined();
    expect(await made.starts()).toEqual([["running"]]);
  });
});

describe("when the connection comes back or goes home while `eta-host running` is asked", () => {
  it("retries a loss that came after the connection was back, and does not take the host named", async () => {
    const dataDir = await tempDir("eta-tui-back-");
    const first = await testHost({ dataDir });
    const port = first.port;
    const url = baseUrl(first);
    const made = await make({
      deps: { setting: { mode: "resident", url } },
      env: { FAKE_RUNNING_DELAY_MS: "3000" },
    });
    await made.controller.start();
    await until(named(made, "connected"));
    await made.answer({ address: OTHER, tokenFile: null, from: "record" });
    await closeHost(first);
    // Asking now. The host comes back (a hello), then goes again, before the answer.
    await until(async () => (await made.starts()).length === 1, 10_000);
    const again = await testHost({ dataDir, port });
    await until(
      () => made.controller.getState().wire?.store.getState().status === "open",
      10_000,
    );
    await closeHost(again);
    await until(named(made, "unreachable"), 15_000);
    expect(phaseOf(made)).toMatchObject({ name: "unreachable", url });
    expect(made.phases.map((phase) => phase.name)).toContain("reconnecting");
    expect(made.controller.getState().fallback).toBeUndefined();
  });

  it("goes back to the address in the settings, with its token, when `eta-host running` names it again", async () => {
    const configuredPort = await closedPort();
    const configured = `http://127.0.0.1:${configuredPort}`;
    const setting = {
      mode: "resident",
      url: configured,
      token: TOKEN,
    } as const;
    const stand = await testHost();
    const made = await make({
      deps: { setting },
      timing: { giveUpMs: 20_000 },
    });
    await made.answer({
      address: baseUrl(stand),
      tokenFile: null,
      from: "record",
    });
    await made.controller.start();
    await until(
      () => made.controller.getState().fallback?.url === baseUrl(stand),
      10_000,
    );
    await until(named(made, "connected"));
    // The host of the settings is back, asks for the settings' token, and is the one named.
    await testHost({ port: configuredPort, token: TOKEN });
    await made.answer({ address: configured, tokenFile: null, from: "record" });
    await closeHost(stand);
    await until(
      () =>
        phaseOf(made).name === "connected" &&
        (phaseOf(made) as { url: string }).url === configured,
      15_000,
    );
    expect(made.controller.getState().fallback).toBeUndefined();
    expect(await settings(made.config)).toBeUndefined();
  });
});

describe("stopped while `eta-host running` is asked", () => {
  // `runningMs` is the default 10 s: a command still alive 3 s after the stop was not ended by it.
  async function asking() {
    const pidDir = await tempDir("eta-tui-asking-");
    const made = await make({
      env: { FAKE_RUNNING_HANG: "1", FAKE_RUNNING_PID_DIR: pidDir },
    });
    return { made, pidDir };
  }

  it("starts no temporary host, and ends the command", async () => {
    const { made, pidDir } = await asking();
    const pending = made.controller.startTemporary({ persist: true });
    const pid = await askingPid(pidDir);
    await made.controller.stop();
    await until(() => !alive(pid), 3_000, "the command to end");
    await pending;
    await sleep(1_000);
    expect(await made.hostStarts()).toBe(0);
    expect(phaseOf(made)).toEqual({ name: "stopped" });
    expect(await settings(made.config)).toBeUndefined();
  });

  it("does not run install-service, and ends the command", async () => {
    const { made, pidDir } = await asking();
    const pending = made.controller.installResident();
    const pid = await askingPid(pidDir);
    await made.controller.stop();
    await until(() => !alive(pid), 3_000, "the command to end");
    await pending;
    await sleep(1_000);
    expect(await made.hostStarts()).toBe(0);
    expect(phaseOf(made)).toEqual({ name: "stopped" });
  });

  it("killTemporaryNow ends the command too", async () => {
    const { made, pidDir } = await asking();
    void made.controller.startTemporary({ persist: true });
    const pid = await askingPid(pidDir);
    made.controller.killTemporaryNow();
    await until(() => !alive(pid), 3_000, "the command to end");
  });
});
