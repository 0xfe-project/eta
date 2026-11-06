/**
 * A service as a launchd agent in the user's GUI domain, and a detached run as a job of its own
 * there. launchd kills what is left in a job's process group when the job ends, so what runs as
 * another job, a session and a group of its own, does not go with the service.
 *
 * Stopping is `bootout`, not a signal: the agent's `KeepAlive` would start again what a kill ended,
 * and only launchd sends the TERM, waits `ExitTimeOut`, then sends a KILL. So a service that is
 * stopped is not loaded, and is known by its plist. `launchctl list` would answer for whichever
 * domain the caller happens to be in; `print` is told which.
 */
import type {
  DetachedRunner,
  Exec,
  ServiceDefinition,
  ServiceManager,
  ServiceUnit,
} from "./service";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  launchdArgv,
  launchdLog,
  passedValues,
  serviceDefinition,
} from "./service";

const LAUNCHCTL_TIMEOUT_MS = 120_000;
/** A job being torn down turns a bootstrap of the same label away for a moment. */
const BOOTSTRAP_TRIES = 20;
const BOOTSTRAP_RETRY_MS = 500;
/** `ExitTimeOut` in the plist, and a margin. */
const GONE_TIMEOUT_MS = 120_000;
const GONE_POLL_MS = 200;

const xml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Launchctl {
  domain: string;
  call: (...args: string[]) => Promise<string>;
  /** What launchd knows of a job, undefined when it is not loaded. */
  print: (name: string) => Promise<string | undefined>;
  bootstrap: (path: string) => Promise<void>;
  bootout: (name: string) => Promise<void>;
}

function launchctl(run: Exec): Launchctl {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const call = async (...args: string[]): Promise<string> =>
    (await run("launchctl", args, { timeout: LAUNCHCTL_TIMEOUT_MS })).stdout;
  const print = (name: string): Promise<string | undefined> =>
    call("print", `${domain}/${name}`).catch(() => undefined);
  return {
    domain,
    call,
    print,
    bootstrap: async (path) => {
      for (let tries = 1; ; tries += 1) {
        try {
          await call("bootstrap", domain, path);
          return;
        } catch (error) {
          if (tries === BOOTSTRAP_TRIES) throw error;
          await sleep(BOOTSTRAP_RETRY_MS);
        }
      }
    },
    bootout: async (name) => {
      await call("bootout", `${domain}/${name}`).catch(() => undefined);
      const deadline = Date.now() + GONE_TIMEOUT_MS;
      while ((await print(name)) !== undefined) {
        if (Date.now() >= deadline)
          throw new Error(`launchd still has ${name}`);
        await sleep(GONE_POLL_MS);
      }
    },
  };
}

export function launchdManager(
  unit: ServiceUnit,
  home: string = homedir(),
  run: Exec = promisify(execFile),
  /** Jobs of the same service, which go when it does. */
  jobs: readonly string[] = [],
): ServiceManager {
  const { name } = unit;
  const launchd = launchctl(run);
  const definition = (command: {
    program: string;
    args: string[];
  }): ServiceDefinition => serviceDefinition(command, "darwin", home, unit);
  const { path } = definition({ program: "", args: [] });

  return {
    name,
    startCommand: `launchctl bootstrap ${launchd.domain} ${path}`,
    installed: () => {
      if (!existsSync(path)) return Promise.resolve(undefined);
      const argv = launchdArgv(readFileSync(path, "utf8"));
      if (argv === undefined) throw new Error(`no command in ${path}`);
      return Promise.resolve(argv);
    },
    status: async () => {
      const printed = await launchd.print(name);
      if (printed === undefined)
        return { running: false, crashed: true, restarting: false, pid: 0 };
      const state = /^\tstate = (.+)$/m.exec(printed)?.[1];
      const pid = Number(/^\tpid = (\d+)$/m.exec(printed)?.[1] ?? 0);
      const running = state === "running" && pid > 0;
      if (running) return { running, crashed: false, restarting: false, pid };
      const exit = /^\tlast exit code = (.+)$/m.exec(printed)?.[1];
      const started = exit !== undefined && !exit.startsWith("(never");
      const failed =
        /^\tlast terminating signal = /m.test(printed) ||
        (started && exit !== "0");
      // Loaded and never run is on its way up. A failure comes back through `KeepAlive`, held off
      // for `ThrottleInterval`; a clean exit does not come back.
      return {
        running,
        crashed: started,
        restarting: !started || failed,
        pid,
      };
    },
    stop: () => launchd.bootout(name),
    start: async () => {
      if ((await launchd.print(name)) === undefined)
        await launchd.bootstrap(path);
      else await launchd.call("kickstart", `${launchd.domain}/${name}`);
    },
    install: async (command) => {
      const installing = definition(command);
      await mkdir(dirname(installing.path), { recursive: true });
      await mkdir(dirname(launchdLog(home, name)), { recursive: true });
      await writeFile(installing.path, installing.content, { mode: 0o600 });
      await launchd.bootout(name);
      await launchd.bootstrap(installing.path);
      return installing;
    },
    uninstall: async (command) => {
      const removing = definition(command);
      for (const job of [...jobs, name]) await launchd.bootout(job);
      await unlink(removing.path).catch(() => undefined);
      return removing;
    },
  };
}

/** A job that runs once and is not restarted: no `KeepAlive`, and no plist left to be read again. */
function jobPlist(
  name: string,
  argv: readonly string[],
  env: Record<string, string>,
  log: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(name)}</string>
<key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join("")}</dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export function launchdRunner(
  home: string = homedir(),
  run: Exec = promisify(execFile),
): DetachedRunner {
  const launchd = launchctl(run);
  return {
    start: async ({ argv, name, passEnv }) => {
      // Only to read it into launchd: it may hold a token, and is gone again once that is done.
      const path = join(home, ".eta", "service", `${name}.plist`);
      const log = launchdLog(home, name);
      await mkdir(dirname(path), { recursive: true });
      await mkdir(dirname(log), { recursive: true });
      await writeFile(path, jobPlist(name, argv, passedValues(passEnv), log), {
        mode: 0o600,
      });
      try {
        await launchd.bootout(name);
        await launchd.bootstrap(path);
      } finally {
        await rm(path, { force: true });
      }
    },
    stop: async (name) => {
      await launchd.call("kill", "SIGTERM", `${launchd.domain}/${name}`);
    },
  };
}
