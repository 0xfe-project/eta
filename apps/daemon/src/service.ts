/**
 * Registering a program as a service of the user: a systemd user unit on Linux, a launchd agent
 * on macOS. A user service, so no root is needed and the program runs as the same user whose files
 * its sessions touch. Windows has neither: a host there is started by hand.
 *
 * Two programs are registered this way, each under a name of its own: the daemon (`io.eta.daemon`,
 * `eta-daemon run`) and the host (`io.eta.host`, `eta-host install-service`). The PATH they were
 * installed from goes into the unit: a service manager starts its services with a bare one, and
 * what the sessions run (git, gh, Claude Code, Codex, tailscale) lives on the user's.
 */
import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ServiceDefinition {
  name: string;
  path: string;
  content: string;
}

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
): Record<string, string> {
  const path = (env.PATH ?? "")
    .split(":")
    .filter(
      (dir, index, all) =>
        dir !== "" &&
        !/[/\\]node_modules[/\\]\.bin$/.test(dir) &&
        all.indexOf(dir) === index,
    )
    .join(":");
  return path === "" ? {} : { PATH: path };
}

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
  throw new Error(
    `no service support on ${platform}: only systemd (Linux) and launchd (macOS), so start it by hand`,
  );
}

export async function installService(
  command: ServiceCommand,
  unit: ServiceUnit = DAEMON_UNIT,
): Promise<ServiceDefinition> {
  const definition = serviceDefinition(
    command,
    process.platform,
    homedir(),
    unit,
  );
  await mkdir(dirname(definition.path), { recursive: true });
  await writeFile(definition.path, definition.content, { mode: 0o600 });
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await run("launchctl", ["bootout", `${domain}/${definition.name}`]).catch(
      () => undefined,
    );
    await run("launchctl", ["bootstrap", domain, definition.path]);
  } else {
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", `${definition.name}.service`]);
    // A restart, not `--now`: a unit that is already running (an install over an older one) has
    // to start again on the new file and identity.
    await run("systemctl", ["--user", "restart", `${definition.name}.service`]);
  }
  return definition;
}

export async function uninstallService(
  command: ServiceCommand,
  unit: ServiceUnit = DAEMON_UNIT,
): Promise<ServiceDefinition> {
  const definition = serviceDefinition(
    command,
    process.platform,
    homedir(),
    unit,
  );
  if (process.platform === "darwin") {
    await run("launchctl", [
      "bootout",
      `gui/${process.getuid?.() ?? 501}/${definition.name}`,
    ]).catch(() => undefined);
  } else {
    await run("systemctl", [
      "--user",
      "disable",
      "--now",
      `${definition.name}.service`,
    ]).catch(() => undefined);
  }
  await unlink(definition.path).catch(() => undefined);
  if (process.platform === "linux")
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  return definition;
}
