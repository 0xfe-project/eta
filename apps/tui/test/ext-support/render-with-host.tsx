/**
 * The whole interface on a real host: an in-process test host in a temporary directory, the real
 * connection controller set to that host as a resident one, and the real App with only the
 * extensions a test gives it. Everything it starts is stopped after the test, whether the test
 * passed or not.
 */
import type { Host } from "@eta/app/src/host";
import type { TuiPaths } from "../../src/config/types";
import type {
  ConnectionController,
  WireClient,
} from "../../src/connection/types";
import type { Extension } from "../../src/extensions/types";
import type { ProcessLaunch } from "../../src/ui/editor";
import type { TestHostOptions } from "../support/host";
import type { Rendered } from "../ui-support/render";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";
import { afterEach } from "vitest";
import { loadConfig } from "../../src/config/load";
import { resolvePaths } from "../../src/config/paths";
import { ensureConfigFile } from "../../src/config/save";
import { loadState, saveState } from "../../src/config/state";
import { createConnectionController } from "../../src/connection/controller";
import { createRegistry } from "../../src/extensions/registry";
import { App } from "../../src/ui/app";
import { baseUrl, closedPort, closeHost, testHost } from "../support/host";
import { tempDir } from "../support/temp";
import { flush, KEYS, plain, realDelay, renderInk } from "../ui-support/render";

const DEFAULT_WAIT_MS = 10_000;
// Well inside the 30 s test timeout (vitest.config.ts), so a failed connection reports its screen
// instead of vitest's bare timeout.
const CONNECT_WAIT_MS = 15_000;
const POLL_MS = 10;
/** How long the command input may take to show a pasted line, and to clear it after Enter. */
const INPUT_WAIT_MS = 2_000;
const PROMPT = "› ";

export interface HostRenderOptions {
  /** The registry holds these and nothing else. */
  extensions: Extension[];
  host?: TestHostOptions;
  /** Runs on the host after it starts and before the interface connects: data to find on arrival. */
  seed?: (host: Host) => void | Promise<void>;
  /** Written into `tui.json` next to the connection. `locale` is `"en"` unless given. */
  settings?: Record<string, unknown>;
  columns?: number;
  rows?: number;
  /**
   * The environment of the controller and the App. HOME, USERPROFILE, APPDATA, XDG_CONFIG_HOME and
   * ETA_TUI_CONFIG always point into the temporary directory, whatever this says.
   */
  env?: NodeJS.ProcessEnv;
  /** What a program handed the terminal (editor, `ssh -t`) does; it exits with 0 by default. */
  runProcess?: (launch: ProcessLaunch) => Promise<number | null>;
}

export interface HostRendered extends Rendered {
  host: Host;
  controller: ConnectionController;
  /** The wire the shell connected on. */
  wire: WireClient;
  paths: TuiPaths;
  /** The temporary HOME; the settings and state files are under it. */
  home: string;
  env: NodeJS.ProcessEnv;
  /** Every program the interface asked to run on the terminal, in order. */
  launches: ProcessLaunch[];
  /** The last frame as text. */
  screen: () => string;
  /**
   * Types a line into the home screen's command input and presses Enter. Throws when the input
   * does not show the line, or keeps it after Enter: the input only has the keys while no layer
   * is open, so with a layer open, open the next one from a kept context. Resolves once the
   * command has started, not when an async command has finished.
   */
  runCommand: (line: string) => Promise<void>;
  /** Waits until the screen shows `text`; on timeout the error carries the screen it had. */
  waitFor: (text: string | RegExp, timeoutMs?: number) => Promise<void>;
  /** Waits until the screen no longer shows `text`. */
  waitForGone: (text: string | RegExp, timeoutMs?: number) => Promise<void>;
  /**
   * Waits until `predicate` holds, rendering as it goes. A predicate that throws counts as not
   * holding yet; the timeout error carries the last thing it threw.
   */
  waitUntil: (
    predicate: () => boolean,
    what: string,
    timeoutMs?: number,
  ) => Promise<void>;
  /** Lets the host answer and the screen catch up: a real pause, then the pending renders. */
  settle: (ms?: number) => Promise<void>;
  /** Unmounts, stops the controller, closes the host. Runs after the test anyway; twice is harmless. */
  close: () => Promise<void>;
}

const open = new Set<() => Promise<void>>();

afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of [...open]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
});

function shows(screen: string, text: string | RegExp): boolean {
  return typeof text === "string" ? screen.includes(text) : text.test(screen);
}

/** Waits until the rendered screen shows `text`; on timeout the error carries the screen. */
export async function waitForText(
  rendered: Pick<Rendered, "lastFrame">,
  text: string | RegExp,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<void> {
  await waitForScreen(
    rendered,
    (screen) => shows(screen, text),
    `${String(text)} to show`,
    timeoutMs,
  );
}

async function waitForScreen(
  rendered: Pick<Rendered, "lastFrame">,
  holds: (screen: string) => boolean,
  what: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    await flush();
    try {
      if (holds(plain(rendered))) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await realDelay(POLL_MS);
  }
  const thrown =
    lastError === undefined ? "" : `; it last threw: ${String(lastError)}`;
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for ${what}${thrown}; the screen was:\n${plain(rendered)}`,
  );
}

/** Whether `path` is inside `dir`. */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !/^[a-z]:/i.test(rel);
}

export async function renderWithHost(
  options: HostRenderOptions,
): Promise<HostRendered> {
  const host = await testHost(options.host);
  // Registered at once: a test that fails from here on still gets everything stopped.
  let close: () => Promise<void> = async () => closeHost(host);
  const closeLater = () => close();
  open.add(closeLater);

  await options.seed?.(host);
  const home = await tempDir("eta-tui-kit-home-");
  const env: NodeJS.ProcessEnv = {
    ETA_TOKEN: "",
    ...options.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    ETA_TUI_CONFIG: join(home, "eta", "tui.json"),
  };
  const paths = resolvePaths(env, process.platform, home);
  // Never write the user's own settings.
  if (!isInside(home, paths.config) || !isInside(home, paths.state))
    throw new Error(
      `the settings would leave the temporary directory: ${JSON.stringify(paths)}`,
    );
  const token = options.host?.token;
  const connection = {
    mode: "resident" as const,
    url: baseUrl(host),
    ...(token === undefined ? {} : { token }),
  };
  await ensureConfigFile(paths.config);
  await writeFile(
    paths.config,
    `${JSON.stringify({ locale: "en", ...options.settings, connection }, null, 2)}\n`,
  );
  const loaded = await loadConfig(paths.config);
  if (loaded.problems.length > 0)
    throw new Error(
      `the test settings were not all used: ${JSON.stringify(loaded.problems)}`,
    );

  const controller = createConnectionController({
    paths,
    setting: loaded.config.connection,
    env,
    findHost: () => undefined,
    tuiVersion: "dev",
    // Never the real 127.0.0.1:8787.
    localUrl: `http://127.0.0.1:${await closedPort()}`,
  });
  const launches: ProcessLaunch[] = [];
  const rendered = renderInk(
    <App
      deps={{
        controller,
        registry: createRegistry(options.extensions),
        paths,
        initialConfig: loaded,
        initialState: await loadState(paths.state),
        env,
        platform: process.platform,
        tuiVersion: "dev",
        loadConfig,
        ensureConfigFile,
        saveState,
        runProcess: async (launch) => {
          launches.push(launch);
          return options.runProcess ? options.runProcess(launch) : 0;
        },
        which: () => null,
        quit: async () => controller.stop(),
      }}
    />,
    { columns: options.columns ?? 100, rows: options.rows ?? 30 },
  );

  let closed = false;
  close = async () => {
    if (closed) return;
    closed = true;
    open.delete(closeLater);
    try {
      rendered.unmount();
    } finally {
      try {
        await controller.stop();
      } finally {
        await closeHost(host);
      }
    }
  };

  const waitFor = (text: string | RegExp, timeoutMs = DEFAULT_WAIT_MS) =>
    waitForText(rendered, text, timeoutMs);
  const waitForGone = (text: string | RegExp, timeoutMs = DEFAULT_WAIT_MS) =>
    waitForScreen(
      rendered,
      (screen) => !shows(screen, text),
      `${String(text)} to go`,
      timeoutMs,
    );
  const waitUntil = (
    predicate: () => boolean,
    what: string,
    timeoutMs = DEFAULT_WAIT_MS,
  ) => waitForScreen(rendered, () => predicate(), what, timeoutMs);

  await controller.start();
  const url = baseUrl(host);
  await waitForScreen(
    rendered,
    (screen) =>
      controller.getState().phase.name === "connected" && screen.includes(url),
    "the shell to connect",
    CONNECT_WAIT_MS,
  );
  const wire = controller.getState().wire;
  if (wire === undefined) throw new Error("connected without a wire");

  return {
    ...rendered,
    host,
    controller,
    wire,
    paths,
    home,
    env,
    launches,
    screen: () => plain(rendered),
    runCommand: async (line) => {
      const typed = `${PROMPT}${line}`;
      await rendered.press(KEYS.paste(line));
      try {
        await waitForText(rendered, typed, INPUT_WAIT_MS);
      } catch (error) {
        throw new Error(
          `the command input did not take ${line} (is a layer open?)`,
          { cause: error },
        );
      }
      await rendered.press(KEYS.enter);
      await waitForScreen(
        rendered,
        (screen) => !screen.includes(typed),
        `the command input to clear after ${line}`,
        INPUT_WAIT_MS,
      );
    },
    waitFor,
    waitForGone,
    waitUntil,
    settle: async (ms = 100) => {
      await realDelay(ms);
      await flush();
    },
    close: closeLater,
  };
}
