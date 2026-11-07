/**
 * Install a packaged app the way its user would and see it start: `release.yml` runs this on each
 * platform's runner, over the installer it is about to publish.
 *
 *   bun apps/desktop/scripts/try-app.ts <installer>
 *
 * A first launch asks where the host should run, and nobody is at this window, so the app is told
 * (`ETA_DESKTOP_CONNECTION`). It then downloads a host from the repository it was built for
 * (`src/bun/download.ts`; `GH_TOKEN` reads a private one), starts it, and the host names its port
 * in `<tmp>/eta-desktop/host.json` (`src/bun/index.ts`). The app has started when the host answers
 * on that port. That proves the installer, the launcher, the runtime, the download and a host it
 * can run; it says nothing about what the window shows.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { $, spawn } from "bun";

/** Unpacking the app on its first start, and downloading a 390MB host. */
const TIMEOUT_MS = 300_000;

const [installer] = process.argv.slice(2);
if (installer === undefined) {
  console.error("usage: bun try-app.ts <installer>");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "eta-try-app-"));
const summary = join(tmpdir(), "eta-desktop", "host.json");
const log = join(work, "app.log");
rmSync(summary, { force: true });

const onlyEntry = (dir: string, wanted: (name: string) => boolean): string => {
  const found = readdirSync(dir).filter(wanted);
  if (found.length !== 1)
    throw new Error(`expected one such file in ${dir}, found ${found.length}`);
  return join(dir, found[0] as string);
};

/** What to run to install the app. Each of these goes on to start it. */
async function installCommand(file: string): Promise<string[]> {
  if (process.platform === "darwin") {
    const mount = join(work, "image");
    await $`hdiutil attach -nobrowse -readonly -mountpoint ${mount} ${file}`.quiet();
    const app = join(work, "eta.app");
    await $`ditto ${onlyEntry(mount, (name) => name.endsWith(".app"))} ${app}`;
    await $`hdiutil detach ${mount}`.quiet();
    return [join(app, "Contents", "MacOS", "launcher")];
  }
  if (process.platform === "win32") {
    // Windows's own tar reads a zip; the one Git for Windows puts first on PATH does not.
    const tar = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "tar.exe",
    );
    await $`${tar} -xf ${file} -C ${work}`;
    return [onlyEntry(work, (name) => name.endsWith("-Setup.exe"))];
  }
  await $`tar -xzf ${file} -C ${work}`;
  return [join(work, "installer")];
}

const out = Bun.file(log);
const app = spawn(await installCommand(resolve(installer)), {
  cwd: work,
  env: {
    ...process.env,
    ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1",
    ETA_DESKTOP_CONNECTION: "local",
  },
  stdin: "ignore",
  stdout: out,
  stderr: out,
});

const hostOf = (): { pid: number; port: number } | undefined => {
  try {
    const text = readFileSync(summary, "utf8");
    return text.includes("\n")
      ? (JSON.parse(text.slice(0, text.indexOf("\n"))) as {
          pid: number;
          port: number;
        })
      : undefined;
  } catch {
    return undefined;
  }
};

const deadline = Date.now() + TIMEOUT_MS;
let host = hostOf();
while (host === undefined && Date.now() < deadline) {
  await Bun.sleep(500);
  host = hostOf();
}
if (host === undefined) {
  console.error(
    `no host after ${TIMEOUT_MS / 1000}s, app exited with ${app.exitCode}`,
  );
  console.error(readFileSync(log, "utf8"));
  process.exit(1);
}

const origin = `http://127.0.0.1:${host.port}`;
const up = await fetch(`${origin}/up`);
const page = await fetch(`${origin}/`);
const started = up.ok && page.ok;
console.log(
  `host ${host.pid} on ${origin}: /up ${up.status}, / ${page.status}`,
);

// The window stays until the runner goes; nothing after this step needs it gone.
process.kill(host.pid);
app.kill();
process.exit(started ? 0 : 1);
