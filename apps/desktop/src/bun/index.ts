/**
 * The desktop shell. Opening the app starts the host and shows its page.
 *
 * The host (`apps/eta`) is the whole product in one Bun process: the page, the database and the
 * socket live behind its one port. This process finds a free port, starts that one, and points
 * the window at it. With no built page (`apps/web/dist`) the host serves the socket only and the
 * window says so.
 *
 * The host lives as long as the app, not as long as a window: closing the window is closing a
 * window (Dock click brings it back), and quitting the app is what stops the host.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import Electrobun, { BrowserWindow } from "electrobun/main";
import { HOST_WRAPPER } from "./host";

/** The repository root: the directory holding `apps/eta` and `apps/web`, found by walking up. */
function repoRoot(): string {
  // Dev bundles the main process inside build/<app>.app, so the root can sit many levels up.
  let dir = dirname(Bun.main);
  for (;;) {
    if (existsSync(join(dir, "apps", "eta", "src", "main.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `cannot find the repository root above ${Bun.main}: expected apps/eta/src/main.ts`,
  );
}

/** `bun` beside this runtime when there is one, else whatever `bun` is on PATH. */
function bunBinary(): string {
  const beside = join(dirname(process.execPath), "bun");
  return existsSync(beside) ? beside : "bun";
}

/**
 * The port the host actually bound, read from a file rather than its stdout.
 *
 * The Electrobun launcher owns this process's stdout for its own protocol, so a pipe off the
 * host does not arrive as the host wrote it. The host prints one JSON summary first; a wrapper
 * keeps that line and lets the rest through.
 */
async function boundPort(file: string, child: Bun.Subprocess): Promise<number> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.includes("\n")) {
      return (JSON.parse(text.slice(0, text.indexOf("\n"))) as { port: number })
        .port;
    }
    // `await child.exited` would wait for the host to exit; only its exitCode is a question now.
    if (child.exitCode !== null) {
      throw new Error(
        `the host exited with ${child.exitCode} before it was ready`,
      );
    }
    if (Date.now() > deadline)
      throw new Error("the host was not ready after 20s");
    await Bun.sleep(100);
  }
}

const root = repoRoot();
const built = existsSync(join(root, "apps", "web", "dist", "index.html"));

const runtime = join(tmpdir(), "eta-desktop");
await mkdir(runtime, { recursive: true });
const summary = join(runtime, "host.json");
await rm(summary, { force: true });

// A file import is bundled inline and build.copy never lands in the dev bundle, so the script bun
// runs is written out from this string. It is src/bun/host.ts; keep the two the same.
const wrapper = join(runtime, "host.ts");
await Bun.write(wrapper, HOST_WRAPPER);

const host = Bun.spawn(
  [
    bunBinary(),
    wrapper,
    bunBinary(),
    "apps/eta/src/main.ts",
    // Port 0: the host picks a free port and says which in its summary.
    "--port",
    "0",
    "--github",
    ...(built
      ? ["--web-dir", "apps/web/dist"]
      : ["--allow-origin", "http://127.0.0.1:3000"]),
  ],
  // The host keeps its data in ~/.eta; HOME is the only way to point it elsewhere.
  {
    cwd: root,
    env: { ...process.env, ETA_DESKTOP_SUMMARY: summary },
    stdout: "inherit",
    stderr: "inherit",
  },
);

let port: number;
try {
  port = await boundPort(summary, host);
} catch (error) {
  host.kill();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const url = built ? `http://127.0.0.1:${port}` : "views://mainview/index.html";

function open(): BrowserWindow {
  return new BrowserWindow({
    title: "eta",
    url,
    frame: { width: 1280, height: 800 },
  });
}

let window = open();

// A Dock click on a windowless app asks for its window back.
Electrobun.events.on("reopen", () => {
  if (window.isVisible()) {
    window.activate();
    return;
  }
  window = open();
});

/** Quitting is the one thing that stops the host: its sessions flush, its files close. */
let stopping = false;
async function stopHost(): Promise<void> {
  if (stopping) return;
  stopping = true;
  host.kill("SIGTERM");
  const exited = host.exited;
  const gaveUp = new Promise((resolve) =>
    setTimeout(resolve, 5_000, "timeout"),
  );
  if ((await Promise.race([exited, gaveUp])) === "timeout")
    host.kill("SIGKILL");
}

Electrobun.events.on("before-quit", (event) => {
  if (stopping) return;
  // The emitter does not await; refuse this quit, stop the host, then ask again.
  (event as { response?: { allow: boolean } }).response = { allow: false };
  void stopHost().then(() => Electrobun.Utils.quit());
});

process.on("SIGINT", () => void stopHost().then(() => process.exit(0)));
process.on("SIGTERM", () => void stopHost().then(() => process.exit(0)));
