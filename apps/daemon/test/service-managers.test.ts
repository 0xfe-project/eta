/**
 * What each kind of service manager is asked, and what its answers are taken to mean. The managers
 * themselves are not here: the real ones run in the sandbox and in `upgrade-e2e.yml`.
 */
import type { Exec, ServiceUnit } from "../src/service";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchdManager, launchdRunner } from "../src/service-launchd";
import { detachedRunner, serviceManager } from "../src/service-manager";
import { systemdManager, systemdRunner } from "../src/service-systemd";
import {
  commandLine,
  windowsManager,
  windowsRunner,
} from "../src/service-windows";
import { ERROR_ACCESS_DENIED, WindowsError } from "../src/windows-api";

const unit: ServiceUnit = {
  name: "io.eta.host",
  description: "eta host",
  args: [],
};
const command = { program: "/opt/eta-host", args: ["--port", "8790"] };
const uid = process.getuid?.() ?? 501;
const job = {
  name: "io.eta.host-upgrade",
  argv: ["/opt/eta-host", "upgrade"],
  passEnv: ["SERVICE_TEST_TOKEN"],
};

type Answer = string | Error;

/** Stands in for `execFile`: answers by the first words of a call, and remembers each one. */
function recorder(answers: Record<string, Answer | Answer[]> = {}) {
  const calls: string[] = [];
  const run: Exec = (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    const key = Object.keys(answers).find((start) => line.startsWith(start));
    const answer = key === undefined ? "" : answers[key];
    const next = Array.isArray(answer) ? answer.shift() : answer;
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve({ stdout: next ?? "", stderr: "" });
  };
  return { calls, run };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "eta-service-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  delete process.env.SERVICE_TEST_TOKEN;
});

describe("systemd", () => {
  const show = (facts: Record<string, string>) =>
    Object.entries(facts)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

  it("tells a running unit from one between two starts", async () => {
    const { run } = recorder({
      "systemctl --user show": [
        show({
          ActiveState: "active",
          SubState: "running",
          MainPID: "42",
        }),
        show({
          ActiveState: "activating",
          SubState: "auto-restart",
          MainPID: "0",
        }),
      ],
    });
    const manager = systemdManager(unit, home, run);
    expect(await manager.status()).toEqual({
      running: true,
      crashed: false,
      restarting: false,
      pid: 42,
    });
    expect(await manager.status()).toEqual({
      running: false,
      crashed: true,
      restarting: true,
      pid: 0,
    });
  });

  it("reads what a loaded unit runs, and has no service with no unit", async () => {
    const path = join(home, "unit.service");
    await writeFile(path, 'ExecStart="/opt/eta host" "--port" "8790"\n');
    const { run } = recorder({
      "systemctl --user show": [
        show({ LoadState: "loaded", FragmentPath: path }),
        show({ LoadState: "not-found" }),
      ],
    });
    const manager = systemdManager(unit, home, run);
    expect(await manager.installed()).toEqual([
      "/opt/eta host",
      "--port",
      "8790",
    ]);
    expect(await manager.installed()).toBeUndefined();
  });

  it("is no service when systemd is not there, but a unit it cannot be asked about is an error", async () => {
    const { run } = recorder({
      "systemctl --user show": new Error("no bus"),
    });
    const manager = systemdManager(unit, home, run);
    expect(await manager.installed()).toBeUndefined();
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(
      join(home, ".config", "systemd", "user", "io.eta.host.service"),
      "",
    );
    await expect(manager.installed()).rejects.toThrow(
      /systemd does not answer: no bus/,
    );
  });

  it("restarts on install, so an install over an older one runs the new file", async () => {
    const { calls, run } = recorder();
    await systemdManager(unit, home, run).install(command);
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable io.eta.host.service",
      "systemctl --user restart io.eta.host.service",
    ]);
  });

  it("names a detached run's variables and never their values", async () => {
    process.env.SERVICE_TEST_TOKEN = "s3cret";
    const { calls, run } = recorder();
    await systemdRunner(run).start(job);
    expect(calls).toEqual([
      "systemd-run --user --unit=io.eta.host-upgrade --collect --quiet --property=KillMode=mixed --property=TimeoutStopSec=infinity --setenv=SERVICE_TEST_TOKEN -- /opt/eta-host upgrade",
    ]);
    await systemdRunner(run).stop(job.name);
    expect(calls[1]).toBe(
      "systemctl --user stop --no-block io.eta.host-upgrade",
    );
  });
});

describe("launchd", () => {
  const target = `gui/${uid}/io.eta.host`;
  const printed = (state: string, rest = "") =>
    `${target} = {\n\tactive count = 1\n\tstate = ${state}\n${rest}\tendpoints = {\n\t\t"x" = {\n\t\t\tstate = active\n\t\t}\n\t}\n}\n`;

  it("reads a running job's pid, not the state of something inside it", async () => {
    const { run } = recorder({
      "launchctl print": printed("running", "\tpid = 77\n"),
    });
    expect(await launchdManager(unit, home, run).status()).toEqual({
      running: true,
      crashed: false,
      restarting: false,
      pid: 77,
    });
  });

  it("knows a failed job is waiting for `KeepAlive`, and a clean exit is not", async () => {
    const { run } = recorder({
      "launchctl print": [
        printed("spawn scheduled", "\tlast exit code = 1\n"),
        printed(
          "spawn scheduled",
          "\tlast exit code = 0\n\tlast terminating signal = Killed: 9\n",
        ),
        printed("not running", "\tlast exit code = 0\n"),
      ],
    });
    const manager = launchdManager(unit, home, run);
    const waiting = { running: false, crashed: true, restarting: true };
    expect(await manager.status()).toMatchObject(waiting);
    expect(await manager.status()).toMatchObject(waiting);
    expect(await manager.status()).toMatchObject({
      running: false,
      crashed: true,
      restarting: false,
    });
  });

  it("does not take a job that has not run yet for one that exited", async () => {
    const { run } = recorder({
      "launchctl print": printed(
        "spawn scheduled",
        "\tlast exit code = (never exited)\n",
      ),
    });
    expect(await launchdManager(unit, home, run).status()).toEqual({
      running: false,
      crashed: false,
      restarting: true,
      pid: 0,
    });
  });

  it("calls a job launchd does not have stopped", async () => {
    const { run } = recorder({ "launchctl print": new Error("113") });
    expect(await launchdManager(unit, home, run).status()).toEqual({
      running: false,
      crashed: true,
      restarting: false,
      pid: 0,
    });
  });

  it("knows a service by its plist, loaded or not", async () => {
    const { run } = recorder({ "launchctl print": new Error("113") });
    const manager = launchdManager(unit, home, run);
    expect(await manager.installed()).toBeUndefined();
    await manager.install(command);
    expect(await manager.installed()).toEqual([
      "/opt/eta-host",
      "--port",
      "8790",
    ]);
  });

  it("stops by bootout and waits for the job to be gone", async () => {
    const { calls, run } = recorder({
      "launchctl print": ["loaded", new Error("113")],
    });
    await launchdManager(unit, home, run).stop();
    expect(calls).toEqual([
      `launchctl bootout ${target}`,
      `launchctl print ${target}`,
      `launchctl print ${target}`,
    ]);
  });

  it("starts what is not loaded by bootstrap, and what is by kickstart", async () => {
    const plist = join(home, "Library", "LaunchAgents", "io.eta.host.plist");
    const { calls, run } = recorder({
      "launchctl print": [new Error("113"), "loaded"],
    });
    const manager = launchdManager(unit, home, run);
    await manager.start();
    await manager.start();
    expect(calls).toEqual([
      `launchctl print ${target}`,
      `launchctl bootstrap gui/${uid} ${plist}`,
      `launchctl print ${target}`,
      `launchctl kickstart ${target}`,
    ]);
  });

  it("tries a bootstrap again: a job being torn down turns one away", async () => {
    const { calls, run } = recorder({
      "launchctl print": new Error("113"),
      "launchctl bootstrap": [new Error("5: Input/output error"), ""],
    });
    await launchdManager(unit, home, run).start();
    expect(
      calls.filter((call) => call.startsWith("launchctl bootstrap")),
    ).toHaveLength(2);
  });

  it("takes the service's jobs with it when it goes", async () => {
    const { calls, run } = recorder({ "launchctl print": new Error("113") });
    await launchdManager(unit, home, run, [job.name]).uninstall(command);
    expect(calls.filter((call) => call.includes("bootout"))).toEqual([
      `launchctl bootout gui/${uid}/${job.name}`,
      `launchctl bootout ${target}`,
    ]);
  });

  it("gives a detached run a plist of its own that does not stay", async () => {
    process.env.SERVICE_TEST_TOKEN = "s3cret";
    const path = join(home, ".eta", "service", `${job.name}.plist`);
    let plist = "";
    const { calls, run } = recorder({ "launchctl print": new Error("113") });
    await launchdRunner(home, async (file, args, options) => {
      if (args[0] === "bootstrap") plist = await readFile(path, "utf8");
      return run(file, args, options);
    }).start(job);
    expect(plist).toContain(`<key>Label</key><string>${job.name}</string>`);
    expect(plist).toContain(
      "<key>SERVICE_TEST_TOKEN</key><string>s3cret</string>",
    );
    expect(plist).not.toContain("KeepAlive");
    expect(existsSync(path)).toBe(false);
    expect(calls.join("\n")).not.toContain("s3cret");
    expect(calls).toContain(`launchctl bootout gui/${uid}/${job.name}`);
  });

  it("stops a detached run with a signal it can refuse", async () => {
    const { calls, run } = recorder();
    await launchdRunner(home, run).stop(job.name);
    expect(calls).toEqual([`launchctl kill SIGTERM gui/${uid}/${job.name}`]);
  });
});

describe("windows", () => {
  const worker = {
    name: "io.eta.host-upgrade",
    description: "eta host upgrade",
  };
  const user = { account: "PC\\me", sid: "S-1-5-21-1" };

  /** Windows as far as the manager asks it, with services that do what they are told. */
  function fakeWindows(options: { elevated?: boolean; right?: boolean } = {}) {
    const calls: string[] = [];
    const services = new Map<string, string>();
    const registered: Record<string, unknown>[] = [];
    const api = {
      isElevated: () => options.elevated ?? true,
      currentUser: () => user,
      checkPassword: () => undefined,
      grantLogonRight: () => {
        calls.push("grant");
        return options.right ?? true;
      },
      revokeLogonRight: (sid: string) => {
        calls.push(`revoke ${sid}`);
      },
      queryService: (name: string) => {
        const state = services.get(name);
        return state === undefined
          ? { installed: false }
          : { installed: true, state, pid: 0, account: user.account };
      },
      startService: (name: string) => {
        calls.push(`start ${name}`);
        services.set(name, "running");
      },
      stopService: (name: string) => {
        calls.push(`stop ${name}`);
        if (services.has(name)) services.set(name, "stopped");
      },
      deleteService: (name: string) => {
        calls.push(`delete ${name}`);
        services.delete(name);
      },
      registerService: (registration: Record<string, unknown>) => {
        calls.push(`register ${registration.name as string}`);
        registered.push(registration);
        if (!services.has(registration.name as string))
          services.set(registration.name as string, "stopped");
        return true;
      },
    };
    return { api: api as never, calls, registered, services };
  }

  const options = (api: never) => ({
    worker,
    home,
    api,
    password: () => Promise.resolve("hunter2"),
  });
  const config = () => join(home, ".eta", "service", "io.eta.host.json");

  async function write(state: object): Promise<void> {
    await mkdir(dirname(config()), { recursive: true });
    const file = join(home, "state.json");
    await writeFile(
      config(),
      JSON.stringify({ argv: ["C:\\eta-host.exe"], state: file }),
    );
    await writeFile(file, JSON.stringify(state));
  }

  it("has no service when Windows knows none", async () => {
    const { api } = fakeWindows();
    expect(
      await windowsManager(unit, options(api)).installed(),
    ).toBeUndefined();
  });

  it("reads what the service runs from its config", async () => {
    await write({ state: "running", pid: 9 });
    const { api, services } = fakeWindows();
    services.set(unit.name, "running");
    expect(await windowsManager(unit, options(api)).installed()).toEqual([
      "C:\\eta-host.exe",
    ]);
  });

  it("says so when the service is another user's", () => {
    const { api, services } = fakeWindows();
    services.set(unit.name, "running");
    expect(() => windowsManager(unit, options(api)).installed()).toThrow(
      /another user/,
    );
  });

  it("reports the host's pid and state, which Windows does not know: its service is the shell", async () => {
    await write({ state: "running", pid: 9 });
    const { api, services } = fakeWindows();
    services.set(unit.name, "running");
    expect(await windowsManager(unit, options(api)).status()).toEqual({
      running: true,
      crashed: false,
      restarting: false,
      pid: 9,
    });
  });

  it("sees a host the shell is waiting to start again while Windows says running", async () => {
    await write({ state: "backoff", pid: 0 });
    const { api, services } = fakeWindows();
    services.set(unit.name, "running");
    expect(await windowsManager(unit, options(api)).status()).toMatchObject({
      running: false,
      crashed: true,
      restarting: true,
    });
  });

  it("does not believe a state file over a stopped service", async () => {
    await write({ state: "running", pid: 9 });
    const { api, services } = fakeWindows();
    services.set(unit.name, "stopped");
    expect(await windowsManager(unit, options(api)).status()).toMatchObject({
      running: false,
      crashed: true,
      restarting: false,
    });
  });

  const program = {
    program: "C:\\my apps\\eta-host.exe",
    args: ["--port", "1"],
  };

  it("registers both services as this user, the host's to start at boot", async () => {
    const { api, calls, registered } = fakeWindows();
    await windowsManager(unit, options(api)).install(program);
    expect(calls).toEqual([
      "grant",
      "register io.eta.host",
      "register io.eta.host-upgrade",
      "stop io.eta.host",
      "start io.eta.host",
    ]);
    expect(registered[0]).toMatchObject({
      name: "io.eta.host",
      automatic: true,
      account: user.account,
      sid: user.sid,
    });
    expect(registered[0]?.command).toBe(
      `"C:\\my apps\\eta-host.exe" service-run --name io.eta.host --config ${config()}`,
    );
    expect(registered[1]).toMatchObject({
      name: "io.eta.host-upgrade",
      automatic: false,
    });
    expect(JSON.parse(await readFile(config(), "utf8")).argv).toEqual([
      program.program,
      "--port",
      "1",
    ]);
  });

  it("does not leave the password in memory it owns", async () => {
    const { api, registered } = fakeWindows();
    await windowsManager(unit, options(api)).install(program);
    expect(registered[0]?.password).toEqual(
      new Uint8Array((registered[0]?.password as Uint8Array).length),
    );
  });

  it("asks for nothing when it is installed already, and keeps the password", async () => {
    const { api, calls, registered, services } = fakeWindows();
    services.set(unit.name, "running");
    await windowsManager(unit, {
      ...options(api),
      password: () => Promise.reject(new Error("asked")),
    }).install(program);
    expect(calls).not.toContain("grant");
    expect(registered[0]?.password).toBeUndefined();
  });

  it("knows the account Windows hands back as .\\me", async () => {
    const { api, services } = fakeWindows();
    services.set(unit.name, "running");
    const real = api as { queryService: (name: string) => object };
    const local = {
      ...real,
      queryService: (name: string) => ({
        ...real.queryService(name),
        account: ".\\ME",
      }),
    };
    await expect(
      windowsManager(unit, options(local as never)).install(program),
    ).resolves.toMatchObject({ name: unit.name });
  });

  it("will not take over another account's service", async () => {
    const { api, services } = fakeWindows();
    services.set(unit.name, "running");
    const other = {
      ...(api as object),
      queryService: () => ({ installed: true, account: "PC\\them" }),
    };
    await expect(
      windowsManager(unit, options(other as never)).install(program),
    ).rejects.toThrow(/runs as PC\\them, not PC\\me/);
  });

  it("names the Administrator terminal when that is what is missing", async () => {
    const { api, calls } = fakeWindows({ elevated: false });
    const manager = windowsManager(unit, options(api));
    await expect(manager.install(program)).rejects.toThrow(
      /Administrator terminal/,
    );
    await expect(manager.uninstall(program)).rejects.toThrow(
      /Administrator terminal/,
    );
    expect(calls).toEqual([]);
    expect(existsSync(config())).toBe(false);
  });

  it("takes back the logon right it gave, and leaves nothing behind", async () => {
    const { api, calls, services } = fakeWindows();
    const manager = windowsManager(unit, options(api));
    await manager.install(program);
    await manager.uninstall(program);
    expect(calls.slice(-5)).toEqual([
      "stop io.eta.host-upgrade",
      "delete io.eta.host-upgrade",
      "stop io.eta.host",
      "delete io.eta.host",
      `revoke ${user.sid}`,
    ]);
    expect(services.size).toBe(0);
    expect(existsSync(dirname(config()))).toBe(false);
  });

  it("leaves a logon right the account already had", async () => {
    const { api, calls } = fakeWindows({ right: false });
    const manager = windowsManager(unit, options(api));
    await manager.install(program);
    await manager.uninstall(program);
    expect(calls.join("\n")).not.toContain("revoke");
  });

  it("explains a refused stop: another account is what that means", async () => {
    const { api } = fakeWindows();
    const refusing = {
      ...(api as object),
      stopService: () => {
        throw new WindowsError("x", ERROR_ACCESS_DENIED);
      },
    };
    await expect(
      windowsManager(unit, options(refusing as never)).stop(),
    ).rejects.toThrow(/did not install it/);
  });

  it("runs a detached job from a copy, with what it needs in a file only it reads", async () => {
    process.env.SERVICE_TEST_TOKEN = "s3cret";
    const file = join(home, "eta-host.exe");
    await writeFile(file, "program");
    const { api, calls } = fakeWindows();
    await windowsRunner({ worker, home, api }).start({
      ...job,
      argv: [file, "upgrade", "--target", file],
    });
    const dir = join(home, ".eta", "service");
    const copy = join(dir, `${job.name}.exe`);
    expect(await readFile(copy, "utf8")).toBe("program");
    expect(
      JSON.parse(await readFile(join(dir, `${job.name}.json`), "utf8")),
    ).toMatchObject({
      argv: [copy, "upgrade", "--target", file],
      env: { SERVICE_TEST_TOKEN: "s3cret" },
      once: true,
      remove: copy,
    });
    expect(calls).toEqual([`start ${job.name}`]);
  });

  it("takes the copy back when the run cannot start", async () => {
    const file = join(home, "eta-host.exe");
    await writeFile(file, "program");
    const { api } = fakeWindows();
    const failing = {
      ...(api as object),
      startService: () => {
        throw new WindowsError("no", 1);
      },
    };
    await expect(
      windowsRunner({ worker, home, api: failing as never }).start({
        ...job,
        argv: [file],
      }),
    ).rejects.toThrow(/no/);
    const dir = join(home, ".eta", "service");
    expect(existsSync(join(dir, `${job.name}.exe`))).toBe(false);
    expect(existsSync(join(dir, `${job.name}.json`))).toBe(false);
  });

  it("tells a detached run to stop and does not wait", async () => {
    const { api, calls } = fakeWindows();
    await windowsRunner({ worker, home, api }).stop(job.name);
    expect(calls).toEqual([`stop ${job.name}`]);
  });

  it.each([
    [["plain", "--flag"], "plain --flag"],
    [["C:\\Program Files\\a.exe"], '"C:\\Program Files\\a.exe"'],
    [[""], '""'],
    [['say "hi"'], '"say \\"hi\\""'],
    [["C:\\dir with space\\"], '"C:\\dir with space\\\\"'],
    [["no\\quote"], "no\\quote"],
  ])("quotes %j the way Windows reads it back", (argv, line) => {
    expect(commandLine(argv)).toBe(line);
  });
});

describe("choosing", () => {
  it("gives this computer's kind, and the daemon none on Windows", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(() => serviceManager(unit)).toThrow(/no service support on win32/);
      expect(() => detachedRunner()).toThrow(/win32/);
    } finally {
      Object.defineProperty(
        process,
        "platform",
        original as PropertyDescriptor,
      );
    }
    expect(serviceManager(unit).name).toBe("io.eta.host");
  });
});
