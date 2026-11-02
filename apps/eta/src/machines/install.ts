/**
 * Putting the daemon on another computer from here, over SSH.
 *
 * What a person would do by hand, in four steps over the user's own `ssh` (OpenSSH, or Tailscale
 * SSH on a tailnet node; whatever keys and config the user already has, never a password prompt):
 *
 * 1. ask the computer what it is (`uname`) and where its home is;
 * 2. send it the daemon build this primary carries for that platform, as `~/.eta/bin/eta-daemon`;
 * 3. register it with a fresh install code (`setup --no-wait`);
 * 4. install it as the user's service (`install-service`), and on Linux ask for the user's services
 *    to outlive the SSH session (`loginctl enable-linger`; a refusal is not a failure).
 *
 * The daemon then dials in like any other. On a tailnet the primary lets the user's own node in at
 * once (`hub.ts`, `identify`); anywhere else it waits for the fingerprint to be approved.
 */
import type { DaemonBuild, DaemonBuilds } from "./builds";
import process from "node:process";

/** Runs a script on a host over SSH, with optional input, and gives what it printed. */
export type SshRunner = (
  host: string,
  script: string,
  input?: Blob,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "StrictHostKeyChecking=accept-new",
];

const defaultSshRunner: SshRunner = async (host, script, input) => {
  const child = Bun.spawn(["ssh", ...SSH_OPTIONS, host, script], {
    stdin: input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
};

/** `uname -s` and `uname -m` in Node's spelling. */
export function platformOf(
  system: string,
  machine: string,
): string | undefined {
  const os = { Linux: "linux", Darwin: "darwin" }[system.trim()];
  const arch = (
    {
      x86_64: "x64",
      amd64: "x64",
      aarch64: "arm64",
      arm64: "arm64",
    } as Record<string, string>
  )[machine.trim()];
  return os === undefined || arch === undefined ? undefined : `${os}-${arch}`;
}

/** Quoted for a POSIX shell. */
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const BIN = '"$HOME/.eta/bin/eta-daemon"';

export interface InstallInput {
  /** Where to SSH to: a host name, `user@host`, or an alias of the user's SSH config. */
  host: string;
  /** The address the daemon dials. */
  url: string;
  /** A fresh install code for it. */
  code: string;
}

class InstallError extends Error {}

export async function installDaemon(
  input: InstallInput,
  deps: { builds: DaemonBuilds; ssh?: SshRunner | undefined },
): Promise<{ platform: string; build: DaemonBuild }> {
  const ssh = deps.ssh ?? defaultSshRunner;
  const step = async (
    what: string,
    script: string,
    stdin?: Blob,
  ): Promise<string> => {
    const done = await ssh(input.host, script, stdin);
    if (done.code !== 0) {
      const said = (done.stderr.trim() || done.stdout.trim())
        .split("\n")
        .slice(-6)
        .join("\n");
      throw new InstallError(
        `${what} on ${input.host} failed (exit ${done.code})${said === "" ? "" : `: ${said}`}`,
      );
    }
    return done.stdout;
  };

  const probe = await step("Asking what the computer is", "uname -s; uname -m");
  const [system = "", machine = ""] = probe.trim().split("\n");
  const platform = platformOf(system, machine);
  if (platform === undefined)
    throw new InstallError(
      `${input.host} is ${system} ${machine}; the daemon runs on Linux and macOS (x64, arm64)`,
    );
  const build = deps.builds.get(platform);
  if (build === undefined)
    throw new InstallError(
      `this primary carries no daemon build for ${platform}; build them with \`bun run --cwd apps/daemon build:all\``,
    );

  await step(
    "Sending the daemon",
    `mkdir -p "$HOME/.eta/bin" && cat > ${BIN}.part && chmod 755 ${BIN}.part && mv -f ${BIN}.part ${BIN}`,
    Bun.file(build.path),
  );
  await step(
    "Registering it",
    `${BIN} setup ${quote(input.url)} ${quote(input.code)} --no-wait`,
  );
  await step(
    "Installing the service",
    platform.startsWith("linux")
      ? `${BIN} install-service && { loginctl enable-linger "$(id -un)" 2>/dev/null || true; }`
      : `${BIN} install-service`,
  );
  return { platform, build };
}
