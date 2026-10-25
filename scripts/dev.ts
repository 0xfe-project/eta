/**
 * Start the host and Vite together without asking either platform's shell to
 * expand variables. Windows `cmd.exe` and macOS `/bin/sh` do not share the
 * syntax, so the package script runs this file directly and this file passes
 * argv and environment explicitly.
 */
import { dirname, join } from "node:path";
import process from "node:process";

const root = dirname(import.meta.dirname);
const desktop = process.argv.includes("--desktop");

function port(name: string, fallback: number): string {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return String(fallback);

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(
      `${name} must be a port from 1 to 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return String(value);
}

const hostPort = port("ETA_PORT", 8787);
const webPort = port("ETA_WEB_PORT", 3000);
const hostOrigin =
  process.env.ETA_HOST_ORIGIN?.trim() || `http://127.0.0.1:${hostPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const env = {
  ...process.env,
  ETA_HOST_ORIGIN: hostOrigin,
  ETA_PORT: hostPort,
  ETA_WEB_PORT: webPort,
};
const shared = {
  cwd: root,
  env,
  stdin: "inherit" as const,
  stdout: "inherit" as const,
  stderr: "inherit" as const,
};

console.log(`[dev] host ${hostOrigin}`);
console.log(`[dev] web  ${webOrigin}`);
if (desktop) console.log("[dev] desktop enabled");

const host = Bun.spawn(
  [
    process.execPath,
    "--watch",
    "apps/eta/src/main.ts",
    "--port",
    hostPort,
    "--allow-origin",
    webOrigin,
    "--github",
  ],
  shared,
);

let web: Bun.Subprocess<"inherit", "inherit", "inherit">;
try {
  web = Bun.spawn(
    [process.execPath, "run", "--cwd", "apps/web", "dev"],
    shared,
  );
} catch (error) {
  host.kill();
  throw error;
}

const children = [
  { name: "host", process: host },
  { name: "web", process: web },
];
let stopping = false;

async function waitForReady(url: string): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (stopping) return false;
    try {
      const answer = await fetch(`${url}/up`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (answer.ok) return true;
    } catch {
      // The listener may not exist yet; keep trying until the deadline.
    }
    await Bun.sleep(100);
  }
  return false;
}

async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;

  for (const { process: child } of children) {
    if (child.exitCode === null) child.kill();
  }

  const closed = Promise.all(
    children.map(({ process: child }) => child.exited),
  ).then(() => true);
  if (await Promise.race([closed, Bun.sleep(3_000).then(() => false)])) return;

  for (const { process: child } of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

function watch(entry: (typeof children)[number]): void {
  const { name, process: child } = entry;
  void child.exited.then((code) => {
    if (stopping) return;
    console.error(`[dev] ${name} exited with code ${String(code)}; stopping`);
    void stop(code ?? 1);
  });
}

for (const child of children) watch(child);

if (desktop) {
  const ready = await Promise.all([
    waitForReady(hostOrigin),
    waitForReady(webOrigin),
  ]);
  if (ready.every(Boolean)) {
    const shell = Bun.spawn(["hutch", "run", "dev"], {
      cwd: join(root, "apps", "desktop"),
      env: { ...env, ETA_DESKTOP_WEB_URL: webOrigin },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const entry = { name: "desktop", process: shell };
    children.push(entry);
    watch(entry);
  } else {
    console.error("[dev] host or web did not become ready within 20s");
    await stop(1);
  }
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

await Promise.all(children.map(({ process: child }) => child.exited));
