/**
 * The plugin as a host uses it: one `AkhookSession` per session, one `lifecycleHooks` per host.
 *
 * Tool rules and the approval list are the session's tool middleware. Streaming rules need the
 * runner (to watch the generation) and the bus (to know when an attempt starts or a turn ends),
 * which a host only holds once the session is assembled: `attach` does that part. Lifecycle rules
 * belong to a run, not a session, so they are plain functions the host calls around a run.
 */
import type { Kernel, Runner, ToolMiddleware } from "@eta/core";
import type { AskRegistry } from "@eta/harness";
import type { StreamState, TriggerStore } from "./stream";
import type { ConfigInput } from "./types";
import process from "node:process";
import { kernelOn } from "@eta/core";
import { setValue, value } from "@eta/core/storage";
import { akhookMiddleware } from "./middleware";
import { RuleSource } from "./source";
import { StreamRules } from "./stream";

export interface AkhookSessionOptions {
  /** The session's working directory; `undefined` when its files are on another machine. */
  cwd: string | undefined;
  /** The session's ask channel. */
  ask: AskRegistry | undefined;
  /** Whether a tool is on the user's approval list, read at every call. */
  approvals?: ((name: string) => boolean | Promise<boolean>) | undefined;
  /** The user-level configuration file; defaults to akhook's. */
  userConfigPath?: string | undefined;
  /** The host's configuration: merged after the user and project ones. */
  additional?: (() => readonly ConfigInput[]) | undefined;
  /** Where the fired-rule record is kept; without it the record lasts as long as the session. */
  store?: TriggerStore | undefined;
  /** Where commands run when the session has no project directory. */
  fallbackRoot?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}

export class AkhookSession {
  readonly source: RuleSource;
  readonly streams: StreamRules;
  readonly middleware: ToolMiddleware;

  constructor(options: AkhookSessionOptions) {
    this.source = new RuleSource({
      cwd: options.cwd,
      fallbackRoot: options.fallbackRoot,
      userConfigPath: options.userConfigPath,
      additional: options.additional,
    });
    this.streams = new StreamRules({
      cwd: options.cwd ?? options.fallbackRoot ?? process.cwd(),
      store: options.store,
      warn: options.warn,
      // A configuration that is broken has no stream rules; the tool middleware is what reports it.
      rules: () => {
        try {
          return this.source.get().streamRules;
        } catch {
          return [];
        }
      },
    });
    this.middleware = akhookMiddleware({
      source: this.source,
      cwd: options.cwd,
      ask: options.ask,
      approvals: options.approvals,
      streams: this.streams,
    });
  }

  /**
   * Hook the streaming rules into an assembled session: the runner's generation guard, and the
   * bus events that move the buffers and the repeat counter. Returns the function that undoes it.
   */
  async attach(target: {
    runner: Runner;
    kernel: Kernel;
  }): Promise<() => void> {
    await this.streams.restore();
    const on = kernelOn(target.kernel.ctx);
    const offs = [
      target.runner.addGenerationGuard((frame) => this.streams.guard(frame)),
      on("message:start", () => {
        this.streams.attemptStart();
      }),
      on("turn:end", () => {
        this.streams.turnEnd();
      }),
      on("turn:run-end", () => {
        this.streams.runEnd();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }
}

/** What a run is, to the lifecycle rules (akhook's event fields, each when known). */
export interface LifecycleRun {
  /** The project directory; `undefined` when it is on another machine. */
  cwd: string | undefined;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  model?: string | undefined;
  /** Layers for this run alone, after the host's (the rules of the bundles its agent loads). */
  extra?: readonly ConfigInput[] | undefined;
}

export interface LifecycleHooksOptions {
  userConfigPath?: string | undefined;
  additional?: (() => readonly ConfigInput[]) | undefined;
  fallbackRoot?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}

/**
 * `prompt_submit` and `stop` rules around a run. Neither ever holds up the agent: a command that
 * fails, times out or says something invalid is reported through `warn` and adds nothing, and so
 * is a configuration that cannot be read.
 */
export function lifecycleHooks(options: LifecycleHooksOptions = {}) {
  const warn = options.warn ?? (() => undefined);
  const rulesFor = (run: LifecycleRun) =>
    new RuleSource({
      cwd: run.cwd,
      fallbackRoot: options.fallbackRoot,
      userConfigPath: options.userConfigPath,
      additional: () => [
        ...(options.additional?.() ?? []),
        ...(run.extra ?? []),
      ],
    }).get();
  const data = (run: LifecycleRun, extra: Record<string, unknown>) => ({
    cwd: run.cwd ?? options.fallbackRoot ?? process.cwd(),
    ...(run.sessionId === undefined ? {} : { session_id: run.sessionId }),
    ...(run.turnId === undefined ? {} : { turn_id: run.turnId }),
    ...(run.model === undefined ? {} : { model: run.model }),
    ...extra,
  });
  return {
    /** The context the `prompt_submit` rules add to this run, joined; `undefined` when none. */
    async beforeRun(
      run: LifecycleRun,
      prompt: string,
    ): Promise<string | undefined> {
      try {
        const rules = rulesFor(run);
        if (!rules.hasLifecycle("prompt_submit")) return undefined;
        const contexts = await rules.lifecycle(
          "prompt_submit",
          data(run, { prompt }),
          warn,
        );
        return contexts.length === 0 ? undefined : contexts.join("\n\n");
      } catch (error) {
        warn(
          `akhook: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    },
    /** Run the `stop` rules; their output is ignored. */
    async afterRun(
      run: LifecycleRun,
      lastAssistantMessage: string,
    ): Promise<void> {
      try {
        const rules = rulesFor(run);
        if (!rules.hasLifecycle("stop")) return;
        await rules.lifecycle(
          "stop",
          data(run, { last_assistant_message: lastAssistantMessage }),
          warn,
        );
      } catch (error) {
        warn(
          `akhook: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

/** The namespace the fired-rule record is stored in, in the session's value store. */
export const AKHOOK_STATE = "akhook.stream";

/**
 * A `TriggerStore` over a session's journal: read from storage, written through the journaling
 * service so it is ordered behind whatever the run already queued, like every other session value.
 */
export function journalTriggerStore(session: {
  log: {
    storage: {
      getValue: (address: never) => Promise<{ value: unknown } | undefined>;
    };
  };
  journaling: { writeValues: (writes: never[]) => Promise<void> };
}): TriggerStore {
  const address = value<StreamState>(AKHOOK_STATE, "state");
  return {
    load: async () =>
      (await session.log.storage.getValue(address as never))?.value as
        | StreamState
        | undefined,
    save: async (state) => {
      await session.journaling.writeValues([
        setValue(address, state),
      ] as never[]);
    },
  };
}
