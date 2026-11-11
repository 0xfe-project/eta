/**
 * The app stopping a real host (`apps/eta/src/main.ts`, from source), the way it does on each
 * platform: a signal, or on Windows, which has none, a line on the host's stop pipe. A host that
 * stops the polite way takes its `running-host.json` with it; one that is killed leaves it, which
 * is how these tell the two apart.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_WRAPPER } from "../src/bun/host";
import { LocalHost } from "../src/bun/service";

const MAIN = fileURLToPath(new URL("../../eta/src/main.ts", import.meta.url));
const FLAGS = ["--no-llm", "--no-web", "--no-github"];

let dir: string;
let home: string;
let host: LocalHost | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-real-host-"));
  home = join(dir, "home");
});
afterEach(async () => {
  await host?.stop();
  host = undefined;
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** HOME is where the host keeps `.eta`; USERPROFILE is what a home is on Windows. */
const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
});

const record = (): string => join(home, ".eta", "running-host.json");

const up = async (port: number): Promise<boolean> =>
  await fetch(`http://127.0.0.1:${String(port)}/up`).then(
    (answer) => answer.ok,
    () => false,
  );

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (ready: () => Promise<boolean>, ms: number) => {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
};

describe("a real host", () => {
  it("stops when the app stops it, and in good order", async () => {
    const wrapper = join(dir, "wrapper.ts");
    await writeFile(wrapper, HOST_WRAPPER);
    host = new LocalHost({
      command: [process.execPath, MAIN, ...FLAGS],
      cwd: dir,
      env: env(),
      wrapper,
      bun: process.execPath,
      summary: join(dir, "summary"),
    });
    await host.spawn();
    const port = await host.ready();
    await until(() => up(port), 30_000);
    expect(await Bun.file(record()).exists()).toBe(true);

    const started = Date.now();
    await host.stop();
    // Well inside the ten seconds after which the app kills it.
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await up(port)).toBe(false);
    expect(await Bun.file(record()).exists()).toBe(false);
  }, 60_000);

  it("stops when the app is killed outright", async () => {
    const wrapper = join(dir, "wrapper.ts");
    const shell = join(dir, "shell.ts");
    const summary = join(dir, "summary");
    await writeFile(wrapper, HOST_WRAPPER);
    // The app as it starts the host, with the stop pipe it would make up on Windows.
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\eta-real-host-${String(process.pid)}-${String(Date.now())}`
        : "";
    await writeFile(
      shell,
      `Bun.spawn(${JSON.stringify([process.execPath, wrapper, process.execPath, MAIN, ...FLAGS, "--port", "0"])}, {
         env: { ...process.env, ETA_DESKTOP_SUMMARY: ${JSON.stringify(summary)}, ETA_STOP_PIPE: ${JSON.stringify(pipe)} },
         stdout: "ignore", stderr: "ignore",
       });
       setInterval(() => {}, 1000);`,
    );
    const app = Bun.spawn([process.execPath, shell], {
      env: env(),
      stdout: "ignore",
      stderr: "ignore",
    });
    await until(
      async () =>
        (
          await Bun.file(summary)
            .text()
            .catch(() => "")
        ).includes("\n"),
      30_000,
    );
    const { port } = JSON.parse(
      (await Bun.file(summary).text()).split("\n")[0] as string,
    ) as { port: number };
    await until(() => up(port), 30_000);
    const { pid } = (await Bun.file(record()).json()) as { pid: number };

    // No signal handler runs: on Windows this is TerminateProcess.
    app.kill("SIGKILL");
    await app.exited;
    await until(async () => !alive(pid), 15_000);
    expect(await up(port)).toBe(false);
    // Elsewhere the wrapper sees the app gone and stops the host the polite way. On Windows the
    // app's children share its job object, which takes the wrapper and the host down with it on
    // the spot, so nothing is left to stop and the record stays behind for the next start to
    // find dead (`running.ts` checks the pid).
    if (process.platform !== "win32")
      await until(async () => !(await Bun.file(record()).exists()), 5000);
    else
      console.warn(
        "running-host.json left behind:",
        await Bun.file(record()).exists(),
      );
  }, 60_000);
});
