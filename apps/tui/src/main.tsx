/**
 * `eta`: the terminal interface of an eta host.
 *
 *   eta              open the interface
 *   eta --version    print the version
 *   eta --help       print the usage
 */
import type { Locale } from "./config/types";
import os from "node:os";
import process from "node:process";
import { render } from "ink";
import { loadConfig } from "./config/load";
import { resolvePaths } from "./config/paths";
import { ensureConfigFile } from "./config/save";
import { loadState, saveState } from "./config/state";
import {
  createConnectionController,
  DEFAULT_TIMING,
} from "./connection/controller";
import { findHostProgram } from "./connection/host-program";
import { extensions } from "./extensions.gen";
import { createRegistry } from "./extensions/registry";
import { chooseLocale } from "./i18n/locale";
import { translatorFor } from "./i18n/messages";
import { App } from "./ui/app";
import { mainMessages } from "./ui/entry-messages";
import { createTerminalMouse } from "./ui/mouse/terminal";
import { runInterface, runOnTerminal } from "./ui/run-interface";
import { TUI_VERSION } from "./version";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
// A graceful stop gives up on the temporary host after `temporaryStopMs` and kills it; a crash
// allows that and a little more, then kills whatever is left itself.
const CRASH_STOP_DEADLINE_MS = DEFAULT_TIMING.temporaryStopMs + 2_000;

/** Answers the arguments that need no terminal; returns the exit code, or undefined to open the interface. */
function answerArguments(
  args: readonly string[],
  locale: Locale,
): number | undefined {
  const t = translatorFor(mainMessages, locale);
  const usage = () =>
    t("usage", {
      config: resolvePaths(process.env, process.platform, os.homedir()).config,
    });
  const [first] = args;
  if (first === undefined) return undefined;
  if (args.length === 1 && first === "--version") {
    process.stdout.write(`eta ${TUI_VERSION}\n`);
    return EXIT_OK;
  }
  if (args.length === 1 && (first === "--help" || first === "-h")) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }
  const unknown =
    args.find((a) => !["--version", "--help", "-h"].includes(a)) ??
    args.join(" ");
  process.stderr.write(
    `${t("unknownArgument", { arg: unknown })}\n\n${usage()}\n`,
  );
  return EXIT_USAGE;
}

async function openInterface(): Promise<void> {
  const home = os.homedir();
  const paths = resolvePaths(process.env, process.platform, home);
  const loaded = await loadConfig(paths.config);
  const state = await loadState(paths.state);
  const registry = createRegistry(extensions);
  const controller = createConnectionController({
    paths,
    setting: loaded.config.connection,
    env: process.env,
    findHost: () =>
      findHostProgram({ env: process.env, platform: process.platform, home }),
    tuiVersion: TUI_VERSION,
  });
  const mouse = createTerminalMouse({
    stdin: process.stdin,
    write: (text) => process.stdout.write(text),
  });

  runInterface({
    process,
    controller,
    deadlineMs: CRASH_STOP_DEADLINE_MS,
    mouse: mouse.reporting,
    startProgram: runOnTerminal,
    draw: ({ quit, runProcess }) =>
      render(
        mouse.provide(
          <App
            deps={{
              controller,
              registry,
              paths,
              initialConfig: loaded,
              initialState: state,
              env: process.env,
              platform: process.platform,
              tuiVersion: TUI_VERSION,
              loadConfig,
              ensureConfigFile,
              saveState,
              runProcess,
              which: (command) => Bun.which(command),
              quit,
            }}
          />,
        ),
        {
          stdin: mouse.stdin,
          alternateScreen: true,
          exitOnCtrlC: false,
        },
      ),
  });

  await controller.start();
}

function main(): void {
  const locale = chooseLocale(undefined, process.env);
  const answered = answerArguments(process.argv.slice(2), locale);
  if (answered !== undefined) {
    process.exitCode = answered;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      `${translatorFor(mainMessages, locale)("needsTerminal")}\n`,
    );
    process.exitCode = EXIT_FAILURE;
    return;
  }
  openInterface().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(EXIT_FAILURE);
  });
}

main();
