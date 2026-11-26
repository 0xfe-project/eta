import type { RunningHost } from "../apps/eta/src/running";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DownloadError, downloadHost } from "../packages/releases/src/install";
import { hostEnvironment } from "./host-launcher/host-env";
import { hostHome, recordedHost } from "./host-launcher/installed";
import { LocalHost, startServiceServer } from "./host-launcher/service";

const executable = process.platform === "win32" ? "eta-host.exe" : "eta-host";
const home = homedir();
const serviceFile = join(
  process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
  "eta",
  "host",
  executable,
);
const dir = hostHome(home);
const installed = join(dir, executable);
// One environment for the whole launch: the control calls and the host itself see the same values,
// names included. Built once, at load — the names cannot change while this process runs.
const env = hostEnvironment();

const output = (frame: object) => console.log(JSON.stringify(frame));

async function control(program: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn([program, ...args], {
    env,
    stdin: "ignore",
    stderr: "ignore",
    stdout: "pipe",
    timeout: 12_000,
  });
  const result = await new Response(child.stdout).text();
  if (await child.exited) throw new Error(`${executable} ${args[0]} failed.`);
  return result;
}

async function openRunning(program: string): Promise<boolean> {
  const running = JSON.parse(
    await control(program, "running", "--connection"),
  ) as (RunningHost & { token?: string }) | null;
  if (!running) return false;
  const token =
    running.token ??
    (running.tokenFile
      ? (await readFile(running.tokenFile, "utf8")).trim()
      : undefined);
  output({ address: running.address, token });
  return true;
}

async function main() {
  const version = process.argv[2] ?? "0.1.0";
  let program =
    [serviceFile, installed].find(existsSync) ??
    Bun.which(executable, { PATH: env.PATH });
  if (!program) {
    const existing = await recordedHost(join(home, ".eta"));
    if (existing) {
      output(existing);
      return;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    output({ phase: "download" });
    program = await downloadHost({
      dir,
      name: executable,
      appVersion: version,
      env,
      onProgress: (progress) => output({ phase: "download", ...progress }),
      tryBuild: (path) => control(path, "--version"),
    });
  }
  if (await openRunning(program)) return;
  output({ phase: "start" });
  const runtime = await mkdtemp(join(tmpdir(), "eta-nsh-host-"));
  const host = new LocalHost({
    command: [program, "--host", "127.0.0.1"],
    cwd: home,
    env,
    summary: join(runtime, "host.json"),
  });
  const service = startServiceServer({ host, program, dir: runtime, env });
  Object.assign(env, service.env);

  let stop: () => void = () => {};
  const stopping = new Promise<void>((resolve) => {
    stop = resolve;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    await host.spawn();
    output({ address: `http://127.0.0.1:${await host.ready()}` });
    watch = setInterval(() => {
      if (host.state().crashed && !service.busy()) stop();
    }, 500);
    await stopping;
  } finally {
    clearInterval(watch);
    await service.finishJob();
    await host.stop();
    service.close();
    await rm(runtime, { recursive: true, force: true });
  }
}

await main().catch((cause: unknown) => {
  output({
    failure: cause instanceof DownloadError ? cause.failure.kind : "start",
    detail: cause instanceof Error ? cause.message : String(cause),
  });
  process.exitCode = 1;
});
