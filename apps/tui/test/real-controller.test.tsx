/**
 * The interface on the real controller and a real temporary host: the seam the screen tests
 * cover with a hand-driven controller.
 */
import type { HostProgram } from "../src/connection/types";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import { createConnectionController } from "../src/connection/controller";
import { extensions } from "../src/extensions.gen";
import { createRegistry } from "../src/extensions/registry";
import { App } from "../src/ui/app";
import { childEnv, closedPort, SOURCE_HOST } from "./support/host";
import { tempDir, until } from "./support/temp";
import { loaded, testConfig } from "./ui-support/config";
import { flush, KEYS, plain, renderInk } from "./ui-support/render";

const recordingHost = resolve(
  import.meta.dirname,
  "ui-support/fixtures/recording-host.ts",
);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it("goes from the first start to a temporary host, loses it, starts another and stops it on quit", async () => {
  const home = await tempDir("eta-tui-real-home-");
  const dir = await tempDir("eta-tui-real-conf-");
  const pidFile = join(dir, "host.pid");
  const program: HostProgram = {
    command: process.execPath,
    args: [recordingHost, SOURCE_HOST.command, ...SOURCE_HOST.args],
  };
  const paths = {
    config: join(dir, "tui.json"),
    state: join(dir, "tui-state.json"),
  };
  const controller = createConnectionController({
    paths,
    setting: undefined,
    env: { ...childEnv(home), RECORD_PID_FILE: pidFile },
    findHost: () => program,
    tuiVersion: "dev",
    // Never the real 127.0.0.1:8787.
    localUrl: `http://127.0.0.1:${await closedPort()}`,
  });
  const pids: number[] = [];
  cleanups.push(async () => {
    await controller.stop();
    for (const pid of pids) if (alive(pid)) process.kill(pid);
  });
  const hostPid = async () => {
    const pid = Number(await readFile(pidFile, "utf8"));
    pids.push(pid);
    return pid;
  };

  let quits = 0;
  const r = renderInk(
    <App
      deps={{
        controller,
        registry: createRegistry(extensions),
        paths,
        initialConfig: loaded(testConfig({ connection: undefined })),
        initialState: { tabs: [], activeTab: undefined },
        env: {},
        platform: process.platform,
        tuiVersion: "dev",
        loadConfig: async () => loaded(testConfig({ connection: undefined })),
        ensureConfigFile: async () => undefined,
        saveState: async () => undefined,
        runProcess: async () => 0,
        which: () => null,
        quit: async () => {
          quits += 1;
          await controller.stop();
        },
      }}
    />,
    { columns: 120, rows: 40 },
  );
  cleanups.push(() => r.unmount());
  const screenShows = (text: string, timeoutMs = 60_000) =>
    until(
      async () => {
        await flush();
        return plain(r).includes(text);
      },
      timeoutMs,
      `the screen to show ${text}`,
    );

  await controller.start();
  await screenShows("Start a temporary host");

  await r.press("2");
  await screenShows("Temporary host:", 90_000);
  const first = await hostPid();
  expect(alive(first)).toBe(true);

  await r.type("/help");
  await r.press(KEYS.enter);
  await screenShows("Esc to close");

  process.kill(first);
  await screenShows("The temporary host exited.", 30_000);
  expect(controller.getState().phase.name).toBe("unreachable");
  // The /help layer went with the shell: the choices are on screen and take the keys.
  expect(plain(r)).not.toContain("Esc to close");
  expect(plain(r)).toContain("Use a temporary host");

  await r.press("1");
  await screenShows("Temporary host:", 90_000);
  await until(
    async () => (await hostPid()) !== first,
    10_000,
    "a new host pid",
  );
  const second = pids.at(-1)!;
  expect(alive(second)).toBe(true);

  await r.press(KEYS.ctrlC);
  await r.press(KEYS.ctrlC);
  await until(
    () => controller.getState().phase.name === "stopped",
    30_000,
    "the stop",
  );
  expect(quits).toBe(1);
  await until(() => !alive(second), 15_000, "the second host to end");
  expect(alive(first)).toBe(false);
}, 240_000);
