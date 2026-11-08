/**
 * Renders the whole interface against test doubles: a hand-driven controller, a fake wire,
 * in-memory settings and state, and a process runner that records what it was asked to start.
 */
import type {
  ConfigProblem,
  LoadedConfig,
  SaveProblem,
  TuiConfig,
  TuiState,
} from "../../src/config/types";
import type {
  ConnectionPhase,
  ConnectionState,
} from "../../src/connection/types";
import type { Extension } from "../../src/extensions/types";
import type { ProcessLaunch } from "../../src/ui/editor";
import type { Rendered } from "./render";
import { extensions as realExtensions } from "../../src/extensions.gen";
import { createRegistry } from "../../src/extensions/registry";
import { App } from "../../src/ui/app";
import { loaded, testConfig } from "./config";
import { FakeController } from "./fake-controller";
import { fakeWire } from "./fake-wire";
import { flush, renderInk } from "./render";

export const TEST_PATHS = {
  config: "/test/eta/tui.json",
  state: "/test/eta/tui-state.json",
};

export const TEST_URL = "http://127.0.0.1:9999";

export interface AppOptions {
  phase?: ConnectionPhase;
  patch?: Partial<ConnectionState>;
  config?: TuiConfig;
  problems?: ConfigProblem[];
  state?: TuiState;
  /** Added to the real extensions under `src/ext/`. */
  extensions?: Extension[];
  ops?: string[];
  columns?: number;
  rows?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  loadConfig?: (file: string) => Promise<LoadedConfig>;
  ensureConfigFile?: (file: string) => Promise<SaveProblem | undefined>;
  saveState?: (
    file: string,
    state: TuiState,
  ) => Promise<SaveProblem | undefined>;
  runProcess?: (launch: ProcessLaunch) => Promise<number | null>;
  which?: (command: string) => string | null;
  tuiVersion?: string;
}

export interface RenderedApp extends Rendered {
  controller: FakeController;
  saved: TuiState[];
  launches: ProcessLaunch[];
  ensured: string[];
  quits: () => number;
}

export async function renderApp(
  options: AppOptions = {},
): Promise<RenderedApp> {
  const controller = new FakeController(
    options.phase ?? { name: "connected", url: TEST_URL, temporary: false },
    { wire: fakeWire({ ops: options.ops ?? [] }), ...options.patch },
  );
  const config = options.config ?? testConfig();
  const saved: TuiState[] = [];
  const launches: ProcessLaunch[] = [];
  const ensured: string[] = [];
  let quitCount = 0;
  const rendered = renderInk(
    <App
      deps={{
        controller,
        registry: createRegistry([
          ...realExtensions,
          ...(options.extensions ?? []),
        ]),
        paths: TEST_PATHS,
        initialConfig: loaded(config, options.problems),
        initialState: options.state ?? { tabs: [], activeTab: undefined },
        env: options.env ?? {},
        platform: options.platform ?? "linux",
        tuiVersion: options.tuiVersion ?? "dev",
        loadConfig: options.loadConfig ?? (async () => loaded(config)),
        ensureConfigFile:
          options.ensureConfigFile ??
          (async (file) => {
            ensured.push(file);
            return undefined;
          }),
        saveState:
          options.saveState ??
          (async (_file, state) => {
            saved.push(structuredClone(state));
            return undefined;
          }),
        runProcess: async (launch) => {
          launches.push(launch);
          return options.runProcess ? options.runProcess(launch) : 0;
        },
        which: options.which ?? (() => null),
        quit: async () => {
          quitCount += 1;
        },
      }}
    />,
    { columns: options.columns, rows: options.rows },
  );
  await flush();
  return {
    ...rendered,
    controller,
    saved,
    launches,
    ensured,
    quits: () => quitCount,
  };
}
