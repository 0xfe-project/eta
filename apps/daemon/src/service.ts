/**
 * Registering a program as a service of the user: what a service is, whichever kind this computer
 * has. A systemd user unit on Linux and a launchd agent on macOS need no root; a Windows service
 * does, once, to install it. All three run the program as the same user whose files its sessions
 * touch. The kinds themselves are in `service-systemd.ts`, `service-launchd.ts` and
 * `service-windows.ts`, and `serviceManager` picks one; the layering is that of kardianos/service,
 * a `ServiceManager` for the service and a `DetachedRunner` for what has to outlive it.
 *
 * Two programs are registered this way, each under a name of its own: the daemon (`io.eta.daemon`,
 * `eta-daemon run`) and the host (`io.eta.host`, `eta-host install-service`). The PATH they were
 * installed from goes into the unit: a service manager starts its services with a bare one, and
 * what the sessions run (git, gh, Claude Code, Codex, tailscale) lives on the user's.
 */
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

export interface ServiceDefinition {
  name: string;
  path: string;
  content: string;
}

export interface ServiceStatus {
  /** Started and not exited. */
  running: boolean;
  /** It exited on its own: waiting to be started again, or given up on. */
  crashed: boolean;
  /** Down for now: the manager will start it again, from whatever file is there then. */
  restarting: boolean;
  pid: number;
}

/** One service, seen from outside it. Stopping and starting wait for that to have happened. */
export interface ServiceManager {
  readonly name: string;
  install: (command: ServiceCommand) => Promise<ServiceDefinition>;
  uninstall: (command: ServiceCommand) => Promise<ServiceDefinition>;
  /** The command it is registered to run; undefined when it is not installed. */
  installed: () => Promise<string[] | undefined>;
  status: () => Promise<ServiceStatus>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** What a person types to start it. */
  readonly startCommand: string;
}

/** A run of a program that has to outlive whatever started it. */
interface DetachedJob {
  /** The one run of this name: a second one replaces what is left of the first. */
  name: string;
  argv: string[];
  /** Taken from this process, by name: a run starts bare, and a token stays off command lines. */
  passEnv: readonly string[];
}

/**
 * Runs a job under the service manager, not under the caller. A child would not do: a stop kills
 * what the service started, and what starts the job may be the service or an agent under it.
 */
export interface DetachedRunner {
  start: (job: DetachedJob) => Promise<void>;
  /** Asks it to stop and does not wait: past some point a job may not want to. */
  stop: (name: string) => Promise<void>;
}

/** `execFile` as a promise, or what stands in for it in a test. */
export type Exec = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** The values of the names a job passes along that this process has. */
export const passedValues = (
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

const xml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Quoted for a systemd `ExecStart`, where `%` and `\` and `"` are special. */
const quote = (value: string): string =>
  `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The command a systemd unit file runs, undone from `quote`: what a service was installed with is
 * in the unit and nowhere else. Undefined when the file has no `ExecStart`.
 */
export function serviceArgv(content: string): string[] | undefined {
  const line = /^ExecStart=(.*)$/m.exec(content)?.[1];
  if (line === undefined) return undefined;
  const words = line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
  return words.map((word) =>
    (word.startsWith('"') ? word.slice(1, -1) : word)
      .replace(/\\(.)/g, "$1")
      .replace(/%%/g, "%"),
  );
}

/** The command a launchd plist runs: what `xml` escaped, escaped back. */
export function launchdArgv(content: string): string[] | undefined {
  const array = /<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(
    content,
  )?.[1];
  if (array === undefined) return undefined;
  return [...array.matchAll(/<string>(.*?)<\/string>/gs)].map(([, value]) =>
    (value ?? "").replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    ),
  );
}

/** The command that runs the program: the binary and its arguments. */
export interface ServiceCommand {
  program: string;
  args: string[];
}

/** Which service: its name, what it is, the arguments that make the command serve, its env. */
export interface ServiceUnit {
  name: string;
  description: string;
  /** After the command's own arguments. */
  args: string[];
  /** Environment the service starts with (the PATH it was installed from, most of all). */
  env?: Record<string, string> | undefined;
}

/**
 * One daemon per user, in one directory: the name says which, and nothing else has to. No
 * `--data-dir` in the unit: the daemon's directory is `$HOME/.eta/daemon`, and a user service
 * (systemd's or launchd's) already runs with that user's HOME. A path baked in here would be a
 * second way to say where the data is, which is the thing this unit no longer offers.
 */
export const DAEMON_UNIT: ServiceUnit = {
  name: "io.eta.daemon",
  description: "eta daemon",
  args: ["run"],
};

/**
 * The environment a service is installed with: the installing shell's PATH, without the
 * `node_modules/.bin` directories a package runner (`bun run`, `npm run`) puts in front of it,
 * which are the checkout's, not the user's.
 */
export function installedEnv(
  env: NodeJS.ProcessEnv = process.env,
  separator: string = delimiter,
): Record<string, string> {
  const path = (env.PATH ?? "")
    .split(separator)
    .filter(
      (dir, index, all) =>
        dir !== "" &&
        !/[/\\]node_modules[/\\]\.bin$/.test(dir) &&
        all.indexOf(dir) === index,
    )
    .join(separator);
  return path === "" ? {} : { PATH: path };
}

/** Where launchd puts what a job prints: it keeps no log of its own. */
export const launchdLog = (home: string, name: string): string =>
  join(home, "Library", "Logs", "eta", `${name}.log`);

export function serviceDefinition(
  command: ServiceCommand,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  unit: ServiceUnit = DAEMON_UNIT,
): ServiceDefinition {
  const { name } = unit;
  const argv = [command.program, ...command.args, ...unit.args];
  const env = Object.entries(unit.env ?? {});
  if (platform === "darwin") {
    const log = launchdLog(home, name);
    return {
      name,
      path: join(home, "Library", "LaunchAgents", `${name}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(name)}</string>
<key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>${
        env.length === 0
          ? ""
          : `\n<key>EnvironmentVariables</key><dict>${env.map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>`
      }
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>90</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`,
    };
  }
  if (platform === "linux") {
    return {
      name,
      path: join(home, ".config", "systemd", "user", `${name}.service`),
      content: `[Unit]
Description=${unit.description}
After=network-online.target

[Service]
Type=simple
ExecStart=${argv.map(quote).join(" ")}
${env.map(([key, value]) => `Environment=${quote(`${key}=${value}`)}\n`).join("")}Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=default.target
`,
    };
  }
  if (platform === "win32") {
    const path = join(home, ".eta", "service", `${name}.json`);
    return {
      name,
      path,
      content: JSON.stringify(
        {
          argv,
          env: unit.env ?? {},
          log: `${path.slice(0, -".json".length)}.log`,
          state: `${path.slice(0, -".json".length)}.state.json`,
          once: false,
        },
        null,
        2,
      ),
    };
  }
  throw new Error(
    `no service support on ${platform}: only systemd (Linux), launchd (macOS) and Windows services, so start it by hand`,
  );
}
