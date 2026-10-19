/**
 * Registering the daemon as a service of the user: a systemd user unit on Linux, a launchd agent
 * on macOS. A user service, so no root is needed and the daemon runs as the same user whose files
 * its sessions touch. Windows goes through WSL.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

/** The command that runs the daemon: the binary and its arguments. */
export interface ServiceCommand {
  program: string;
  args: string[];
}

export function serviceDefinition(
  command: ServiceCommand,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ServiceDefinition {
  const name = `io.eta.daemon.${createHash("sha256").update(dataDir).digest("hex").slice(0, 12)}`;
  const argv = [command.program, ...command.args, "run", "--data-dir", dataDir];
  if (platform === "darwin") {
    return {
      name,
      path: join(home, "Library", "LaunchAgents", `${name}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(name)}</string>
<key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
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
Description=eta daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${argv.map(quote).join(" ")}
Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=default.target
`,
    };
  }
  throw new Error(`no service support on ${platform}; on Windows use WSL`);
}

export async function installService(
  command: ServiceCommand,
  dataDir: string,
): Promise<ServiceDefinition> {
  const definition = serviceDefinition(command, dataDir);
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
    await run("systemctl", [
      "--user",
      "enable",
      "--now",
      `${definition.name}.service`,
    ]);
  }
  return definition;
}

export async function uninstallService(
  command: ServiceCommand,
  dataDir: string,
): Promise<ServiceDefinition> {
  const definition = serviceDefinition(command, dataDir);
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
