/**
 * A service as a systemd user unit, and a detached run as a transient user unit of its own: a
 * sibling of the service in systemd and not its child, so stopping the service, which kills every
 * process in its cgroup, does not reach it.
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
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { serviceArgv, serviceDefinition } from "./service";

/** A stop can take as long as systemd gives the service before it kills it. */
const SYSTEMCTL_TIMEOUT_MS = 120_000;

export function systemdManager(
  unit: ServiceUnit,
  home: string = homedir(),
  run: Exec = promisify(execFile),
): ServiceManager {
  const { name } = unit;
  const file = `${name}.service`;
  const systemctl = async (...args: string[]): Promise<string> =>
    (
      await run("systemctl", ["--user", ...args], {
        timeout: SYSTEMCTL_TIMEOUT_MS,
      })
    ).stdout;

  async function show(): Promise<Record<string, string>> {
    const properties = [
      "LoadState",
      "ActiveState",
      "SubState",
      "MainPID",
      "FragmentPath",
    ];
    const stdout = await systemctl(
      "show",
      file,
      ...properties.flatMap((property) => ["-p", property]),
    );
    return Object.fromEntries(
      stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
  }

  const definition = (command: {
    program: string;
    args: string[];
  }): ServiceDefinition => serviceDefinition(command, "linux", home, unit);

  return {
    name,
    startCommand: `systemctl --user start ${name}`,
    installed: async () => {
      const { path } = definition({ program: "", args: [] });
      let facts: Record<string, string>;
      try {
        facts = await show();
      } catch (error) {
        // No systemd here is no service. A unit nobody can be asked about is another matter: going
        // on would leave a running service on the old file and say nothing.
        if (!existsSync(path)) return undefined;
        throw new Error(
          `${path} is installed, but systemd does not answer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (facts.LoadState !== "loaded") return undefined;
      const argv = serviceArgv(
        readFileSync(facts.FragmentPath ?? path, "utf8"),
      );
      if (argv === undefined)
        throw new Error(`no ExecStart in ${facts.FragmentPath ?? path}`);
      return argv;
    },
    status: async () => {
      const { ActiveState, SubState, MainPID } = await show();
      return {
        running: ActiveState === "active" && SubState === "running",
        crashed:
          ActiveState === "failed" ||
          ActiveState === "inactive" ||
          SubState === "auto-restart",
        restarting: ActiveState === "activating",
        pid: Number(MainPID ?? 0),
      };
    },
    stop: async () => {
      await systemctl("stop", file);
    },
    start: async () => {
      await systemctl("start", file);
    },
    install: async (command) => {
      const installing = definition(command);
      await mkdir(dirname(installing.path), { recursive: true });
      await writeFile(installing.path, installing.content, { mode: 0o600 });
      await systemctl("daemon-reload");
      await systemctl("enable", file);
      // A restart, not `--now`: a unit that is already running (an install over an older one) has
      // to start again on the new file and identity.
      await systemctl("restart", file);
      return installing;
    },
    uninstall: async (command) => {
      const removing = definition(command);
      await systemctl("disable", "--now", file).catch(() => undefined);
      await unlink(removing.path).catch(() => undefined);
      await systemctl("daemon-reload").catch(() => undefined);
      return removing;
    },
  };
}

export function systemdRunner(run: Exec = promisify(execFile)): DetachedRunner {
  return {
    start: async ({ argv, name, passEnv }) => {
      // A name alone takes the value from this process, so a token is not on any command line. A
      // stop goes to the job alone, not to the `systemctl` it may be waiting for, and waits as long
      // as it takes: a job that ignores it may have good reason, and a kill would leave the job's
      // work half done with nobody watching.
      await run("systemd-run", [
        "--user",
        `--unit=${name}`,
        "--collect",
        "--quiet",
        "--property=KillMode=mixed",
        "--property=TimeoutStopSec=infinity",
        ...passEnv
          .filter((key) => process.env[key] !== undefined)
          .map((key) => `--setenv=${key}`),
        "--",
        ...argv,
      ]);
    },
    stop: async (name) => {
      await run("systemctl", ["--user", "stop", "--no-block", name]);
    },
  };
}
