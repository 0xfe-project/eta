import type { ChildProcess } from "process";
import type { HostAddress } from "../../services/host";
import { run, spawn } from "process";
import { appInfo, platform, signal } from "nsh";
import { packagedHostBootstrap } from "../../../packaged-host-bootstrap";
import { addressFrom } from "../../services/host";

export const canStartHost = ["macos", "linux", "windows"].includes(platform.os);
export const localProgress = signal<
  { version?: string; received?: number; total?: number } | undefined
>(undefined);

export class LocalHostError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

let pending: Promise<HostAddress> | undefined;

function missing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

function accessDenied(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM"),
  );
}

interface LocalCommand {
  command: string;
  args: string[];
}

function bootstrap(): LocalCommand[] {
  const version = appInfo().version ?? "0.1.0";
  const launcher = packagedHostBootstrap();
  // Windows launches the normalized absolute path directly: NSH's
  // process.execute list allows absolute paths, and nsh.json already lists
  // eta-bootstrap.exe. No cmd.exe or shell wrapper is used; a launcher that is
  // found but exits unready reports its own error rather than being retried.
  if (platform.os === "windows")
    return launcher ? [{ command: launcher, args: [version] }] : [];
  if (appInfo().development) return [];
  return launcher
    ? [{ command: "/usr/bin/env", args: [launcher, version] }]
    : [];
}

async function prepare(): Promise<HostAddress> {
  for (const launch of bootstrap()) {
    const result = await spawnHost(launch).catch((cause: unknown) => {
      // Only a launcher that was not found is skipped so the installed host is
      // tried next; a launcher that was found but failed to start reports its
      // own error instead of being masked by a retry.
      if (
        missing(cause) ||
        accessDenied(cause) ||
        (cause instanceof LocalHostError && cause.kind === "missing")
      )
        return undefined;
      throw cause;
    });
    if (result) return result;
  }
  const name = platform.os === "windows" ? "eta-host.exe" : "eta-host";
  let result;
  try {
    result = await run(name, ["running", "--connection"], {
      timeoutMs: 12_000,
    });
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (result) {
    if (result.code !== 0)
      throw new Error("Couldn't check the installed Eta host.");
    const running = JSON.parse(result.stdout) as {
      address: string;
      token?: string;
      tokenFile?: string;
    } | null;
    if (running) {
      if (running.tokenFile && !running.token)
        throw new Error(
          "Enter the local host's token under Change connection.",
        );
      return { origin: addressFrom(running.address), token: running.token };
    }
    return spawnHost({
      command: name,
      args: ["--host", "127.0.0.1", "--port", "0"],
    });
  }
  throw new Error("Install the Eta host for this computer, then retry.");
}

interface HostLine {
  phase?: "download" | "start";
  failure?: string;
  detail?: string;
  version?: string;
  total?: number;
  received?: number;
  address?: string;
  token?: string;
  host?: string;
  port?: number;
}

function spawnHost(launch: LocalCommand): Promise<HostAddress> {
  return new Promise((resolve, reject) => {
    const owned: ChildProcess = spawn(launch.command, launch.args, {
      lines: true,
    });
    let detail = "";
    let timer: number | undefined;
    function setDeadline(ms: number) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        owned.kill();
        reject(new Error("The host didn't start in time."));
      }, ms);
    }
    function ready(address: HostAddress) {
      clearTimeout(timer);
      localProgress.set(undefined);
      resolve(address);
    }
    setDeadline(30_000);
    owned.on("stderr", (line) => {
      if (line.trim()) detail = line.trim().slice(0, 180);
    });
    owned.on("stdout", (line) => {
      let frame: HostLine;
      try {
        frame = JSON.parse(line) as HostLine;
      } catch {
        return;
      }
      if (frame?.phase === "download") {
        localProgress.set(frame);
        setDeadline(100_000);
      } else if (frame?.phase === "start") {
        localProgress.set(undefined);
        setDeadline(30_000);
      } else if (frame?.failure) {
        clearTimeout(timer);
        localProgress.set(undefined);
        reject(
          new LocalHostError(
            frame.failure,
            frame.detail ?? "The host couldn't start.",
          ),
        );
      } else if (frame?.address) {
        ready({ origin: addressFrom(frame.address), token: frame.token });
      } else if (
        frame?.host === "127.0.0.1" &&
        Number.isInteger(frame.port) &&
        frame.port! > 0
      ) {
        ready({ origin: `http://127.0.0.1:${frame.port}` });
      }
    });
    owned.on("exit", (exit) => {
      clearTimeout(timer);
      localProgress.set(undefined);
      const kind =
        launch.command === "/usr/bin/env" && exit.code === 127
          ? "missing"
          : "start";
      reject(
        new LocalHostError(
          kind,
          detail || "The host exited before it was ready.",
        ),
      );
    });
  });
}

export function startLocalHost(): Promise<HostAddress> {
  pending ??= prepare().finally(() => {
    pending = undefined;
  });
  return pending;
}
