import type {
  ConfigProblem,
  LoadedConfig,
  SaveProblem,
  TuiConfig,
  TuiPaths,
  TuiState,
} from "../config/types";
import type {
  ConnectionController,
  ConnectionState,
  WireClient,
  WireStatus,
} from "../connection/types";
import type { Registry } from "../extensions/registry";
import type { ShellContext } from "../extensions/types";
import type { ProcessLaunch } from "./editor";
import type { Session } from "./shell/session";
import { Box, Text, useApp, useWindowSize } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useStore } from "zustand";
import { formatKeyBinding } from "../config/keys";
import { InputScope } from "../extensions/input-scope";
import {
  ConfigContext,
  RegistryContext,
  RunningShellContext,
  useAction,
  useConfig,
  useTheme,
} from "../extensions/react";
import { chooseLocale } from "../i18n/locale";
import { translatorFor } from "../i18n/messages";
import { LocaleContext, useMessages } from "../i18n/react";
import { ConfigProblemsLayer } from "./config-problems";
import { editorLaunch } from "./editor";
import { screenMessages } from "./screens/messages";
import {
  FirstRunScreen,
  HostMissingScreen,
  InstallFailedScreen,
  InstallingScreen,
  ReconnectingScreen,
  StartingScreen,
  UnauthorizedScreen,
  UnreachableScreen,
} from "./screens/phase-screens";
import { createShellContext } from "./shell-context";
import { shellMessages } from "./shell/messages";
import { createSession } from "./shell/session";
import { Shell } from "./shell/shell";
import { inkColor } from "./theme";

/** What the interface needs from the program around it. Tests pass doubles for all of it. */
export interface AppDeps {
  controller: ConnectionController;
  registry: Registry;
  paths: TuiPaths;
  initialConfig: LoadedConfig;
  initialState: TuiState;
  /** Read for the language when the settings name none, and for the editor. */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  tuiVersion: string;
  loadConfig: (file: string) => Promise<LoadedConfig>;
  ensureConfigFile: (file: string) => Promise<SaveProblem | undefined>;
  saveState: (
    file: string,
    state: TuiState,
  ) => Promise<SaveProblem | undefined>;
  /** Runs a program on the terminal with inherited stdio; resolves with its exit code, rejects when it cannot start. */
  runProcess: (launch: ProcessLaunch) => Promise<number | null>;
  /** The full path of a program on `PATH`, or null. */
  which: (command: string) => string | null;
  /** Stop the controller, leave the alternate screen, exit. */
  quit: () => Promise<void>;
}

const QUIT_WINDOW_MS = 2_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function saveProblemReason(problem: SaveProblem, notJson: string): string {
  return problem.reason === "io" ? problem.detail : notJson;
}

/**
 * What the settings file had wrong at start, over whatever screen is showing until a key closes
 * it. It is not one of the shell's layers: it shows before there is a shell.
 */
function StartupProblems({
  problems,
  onClose,
}: {
  problems: readonly ConfigProblem[];
  onClose: () => void;
}) {
  const handle = useMemo(() => ({ close: onClose }), [onClose]);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <ConfigProblemsLayer problems={problems} handle={handle} />
    </Box>
  );
}

/** Saves the tabs whenever they change, one write at a time, and reports a failed write. */
function useSaveTabs(deps: AppDeps, session: Session) {
  const t = useMessages(shellMessages);
  const translateRef = useRef(t);
  translateRef.current = t;
  useEffect(() => {
    let queue = Promise.resolve();
    return session.store.subscribe((state, previous) => {
      if (
        state.tabs === previous.tabs &&
        state.activeTab === previous.activeTab
      )
        return;
      const snapshot: TuiState = {
        tabs: state.tabs,
        activeTab: state.activeTab,
      };
      queue = queue.then(async () => {
        const problem = await deps.saveState(deps.paths.state, snapshot);
        if (problem)
          session.notify(
            translateRef.current("stateNotSaved", {
              file: problem.file,
              reason: saveProblemReason(
                problem,
                translateRef.current("settingsNotJson"),
              ),
            }),
            "warning",
          );
      });
    });
  }, [deps, session]);
}

/** Reports each new settings write problem of the controller once. */
function useReportSaveProblem(state: ConnectionState, session: Session) {
  const t = useMessages(shellMessages);
  const reportedRef = useRef<SaveProblem | undefined>(undefined);
  useEffect(() => {
    const problem = state.saveProblem;
    if (!problem || problem === reportedRef.current) return;
    reportedRef.current = problem;
    session.notify(
      t("settingsNotSaved", {
        file: problem.file,
        reason: saveProblemReason(problem, t("settingsNotJson")),
      }),
      "error",
    );
  }, [state.saveProblem, session, t]);
}

/** Calls every extension's `onConnected` on each hello of the current wire. */
function useOnConnected(
  deps: AppDeps,
  state: ConnectionState,
  ctx: ShellContext | undefined,
  session: Session,
) {
  const helloSeenRef = useRef(false);
  const wire = state.wire;
  useEffect(() => {
    if (!wire || !ctx) return;
    const hello = () => {
      const first = !helloSeenRef.current;
      helloSeenRef.current = true;
      for (const extension of deps.registry.extensions) {
        if (!extension.onConnected) continue;
        const report = (error: unknown) =>
          session.notify(
            translatorFor(shellMessages, ctx.locale)("extensionFailed", {
              id: extension.id,
              error: errorText(error),
            }),
            "error",
          );
        try {
          void Promise.resolve(extension.onConnected(ctx, first)).catch(report);
        } catch (error) {
          report(error);
        }
      }
    };
    let status: WireStatus = wire.store.getState().status;
    if (status === "open") hello();
    return wire.store.subscribe((next) => {
      const was = status;
      status = next.status;
      if (status === "open" && was !== "open") hello();
    });
  }, [wire, deps, ctx, session]);
}

/** Two presses of `app.quit` within two seconds quit; returns the question to show after the first. */
function useQuitKey(quit: () => void): string | undefined {
  const config = useConfig();
  const t = useMessages(screenMessages);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  useAction("app.quit", () => {
    clearTimeout(timerRef.current);
    if (armedRef.current) {
      armedRef.current = false;
      setArmed(false);
      quit();
      return;
    }
    armedRef.current = true;
    setArmed(true);
    timerRef.current = setTimeout(() => {
      armedRef.current = false;
      setArmed(false);
    }, QUIT_WINDOW_MS);
  });
  const binding = config.keybindings["app.quit"][0];
  return armed && binding
    ? t("quitHint", { key: formatKeyBinding(binding) })
    : undefined;
}

function Footer({
  session,
  quitHint,
}: {
  session: Session;
  quitHint: string | undefined;
}) {
  const theme = useTheme();
  const notice = useStore(session.store, (s) => s.notice);
  const color =
    notice?.tone === "info"
      ? inkColor(theme.text)
      : inkColor(notice?.tone === "warning" ? theme.warning : theme.error);
  return (
    <Box height={1} flexShrink={0} paddingX={2}>
      {quitHint !== undefined ? (
        <Text color={inkColor(theme.warning)} wrap="truncate-end">
          {quitHint}
        </Text>
      ) : (
        notice && (
          <Text color={color} wrap="truncate-end">
            {notice.text}
          </Text>
        )
      )}
    </Box>
  );
}

function PhaseScreen({
  state,
  deps,
  onQuit,
}: {
  state: ConnectionState;
  deps: AppDeps;
  onQuit: () => void;
}) {
  const { phase } = state;
  const { controller } = deps;
  switch (phase.name) {
    case "idle":
    case "connecting":
    case "starting-temporary":
    case "stopped":
      return <StartingScreen phase={phase} version={deps.tuiVersion} />;
    // The shell draws these two once there is a wire; until then the address is all there is.
    case "connected":
    case "reconnecting":
      return (
        <StartingScreen
          phase={{
            name: "connecting",
            url: phase.url,
            temporary: phase.temporary,
          }}
          version={deps.tuiVersion}
        />
      );
    case "first-run":
      return <FirstRunScreen phase={phase} controller={controller} />;
    case "host-missing":
      return (
        <HostMissingScreen
          phase={phase}
          controller={controller}
          platform={deps.platform}
        />
      );
    case "installing":
      return <InstallingScreen phase={phase} />;
    case "install-failed":
      return <InstallFailedScreen phase={phase} controller={controller} />;
    case "unauthorized":
      return <UnauthorizedScreen phase={phase} controller={controller} />;
    case "unreachable":
      return (
        <UnreachableScreen
          phase={phase}
          controller={controller}
          onQuit={onQuit}
        />
      );
  }
}

/** The wire of the shell the controller is in or on its way to; undefined between shells. */
function shellWireOf(state: ConnectionState): WireClient | undefined {
  switch (state.phase.name) {
    case "connecting":
    case "connected":
    case "reconnecting":
      return state.wire;
    default:
      return undefined;
  }
}

function AppBody({
  deps,
  session,
  ctx,
  state,
  startupProblems,
  onStartupProblemsClosed,
}: {
  deps: AppDeps;
  session: Session;
  /** The context of the current shell; undefined between shells. */
  ctx: ShellContext | undefined;
  state: ConnectionState;
  startupProblems: readonly ConfigProblem[];
  onStartupProblemsClosed: () => void;
}) {
  const { columns, rows } = useWindowSize();
  const quit = () => void deps.quit();
  const quitHint = useQuitKey(quit);
  useSaveTabs(deps, session);
  useReportSaveProblem(state, session);
  useOnConnected(deps, state, ctx, session);

  const { phase } = state;
  const shellPhase =
    phase.name === "connected" || phase.name === "reconnecting"
      ? phase
      : undefined;
  const shellCtx =
    shellPhase !== undefined && state.wire !== undefined ? ctx : undefined;
  const showShell = shellPhase !== undefined && shellCtx !== undefined;
  const covered = startupProblems.length > 0;
  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      {showShell && (
        <Box
          flexDirection="column"
          flexGrow={1}
          display={phase.name === "connected" && !covered ? "flex" : "none"}
        >
          <InputScope active={phase.name === "connected" && !covered}>
            <RunningShellContext value={shellCtx}>
              <Shell
                session={session}
                url={shellPhase.url}
                temporary={shellPhase.temporary}
                versionWarning={state.versionWarning}
                quitHint={quitHint}
                version={deps.tuiVersion}
              />
            </RunningShellContext>
          </InputScope>
        </Box>
      )}
      {showShell && phase.name === "reconnecting" && !covered && (
        <>
          <ReconnectingScreen phase={phase} />
          <Footer session={session} quitHint={quitHint} />
        </>
      )}
      {!showShell && (
        <>
          <Box
            flexDirection="column"
            flexGrow={1}
            display={covered ? "none" : "flex"}
          >
            <InputScope active={!covered}>
              <PhaseScreen state={state} deps={deps} onQuit={quit} />
            </InputScope>
          </Box>
          {!covered && <Footer session={session} quitHint={quitHint} />}
        </>
      )}
      {covered && (
        <>
          <StartupProblems
            problems={startupProblems}
            onClose={onStartupProblemsClosed}
          />
          <Footer session={session} quitHint={quitHint} />
        </>
      )}
    </Box>
  );
}

/** The whole interface: one screen per connection phase, and the shell once connected. */
export function App({ deps }: { deps: AppDeps }) {
  const { controller } = deps;
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [config, setConfig] = useState<TuiConfig>(deps.initialConfig.config);
  const locale = chooseLocale(config.locale, deps.env);
  const configRef = useRef(config);
  const localeRef = useRef(locale);
  configRef.current = config;
  localeRef.current = locale;
  const { suspendTerminal } = useApp();
  const suspendRef = useRef(suspendTerminal);
  suspendRef.current = suspendTerminal;

  const [session] = useState(() => {
    const created = createSession(deps.initialState);
    created.followShell(shellWireOf(controller.getState()));
    return created;
  });
  // In the controller's own update, not after a render: a layer opened in between must already
  // find its shell gone.
  useEffect(() => {
    const follow = () =>
      session.followShell(shellWireOf(controller.getState()));
    follow();
    return controller.subscribe(follow);
  }, [controller, session]);
  const shell = useStore(session.store, (s) => s.shell);
  const [startupProblems, setStartupProblems] = useState<
    readonly ConfigProblem[]
  >(deps.initialConfig.problems);
  const closeStartupProblems = useCallback(() => setStartupProblems([]), []);

  const ctx = useMemo(() => {
    if (shell === undefined) return undefined;
    const runOnTerminal = async (launch: ProcessLaunch) => {
      let exitCode: number | null = null;
      try {
        await suspendRef.current(async () => {
          exitCode = await deps.runProcess(launch);
        });
        return { exitCode };
      } catch (error) {
        session.notify(
          translatorFor(shellMessages, localeRef.current)("processFailed", {
            command: launch.command,
            error: errorText(error),
          }),
          "error",
        );
        return { exitCode: null };
      }
    };
    return createShellContext({
      controller: deps.controller,
      paths: deps.paths,
      commands: deps.registry.commands,
      pinnedTabs: deps.registry.pinnedTabs,
      session,
      shell,
      getConfig: () => configRef.current,
      getLocale: () => localeRef.current,
      editFile: async (file) =>
        runOnTerminal(
          editorLaunch({
            env: deps.env,
            platform: deps.platform,
            file,
            which: deps.which,
          }),
        ),
      runInteractive: async (command, args) => runOnTerminal({ command, args }),
      ensureConfigFile: async () => deps.ensureConfigFile(deps.paths.config),
      reloadConfig: async () => {
        const next = await deps.loadConfig(deps.paths.config);
        configRef.current = next.config;
        localeRef.current = chooseLocale(next.config.locale, deps.env);
        setConfig(next.config);
        return next.problems;
      },
      reportFailure: (task) => {
        task.catch((error: unknown) =>
          session.notify(
            translatorFor(shellMessages, localeRef.current)("actionFailed", {
              error: errorText(error),
            }),
            "error",
          ),
        );
      },
      quit: deps.quit,
    });
  }, [deps, session, shell]);

  return (
    <ConfigContext value={config}>
      <LocaleContext value={locale}>
        <RegistryContext value={deps.registry}>
          <AppBody
            deps={deps}
            session={session}
            ctx={ctx}
            state={state}
            startupProblems={startupProblems}
            onStartupProblemsClosed={closeStartupProblems}
          />
        </RegistryContext>
      </LocaleContext>
    </ConfigContext>
  );
}
