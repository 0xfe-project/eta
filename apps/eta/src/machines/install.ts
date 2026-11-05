/**
 * Putting the daemon on another computer from here, over SSH.
 *
 * What a person would do by hand, in four steps over the user's own `ssh` (OpenSSH, or Tailscale
 * SSH on a tailnet node; whatever keys and config the user already has):
 *
 * 1. ask the computer what it is (`uname`) and where its home is;
 * 2. send it the daemon build this primary carries for that platform, as `~/.eta/bin/eta-daemon`;
 * 3. register it with a fresh install code (`setup --no-wait`);
 * 4. install it as the user's service (`install-service`), and on Linux ask for the user's services
 *    to outlive the SSH session (`loginctl enable-linger`; a refusal is not a failure).
 *
 * The daemon then dials in like any other. On a tailnet the primary lets the user's own node in at
 * once (`hub.ts`, `identify`); anywhere else it waits for the fingerprint to be approved.
 *
 * A computer with no key for this host is logged in to with a password the user gives for this
 * install. It reaches ssh through `SSH_ASKPASS`: a helper that prints an environment variable of
 * the ssh process, so the password is never in an argument, a file or a log, and errors have it
 * blotted out. Without a password ssh runs in batch mode and never asks.
 */
import type { DaemonBuild, DaemonBuilds } from "./builds";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** Runs a script on a host over SSH, with optional input, and gives what it printed. */
export type SshRunner = (
  host: string,
  script: string,
  input?: Blob,
  options?: { password?: string | undefined },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const SSH_OPTIONS = [
  "-o",
  "ConnectTimeout=15",
  "-o",
  "StrictHostKeyChecking=accept-new",
];

/**
 * The askpass helper: it prints the password from the environment ssh was started with. It holds
 * no secret itself, so it is written once and kept.
 */
function askpassHelper(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "ssh-askpass");
  writeFileSync(path, "#!/bin/sh\nprintf '%s\\n' \"$ETA_SSH_PASSWORD\"\n", {
    mode: 0o700,
  });
  chmodSync(path, 0o700);
  return path;
}

/** The user's own ssh; `dir` is where the askpass helper lives. */
export function sshRunner(dir: string): SshRunner {
  return async (host, script, input, options) => {
    const password = options?.password;
    const env: Record<string, string | undefined> = { ...process.env };
    const args = [...SSH_OPTIONS];
    if (password === undefined || password === "") {
      args.push("-o", "BatchMode=yes");
    } else {
      args.push(
        "-o",
        "BatchMode=no",
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "PreferredAuthentications=publickey,keyboard-interactive,password",
      );
      Object.assign(env, {
        SSH_ASKPASS: askpassHelper(dir),
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: env.DISPLAY ?? "none",
        ETA_SSH_PASSWORD: password,
      });
    }
    const child = Bun.spawn(["ssh", ...args, host, script], {
      stdin: input ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  };
}

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
  /** Logs in when the computer has no key for this host; for this install only. */
  password?: string | undefined;
}

/** The steps an install goes through, in order. */
export type InstallStep = "connect" | "send" | "register" | "service";

class InstallError extends Error {}

export async function installDaemon(
  input: InstallInput,
  deps: {
    builds: DaemonBuilds;
    ssh: SshRunner;
    /** Told as each step starts. */
    onStep?: ((step: InstallStep) => void) | undefined;
  },
): Promise<{ platform: string; build: DaemonBuild }> {
  const { ssh } = deps;
  const blot = (text: string): string =>
    input.password === undefined || input.password === ""
      ? text
      : text.split(input.password).join("***");
  const step = async (
    what: string,
    script: string,
    stdin?: Blob,
  ): Promise<string> => {
    const done = await ssh(input.host, script, stdin, {
      password: input.password,
    });
    if (done.code !== 0) {
      const said = blot(done.stderr.trim() || done.stdout.trim())
        .split("\n")
        .slice(-6)
        .join("\n");
      throw new InstallError(
        `${what} on ${input.host} failed (exit ${done.code})${said === "" ? "" : `: ${said}`}`,
      );
    }
    return done.stdout;
  };

  deps.onStep?.("connect");
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

  deps.onStep?.("send");
  await step(
    "Sending the daemon",
    `mkdir -p "$HOME/.eta/bin" && cat > ${BIN}.part && chmod 755 ${BIN}.part && mv -f ${BIN}.part ${BIN}`,
    Bun.file(await build.path()),
  );
  deps.onStep?.("register");
  await step(
    "Registering it",
    `${BIN} setup ${quote(input.url)} ${quote(input.code)} --no-wait`,
  );
  deps.onStep?.("service");
  await step(
    "Installing the service",
    platform.startsWith("linux")
      ? `${BIN} install-service && { loginctl enable-linger "$(id -un)" 2>/dev/null || true; }`
      : `${BIN} install-service`,
  );
  return { platform, build };
}
