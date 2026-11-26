/**
 * An eta session's runs, taken by an external runtime through oar.
 *
 * One delegate per eta session; one runtime session behind it, opened on the first run and kept.
 * A run hands the runtime the words that opened it, retells what the runtime does (`Translator`)
 * and ends when the runtime's turn ends. Then whatever arrived meanwhile is the next prompt of the
 * same run, as the runner's own loop would take a follow-up.
 *
 * - **The model and the effort** are read from the session's configuration at every run. A
 *   runtime takes them when its session opens, so a change closes the runtime session and resumes
 *   the same conversation under the new ones: the history stays, the model is new.
 * - **Steering** goes into the turn in flight where the runtime can take it (`Session.steer`);
 *   where it cannot, the words wait in the inbox for the turn to end and open the next prompt.
 *   A steer has already joined the transcript when it goes, so what the runtime turns down, or
 *   drops, is kept and opens the next prompt too (`#undelivered`), the next run's if this one ended.
 * - **The abort** interrupts the runtime's turn; the run ends with the turn's own end.
 * - **The host's tools** (a task board, a way to reach other agents) are served to the runtime
 *   over MCP (`HostTools` in `@eta/runtime-kit`), listed anew at every run, and run through the
 *   session's own middleware, so a tool's policy is the same whoever calls it. What the runtime reports of them is told back as the host's own
 *   (`HostCalls`): the tool's name, and the `details` an MCP answer has no room for.
 * - **Resume:** the runtime's session id is remembered on the eta session, so a restart picks up
 *   the same conversation instead of starting the runtime from nothing.
 * - **`/compact`** is the runtime's own (`Session.compact`), between turns only. It holds the
 *   runtime's input while it works, so a run that starts meanwhile waits for it. A session not
 *   open yet is opened just for that: its host tools need a run to serve them.
 * - **Release:** an idle runtime's process can be let go (`release`) and the conversation resumed at
 *   the next run, as a model change does. Not while anything is under way: a run, a compaction, a
 *   turn the runtime began itself, or a task it runs in the background, which would die with it.
 * - **A process that dies** is let go whenever it happens: in a turn the turn fails, between runs
 *   the next run opens it again, resuming the conversation.
 * - **A turn the runtime opens itself** (Claude Code answering a background task's
 *   notification, after the run that started the task ended) is a run too: the delegate watches
 *   the runtime between runs, and the first sign of such a turn asks the host for a run
 *   (`wake`). That run follows the turn from where it began, so its words reach the transcript
 *   and the host's tools have a run to serve them, as for a turn eta prompted.
 */
import type {
  AvailableInstallation,
  CompactionOutcome,
  Event,
  InputImage,
  McpServer,
  RefusedSessionOptions,
  Session,
  SessionOptions,
  TokenTotals,
  TurnOutcome,
} from "@botiverse/oar";
import type {
  AgentMessage,
  DelegatedRunResult,
  KernelConfig,
  RunDelegate,
  RunDelegateContext,
} from "@eta/core";
import type { HostToolServer, McpBridgeLauncher } from "@eta/runtime-kit";
import type { RuntimeCompaction } from "@eta/server";
import type { RuntimeCatalog, RuntimeId } from "./catalog";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedSessionCapabilities, ResumeCwdError } from "@botiverse/oar";
import {
  defaultMcpBridge,
  HOST_MCP_TOKEN_ENV,
  HOST_MCP_URL_ENV,
  HOST_SERVER,
  hostResultOf,
  HostTools,
  NO_RUN,
} from "@eta/runtime-kit";
import { HostCalls } from "./host-calls";
import { effortFor, listedEfforts } from "./models";
import { Translator } from "./translate";

export interface OarDelegateOptions {
  runtime: RuntimeId;
  catalog: RuntimeCatalog;
  /** The eta session, for where its images are written. */
  sessionId: string;
  cwd: string;
  /** The runtime session to pick up, from an earlier life of this one. */
  resume?: string | undefined;
  /**
   * What the agent and the app around it are, appended to the runtime's own system prompt. Read
   * when the runtime opens, after the session's tools exist.
   */
  agentPrompt: () => string | undefined;
  /** The runtime opened a session of its own: the eta session remembers it. */
  remember: (nativeSession: string) => void | Promise<void>;
  /** The tools the host gave the session, by name: what is served to the runtime. */
  hostTools: () => readonly string[];
  /** MCP servers the runtime starts itself, beside the one serving the host's tools. */
  mcpServers?: readonly McpServer[] | undefined;
  /** How a runtime that refuses credentials on `mcpServers` starts the stdio host MCP bridge. */
  mcpBridge?: McpBridgeLauncher | undefined;
  /** Arguments for the runtime's process, on every open. */
  launchArgs?: readonly string[] | undefined;
  /**
   * The runtime began a turn of its own and no run is following it: start a run (its opening may
   * be empty), now or once the run in flight ends. Without one, such a turn goes unheard.
   */
  wake?: ((wanted: () => boolean) => void) | undefined;
  warn: (message: string) => void;
}

/** What a runtime session is opened on. */
interface Settings {
  model: string | undefined;
  effort: string | undefined;
}

/** What the runtime session was opened with: a run on other settings reopens it. */
interface Opened extends Settings {
  session: Session;
  /** Whether the agent's words went in as a system prompt; if not, the first prompt carries them. */
  prompted: boolean;
}

/** The text and images of the messages that start a prompt. */
interface Input {
  text: string;
  images: { data: string; mimeType: string }[];
}

/**
 * The runtimes that keep a conversation's appended prompt across a resume, through compaction
 * too, and refuse it given again alone (Grok Build 1.0.89 through oar 0.128: "Omit
 * appendSystemPrompt to retain the saved append"). oar says so only when the session opens, not
 * in `resumedSessionOptions`, so it is named here. A resumed conversation keeps the words it
 * started with.
 */
const KEEPS_APPEND_ON_RESUME: ReadonlySet<RuntimeId> = new Set(["grok"]);

/** Whether an MCP server carries a credential, as oar reads one: a stdio env, http headers. */
function carriesCredentials(server: McpServer): boolean {
  const values = "type" in server ? server.headers : server.env;
  return values !== undefined && Object.keys(values).length > 0;
}

/** The bearer token from `serveMcpTools`'s Authorization header, if any. */
function bearerTokenOf(server: HostToolServer): string | undefined {
  const header = (
    server.headers?.Authorization ?? server.headers?.authorization
  )?.trim();
  if (header === undefined || !/^bearer\s/iu.test(header)) return undefined;
  const token = header.slice(6).trim();
  return token === "" ? undefined : token;
}

/** Whether a resume failure means the runtime does not recognize or list the session id. */
function isUnlistedResumeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "SessionNotFoundError") return true;
  return (
    (error instanceof ResumeCwdError || error.name === "ResumeCwdError") &&
    (error as { reason?: unknown }).reason === "not_listed"
  );
}

function inputOf(messages: readonly AgentMessage[]): Input {
  const texts: string[] = [];
  const images: Input["images"] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const words: string[] = [];
    for (const block of content) {
      if (block.type === "text") words.push(block.text);
      else if (block.type === "image")
        images.push({ data: block.data, mimeType: block.mimeType });
    }
    if (words.length > 0) texts.push(words.join(""));
  }
  return { text: texts.join("\n\n"), images };
}

/** Several inputs as one prompt. */
function joined(inputs: readonly Input[]): Input {
  return {
    text: inputs
      .map((input) => input.text)
      .filter((text) => text !== "")
      .join("\n\n"),
    images: inputs.flatMap((input) => input.images),
  };
}

const isEmpty = (input: Input): boolean =>
  input.text === "" && input.images.length === 0;

/** The facts that say the root agent is working: one seen between runs is a turn of its own. */
const TURN_SIGNS: ReadonlySet<Event["kind"]> = new Set([
  "turn_active",
  "reasoning",
  "text_delta",
  "tool_call_started",
]);

/** How a turn starts: eta prompts it, or the runtime began it at `seq` and the run follows it. */
type TurnStart = { prompt: Input } | { adopt: number };

/** The runtime's own id for the model the session is on; undefined means its default. */
export function modelFor(
  runtime: RuntimeId,
  config: KernelConfig,
): string | undefined {
  const { provider, modelId } = config.model;
  if (provider !== runtime || modelId === "" || modelId === "default")
    return undefined;
  return modelId;
}

function failureOf(outcome: TurnOutcome): string | undefined {
  return outcome.kind === "failed"
    ? `${outcome.failure}: ${outcome.reason}`
    : undefined;
}

/** What a runtime said of its compaction, in the words a client is told. */
function compactionOf(
  outcome: CompactionOutcome,
): Pick<RuntimeCompaction, "outcome" | "reason"> {
  switch (outcome.kind) {
    case "completed":
    case "aborted":
      return { outcome: outcome.kind };
    case "failed":
    case "unconfirmed":
      return { outcome: outcome.kind, reason: outcome.reason };
    case "rejected":
      if (outcome.code === "busy") return { outcome: "busy" };
      if (outcome.code === "aborted") return { outcome: "aborted" };
      return { outcome: "failed", reason: outcome.reason };
  }
}

/** How long a compaction is waited for, inside what a client waits for the answer. */
const COMPACT_WAIT_MS = 9 * 60 * 1000;

/** Waits for `work`, or until `signal` aborts. */
async function until(
  work: Promise<unknown> | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (work === undefined) return;
  await Promise.race([
    work,
    new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    ),
  ]);
}

export class OarDelegate implements RunDelegate {
  readonly #options: OarDelegateOptions;
  #opened: Opened | undefined;
  #opening: Promise<Opened> | undefined;
  #resume: string | undefined;
  /** The host's tools, served to the runtime; the ones served are the only ones told back as the host's. */
  readonly #host: HostTools;
  /** The runtime session's running total charged to messages so far. */
  #charged: TokenTotals | undefined;
  /** The run in flight, for the tools the runtime calls back into. */
  #run: RunDelegateContext | undefined;
  /** The host tool calls of the run in flight. */
  #calls: HostCalls | undefined;
  /** What was taken for a turn and never reached the runtime: it opens the next prompt. */
  readonly #undelivered: Input[] = [];
  /** Whether a turn of this delegate's is listening to the runtime: what it hears is that turn's. */
  #following = false;
  /** Where a turn the runtime began on its own starts in its stream, until a run follows it. */
  #adopted: number | undefined;
  /** Stops watching the runtime between runs. */
  #unwatch: (() => void) | undefined;
  /** The compaction in flight; it never rejects. */
  #compacting: Promise<RuntimeCompaction> | undefined;
  /** Stops waiting for the compaction in flight. */
  #compactWait: AbortController | undefined;
  #disposed = false;
  /** The runtime's tasks still running (a background shell, a subagent): they live in its process. */
  readonly #tasks = new Set<string>();
  /** The release in flight: an open waits for the old process to be gone. */
  #releasing: Promise<void> | undefined;
  /** When this session last did something: a run, a compaction, a runtime event. */
  #lastActive = Date.now();

  constructor(options: OarDelegateOptions) {
    this.#options = options;
    this.#resume = options.resume;
    this.#host = new HostTools({
      offered: options.hostTools,
      call: async (name, input) => {
        const run = this.#run;
        const calls = this.#calls;
        if (run === undefined || calls === undefined) return NO_RUN;
        const cleanInput = this.#cleanToolInput(run, name, input);
        const raw = await run.executeTool(name, cleanInput, {
          toolCallId: `mcp-${crypto.randomUUID()}`,
        });
        const { result, details } = hostResultOf(name, raw);
        calls.answered(name, cleanInput, result.content, details);
        return result;
      },
    });
  }

  async run(context: RunDelegateContext): Promise<DelegatedRunResult> {
    if (this.#disposed)
      return { status: "failed", error: "the session is closed" };
    this.#run = context;
    this.#lastActive = Date.now();
    try {
      // A compaction holds the runtime's input: a prompt now would be refused.
      await until(this.#compacting, context.signal);
      if (context.signal.aborted) return { status: "aborted" };
      const settings = this.#settings(context.config());
      let opened = await this.#ensure(context, settings);
      /** Whether the runtime's session was reopened for a prompt it no longer had a session for. */
      let reopened = false;
      // The effort the runtime session was opened with is what this run hands it.
      context.recordThinking(opened.effort);
      // The host's tools as they are now: a set that changed since the last run is served anew.
      await this.#host.refresh(context);
      const calls = new HostCalls(this.#options.runtime, this.#host.names);
      this.#calls = calls;
      const translatorFor = (session: Session) =>
        new Translator(
          context,
          {
            provider: this.#options.runtime,
            model:
              session.model().value ?? settings.model ?? this.#options.runtime,
          },
          this.#charged,
          calls,
        );
      let translator = translatorFor(opened.session);
      let input = joined([
        ...this.#undelivered.splice(0),
        inputOf(context.opening),
      ]);
      for (;;) {
        // A turn the runtime began itself comes first: a prompt now would find it busy.
        const adopted = this.#adopted;
        this.#adopted = undefined;
        let start: TurnStart;
        if (adopted !== undefined) start = { adopt: adopted };
        else if (isEmpty(input)) return { status: "completed" };
        else {
          start = { prompt: this.#introduced(opened, input) };
          input = { text: "", images: [] };
        }
        const turn = await this.#turn(
          opened.session,
          translator,
          start,
          context,
        );
        this.#charged = translator.charged;
        if (turn === "gone" && !reopened && !context.signal.aborted) {
          // The runtime lost the session under its process (Codex: `thread not found`) and the
          // prompt came back: resume the conversation in a new process and prompt it again.
          reopened = true;
          opened = await this.#ensure(context, settings);
          translator = translatorFor(opened.session);
          input = joined([...this.#undelivered.splice(0), input]);
          continue;
        }
        const outcome: TurnOutcome =
          turn === "gone"
            ? {
                kind: "failed",
                failure: "unknown",
                reason: `${this.#options.runtime} no longer has this session`,
              }
            : turn;
        if (outcome.kind !== "completed") {
          // What was not prompted yet waits for the next run.
          if (!isEmpty(input)) this.#undelivered.unshift(input);
          return outcome.kind === "aborted"
            ? { status: "aborted" }
            : {
                status: "failed",
                error: failureOf(outcome) ?? "the turn failed",
              };
        }
        if (context.signal.aborted) {
          if (!isEmpty(input)) this.#undelivered.unshift(input);
          return { status: "aborted" };
        }
        // What arrived while the turn ran, and did not reach it, opens the next one.
        input = joined([
          input,
          ...this.#undelivered.splice(0),
          inputOf(context.take({ followUps: true })),
        ]);
      }
    } finally {
      this.#run = undefined;
      this.#calls = undefined;
      this.#lastActive = Date.now();
      // A turn the runtime began as this run was ending gets a run of its own.
      if (this.#adopted !== undefined) this.#wake();
    }
  }

  /** Ask the host for a run to follow the turn the runtime began, while nothing has taken it. */
  #wake(): void {
    this.#options.wake?.(() => this.#adopted !== undefined && !this.#disposed);
  }

  /** The agent's words go with the first prompt a runtime that took no system prompt hears. */
  #introduced(opened: Opened, input: Input): Input {
    if (opened.prompted) return input;
    const agentPrompt = this.#options.agentPrompt();
    opened.prompted = true;
    if (agentPrompt === undefined) return input;
    return {
      ...input,
      text: `<agent>\n${agentPrompt}\n</agent>\n\n${input.text}`,
    };
  }

  /**
   * Between runs, the runtime is watched: the first sign of a root turn nobody prompted marks
   * where it began and asks for a run to follow it. A turn of this delegate's hears its own.
   */
  #watch(session: Session, emit: RunDelegateContext["emit"]): void {
    this.#unwatch?.();
    this.#tasks.clear();
    this.#unwatch = session.events((event: Event) => {
      if (this.#opened?.session !== session) return;
      this.#lastActive = Date.now();
      this.#track(event);
      if (event.kind === "exited") {
        // Between runs nobody else hears it: without this, every later run would prompt a dead one.
        if (!this.#following) this.#lost(session);
        return;
      }
      // A compaction is a turn of the runtime's too (`turn_active` for its request): not one to follow.
      if (
        this.#following ||
        this.#adopted !== undefined ||
        this.#compacting !== undefined
      )
        return;
      if (event.sessionId !== session.id || event.agentPath.length > 0) return;
      if (
        event.kind === "compaction_started" ||
        event.kind === "compaction_ended" ||
        event.kind === "model"
      ) {
        emit("context:invalidated", {
          reason: event.kind === "model" ? "model" : "compacted",
          at: event.receivedAt,
          nativeSessionId: session.id,
          ...(event.kind === "model" ? { model: event.model } : {}),
          ...(event.kind === "compaction_ended" && event.outcome === "completed"
            ? { compactedAt: event.receivedAt }
            : {}),
        });
      }
      if (!TURN_SIGNS.has(event.kind)) return;
      this.#adopted = event.seq;
      this.#wake();
    });
  }

  /** Which of the runtime's tasks are running: a release would end them. */
  #track(event: Event): void {
    if (event.kind === "task_started") this.#tasks.add(event.taskId);
    else if (event.kind === "task_ended") this.#tasks.delete(event.taskId);
    else if (
      event.kind === "task_updated" &&
      event.status !== undefined &&
      event.status !== "running" &&
      event.status !== "pending" &&
      event.status !== "paused"
    )
      this.#tasks.delete(event.taskId);
  }

  /** Whether a runtime process is up for this session, and when the session last did anything. */
  residency(): { resident: boolean; lastActive: number } {
    return {
      resident: this.#opened !== undefined || this.#opening !== undefined,
      lastActive: this.#lastActive,
    };
  }

  /**
   * Let the runtime's process go while nothing is under way, keeping the conversation: the next
   * run resumes it, as after a restart. Answers whether it was let go.
   */
  async release(): Promise<boolean> {
    const opened = this.#opened;
    if (
      opened === undefined ||
      this.#disposed ||
      this.#opening !== undefined ||
      this.#releasing !== undefined ||
      this.#run !== undefined ||
      this.#compacting !== undefined ||
      this.#following ||
      this.#adopted !== undefined ||
      this.#tasks.size > 0 ||
      opened.session.status().value.kind !== "idle"
    )
      return false;
    this.#opened = undefined;
    this.#unwatch?.();
    this.#unwatch = undefined;
    this.#resume = opened.session.id;
    this.#releasing = opened.session
      .dispose()
      .catch(() => undefined)
      .finally(() => {
        this.#releasing = undefined;
      });
    await this.#releasing;
    return true;
  }

  /**
   * Compact the runtime's context, between turns. Answers what became of it, whatever that was:
   * the runtime's own report, or why it was not asked.
   */
  async compact(config: KernelConfig): Promise<RuntimeCompaction> {
    const { runtime: id, catalog } = this.#options;
    const report = (
      result: Pick<RuntimeCompaction, "outcome" | "reason">,
    ): RuntimeCompaction => ({ runtime: catalog.label(id), ...result });
    const declared = catalog.runtime(id).manualCompaction;
    const opened = this.#opened;
    if (
      declared?.kind === "unsupported" ||
      (opened !== undefined && opened.session.compact === undefined)
    )
      return report({ outcome: "unsupported" });
    if (this.#run !== undefined) return report({ outcome: "busy" });
    if (this.#compacting !== undefined) return await this.#compacting;
    if (this.#disposed)
      return report({ outcome: "failed", reason: "the session is closed" });
    // Nothing has run here yet, and nothing is there to resume.
    if (opened === undefined && this.#resume === undefined)
      return report({
        outcome: declared?.kind === "supported" ? "empty" : "unsupported",
      });
    const wait = new AbortController();
    this.#compactWait = wait;
    this.#compacting = this.#compact(config, opened, wait.signal)
      .then(report)
      .finally(() => {
        this.#lastActive = Date.now();
        this.#compacting = undefined;
        this.#compactWait = undefined;
      });
    return await this.#compacting;
  }

  async #compact(
    config: KernelConfig,
    opened: Opened | undefined,
    signal: AbortSignal,
  ): Promise<Pick<RuntimeCompaction, "outcome" | "reason">> {
    let session = opened?.session;
    try {
      await this.#releasing;
      session ??= await this.#openForCompaction(config);
      if (session.compact === undefined) return { outcome: "unsupported" };
      return compactionOf(
        await session.compact({ timeoutMs: COMPACT_WAIT_MS, signal }),
      );
    } catch (error) {
      // The conversation is gone: the next run starts a new one, and there is nothing to compact.
      if (isUnlistedResumeError(error)) return { outcome: "empty" };
      return {
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (opened === undefined) await session?.dispose().catch(() => undefined);
    }
  }

  /** The conversation on this delegate's runtime, for a compaction and nothing after it. */
  async #openForCompaction(config: KernelConfig): Promise<Session> {
    const { runtime: id, catalog } = this.#options;
    const installation = await catalog.installation(id);
    return await catalog
      .runtime(id)
      .session(
        installation,
        this.#sessionOptions(
          this.#settings(config),
          this.#resume,
          [],
          this.#refused(installation),
        ),
      );
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#compactWait?.abort();
    await this.#compacting;
    await this.#releasing;
    const opened =
      this.#opened ?? (await this.#opening?.catch(() => undefined));
    this.#opened = undefined;
    this.#unwatch?.();
    this.#unwatch = undefined;
    this.#adopted = undefined;
    await opened?.session.dispose().catch(() => undefined);
    await this.#host.close();
    await rm(this.#imageDir(), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  /** The model and effort a run on this configuration takes. */
  #settings(config: KernelConfig): Settings {
    const { runtime, catalog } = this.#options;
    const model = modelFor(runtime, config);
    const listed = catalog
      .peek(runtime)
      ?.models.find((entry) => entry.id === model);
    return {
      model,
      effort: effortFor(config.thinkingLevel, listedEfforts(listed)),
    };
  }

  /** The runtime session for these settings: the open one, or one (re)opened for them. */
  async #ensure(
    context: RunDelegateContext,
    settings: Settings,
  ): Promise<Opened> {
    const current = this.#opened;
    if (
      current !== undefined &&
      current.model === settings.model &&
      current.effort === settings.effort
    )
      return current;
    if (current !== undefined) {
      // Other settings: let this one go and resume its conversation under the new ones.
      this.#opened = undefined;
      this.#unwatch?.();
      this.#unwatch = undefined;
      this.#adopted = undefined;
      this.#resume = current.session.id;
      await current.session.dispose().catch(() => undefined);
    }
    // A process being let go still holds the conversation: the next one waits for it to be gone.
    await this.#releasing;
    if (this.#opened !== undefined)
      return await this.#ensure(context, settings);
    this.#opening = this.#open(context, settings);
    try {
      this.#opened = await this.#opening;
      this.#watch(this.#opened.session, context.emit);
      return this.#opened;
    } finally {
      this.#opening = undefined;
    }
  }

  /**
   * The options this installation of the runtime refuses: what every version refuses, and what
   * this version does (OpenCode v2 takes an appended prompt only from a given release on).
   */
  #refused(installation: AvailableInstallation): RefusedSessionOptions {
    const { runtime, catalog } = this.#options;
    return (
      installedSessionCapabilities(catalog.runtime(runtime), installation)
        .refusedSessionOptions ?? {}
    );
  }

  /** The agent's words as a system prompt, on a runtime that takes one. */
  #systemPrompt(refused: RefusedSessionOptions): string | undefined {
    return refused.appendSystemPrompt === undefined
      ? this.#options.agentPrompt()
      : undefined;
  }

  /**
   * Antigravity adds `toolSummary` to every session MCP call; strip it when the host tool's
   * parameter schema does not declare it so strict (`additionalProperties: false`) validators
   * accept the call.
   */
  #cleanToolInput(
    run: RunDelegateContext,
    name: string,
    input: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    if (this.#options.runtime !== "antigravity" || !("toolSummary" in input))
      return input;
    const tool = run.tools().find((entry) => entry.name === name);
    const properties = (
      tool as
        | { parameters?: { properties?: Record<string, unknown> } }
        | undefined
    )?.parameters?.properties;
    if (properties !== undefined && "toolSummary" in properties) return input;
    const copy: Record<string, unknown> = { ...input };
    delete copy.toolSummary;
    return copy;
  }

  /** What a runtime session opens with. */
  #sessionOptions(
    { model, effort }: Settings,
    resume: string | undefined,
    mcpServers: readonly McpServer[],
    refused: RefusedSessionOptions,
    env?: Readonly<Record<string, string>>,
  ): SessionOptions {
    const { launchArgs } = this.#options;
    const systemPrompt =
      resume !== undefined && KEEPS_APPEND_ON_RESUME.has(this.#options.runtime)
        ? undefined
        : this.#systemPrompt(refused);
    return {
      cwd: this.#options.cwd,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(resume === undefined ? {} : { resume }),
      // Told on every open, resumed or not: a resumed conversation that was not told keeps the
      // prompt only until its next compaction (`resumedSessionOptions`), and then forgets it.
      // Not on a runtime that keeps it itself and refuses it again (`KEEPS_APPEND_ON_RESUME`).
      ...(systemPrompt === undefined
        ? {}
        : { appendSystemPrompt: systemPrompt }),
      ...(mcpServers.length === 0 ? {} : { mcpServers }),
      ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
      ...(launchArgs === undefined || launchArgs.length === 0
        ? {}
        : { launchArgs }),
    };
  }

  async #open(
    context: RunDelegateContext,
    settings: Settings,
  ): Promise<Opened> {
    const { runtime: id, catalog } = this.#options;
    const runtime = catalog.runtime(id);
    const installation = await catalog.installation(id);
    const refusals = this.#refused(installation);
    // A runtime that refuses credentials on `mcpServers` (Antigravity keeps an entry's env and
    // headers in plain text in its conversation database) gets a credential-free stdio MCP bridge
    // for the host's tools, with the ephemeral URL + bearer token passed in `SessionOptions.env`.
    const noServers = refusals.mcpServers !== undefined;
    const noCredentials = refusals.mcpServerCredentials !== undefined;
    let hostServer: McpServer | undefined;
    let env: Readonly<Record<string, string>> | undefined;
    if (!noServers) {
      if (!noCredentials) {
        hostServer = await this.#host.serve(context);
      } else if (refusals.env === undefined) {
        const served = await this.#host.serve(context);
        if (served !== undefined) {
          const token = bearerTokenOf(served);
          if (token !== undefined) {
            const launcher = this.#options.mcpBridge ?? defaultMcpBridge();
            hostServer = {
              name: HOST_SERVER,
              command: launcher.command,
              ...(launcher.args === undefined || launcher.args.length === 0
                ? {}
                : { args: [...launcher.args] }),
            };
            env = {
              [HOST_MCP_URL_ENV]: served.url,
              [HOST_MCP_TOKEN_ENV]: token,
            };
          } else {
            hostServer = served;
          }
        }
      } else {
        this.#options.warn(
          `[eta-runtime-oar] ${id} refuses MCP credentials and SessionOptions.env; host tools left out`,
        );
      }
    }
    const plugins = this.#options.mcpServers ?? [];
    const taken = noServers
      ? []
      : noCredentials
        ? plugins.filter((server) => !carriesCredentials(server))
        : plugins;
    const left = plugins.filter((server) => !taken.includes(server));
    if (left.length > 0)
      this.#options.warn(
        `[eta-runtime-oar] ${id} takes no MCP servers${noServers ? "" : " that carry credentials"}; ${left.map((server) => server.name).join(", ")} left out`,
      );
    const mcpServers = [
      ...(hostServer === undefined ? [] : [hostServer]),
      ...taken,
    ];
    const options = (resume: string | undefined): SessionOptions =>
      this.#sessionOptions(settings, resume, mcpServers, refusals, env);
    let session: Session;
    try {
      session = await runtime.session(installation, options(this.#resume));
    } catch (error) {
      if (this.#resume === undefined || !isUnlistedResumeError(error))
        throw error;
      this.#options.warn(
        `[eta-runtime-oar] ${id} session ${this.#resume} is gone; starting a new one`,
      );
      this.#resume = undefined;
      session = await runtime.session(installation, options(undefined));
    }
    const resumed = this.#resume !== undefined;
    this.#resume = session.id;
    // A new runtime session counts its usage from zero.
    this.#charged = undefined;
    await this.#options.remember(session.id);
    return {
      session,
      ...settings,
      // A resumed conversation already heard who it is.
      prompted: this.#systemPrompt(refusals) !== undefined || resumed,
    };
  }

  #imageDir(): string {
    return join(tmpdir(), "eta-runtime-oar", this.#options.sessionId);
  }

  /** Images go to a runtime as files on its machine. */
  async #images(images: Input["images"]): Promise<InputImage[]> {
    if (images.length === 0) return [];
    const dir = this.#imageDir();
    await mkdir(dir, { recursive: true });
    return await Promise.all(
      images.map(async (image) => {
        const extension = image.mimeType.split("/")[1] ?? "png";
        // Unique, not by the clock: a prompt and a steer can write theirs in the same instant.
        const path = join(dir, `${crypto.randomUUID()}.${extension}`);
        await writeFile(path, Buffer.from(image.data, "base64"));
        return { path, mediaType: image.mimeType };
      }),
    );
  }

  /**
   * An input as this runtime takes it: its images as its own image input, or, where it has none,
   * named by path, since they are files on its machine and it can read those.
   */
  async #deliverable(
    session: Session,
    input: Input,
  ): Promise<{ text: string; images: InputImage[] }> {
    const images = await this.#images(input.images);
    if (images.length === 0 || session.capabilities.images)
      return { text: input.text, images };
    const named = images.map((image) => `[image: ${image.path}]`).join("\n");
    return {
      text: input.text === "" ? named : `${input.text}\n\n${named}`,
      images: [],
    };
  }

  /**
   * One runtime turn, told through the translator: one eta prompts, or one the runtime began
   * itself, heard again from where it began.
   */
  async #turn(
    session: Session,
    translator: Translator,
    start: TurnStart,
    context: RunDelegateContext,
  ): Promise<TurnOutcome | "gone"> {
    const model = session.model().value;
    if (model !== null)
      context.emit("context:invalidated", {
        reason: "model",
        model,
        nativeSessionId: session.id,
        runId: context.runId,
        at: Date.now(),
      });
    const prompt =
      "prompt" in start
        ? await this.#deliverable(session, start.prompt)
        : undefined;
    // The steers in flight, one after another; each ends when its fate is known.
    let steering: Promise<void> = Promise.resolve();
    /** The runtime no longer has the session: the prompt was handed back. */
    let gone = false;
    this.#following = true;
    const outcome = await new Promise<TurnOutcome>((resolve) => {
      let settled = false;
      const offs: (() => void)[] = [];
      /** Steers the runtime took, until a turn answers for them. */
      const accepted = new Map<string, Input>();
      let ended: TurnOutcome | undefined;
      /** The seq of the turn's end: only what rides with it (its usage) is still this turn's. */
      let endedAt: number | undefined;
      let span: string | undefined;
      let sequence = -1;
      const settle = (outcome: TurnOutcome): void => {
        if (settled) return;
        settled = true;
        this.#following = false;
        for (const off of offs) off();
        // Taken and never answered: the runtime is gone, or the turn was cut short.
        this.#undelivered.push(...accepted.values());
        translator.finish(
          outcome.kind === "completed" ? "completed" : outcome.kind,
          failureOf(outcome),
        );
        resolve(outcome);
      };
      const inputId = crypto.randomUUID();
      offs.push(
        // Observers hear a record in the order they came, and a call's name can be in its frame.
        session.rawEvents((record) => {
          this.#calls?.see(record);
          if (
            !settled &&
            endedAt === undefined &&
            record.sessionId === session.id
          )
            translator.seeRaw(record);
        }),
        session.events(
          (event: Event) => {
            if (settled) return;
            // Once the turn has ended, what follows is the runtime's next turn, the watcher's to hear.
            if (endedAt !== undefined && event.seq !== endedAt) return;
            if (event.agentPath.length === 0) {
              if (event.sessionId !== session.id || event.seq < sequence)
                return;
              sequence = event.seq;
              if (event.kind === "turn_active") span = event.spanId;
              // Codex names the native turn. Context cannot be attributed to an earlier span.
              if (
                (event.kind === "usage" ||
                  event.kind === "model" ||
                  event.kind === "compaction_started" ||
                  event.kind === "compaction_ended") &&
                event.spanId !== undefined &&
                event.spanId !== span &&
                (span !== undefined || this.#options.runtime === "codex")
              )
                return;
            }
            translator.see(event);
            if (event.agentPath.length > 0) return;
            if (event.kind === "turn_ended") {
              // A runtime that names the inputs of a turn can show a steer it took too late for
              // this one (claude reads them from its stdin): that opens a turn of its own, and
              // the run lasts until that one ends.
              if (event.inputIds === undefined) accepted.clear();
              for (const id of event.inputIds ?? []) accepted.delete(id);
              ended = event.outcome;
              if (accepted.size > 0 && ended.kind === "completed") return;
              endedAt = event.seq;
              this.#following = false;
              // The turn's usage rides in the same frame, right after its end.
              setTimeout(settle, 0, ended);
            } else if (event.kind === "exited") {
              this.#lost(session);
              settle({
                kind: "failed",
                failure: "runtime_exited",
                reason: `${this.#options.runtime} exited${event.code === null ? "" : ` with code ${event.code}`}${event.reason === undefined ? "" : `: ${event.reason}`}`,
              });
            } else if (event.kind === "input_handled") {
              // The runtime handled the prompt itself (a Pi extension's input handler) and began
              // no turn for it: there is no end to wait for. A run it started is a turn of its own.
              if (event.inputId === inputId)
                setTimeout(settle, 0, { kind: "completed" });
            } else if (event.kind === "input_dropped") {
              // Every input here is given an id; one named only by its request is someone else's.
              if (event.inputId === undefined) return;
              const dropped = accepted.get(event.inputId);
              if (dropped !== undefined) {
                // It comes back to us, and may have been all a finished turn was waiting for.
                accepted.delete(event.inputId);
                this.#undelivered.push(dropped);
                if (ended !== undefined && accepted.size === 0)
                  setTimeout(settle, 0, ended);
              } else if (
                event.inputId === inputId &&
                event.reason === "runtime_refused"
              ) {
                settle({
                  kind: "failed",
                  failure: event.failure ?? "invalid_request",
                  reason: event.message ?? "the runtime refused the prompt",
                });
              }
            }
          },
          // A turn the runtime began itself is heard from its first sign, which came before this.
          "adopt" in start
            ? { cursor: { sessionId: session.id, afterSeq: start.adopt - 1 } }
            : undefined,
        ),
      );
      /** Into the turn, or kept for the next prompt: never neither. */
      const deliver = async (
        steer: NonNullable<Session["steer"]>,
        steered: Input,
      ): Promise<void> => {
        const kept = (why: string): void => {
          this.#options.warn(
            `[eta-runtime-oar] a steer did not land, the next prompt carries it: ${why}`,
          );
          this.#undelivered.push(steered);
        };
        // One came back, so the turn is ending: the rest keep their order behind it.
        if (this.#undelivered.length > 0) return kept("a steer before it did");
        try {
          const { text, images } = await this.#deliverable(session, steered);
          const id = crypto.randomUUID();
          const result = await steer(text, {
            inputId: id,
            ...(images.length === 0 ? {} : { images }),
          });
          if (result.kind === "rejected") kept(result.reason);
          else if (!settled) accepted.set(id, steered);
        } catch (error) {
          kept(error instanceof Error ? error.message : String(error));
        }
      };
      // Steering: into the turn where the runtime takes it; otherwise it waits for the turn's end.
      if (session.steer !== undefined) {
        const steer = session.steer.bind(session);
        offs.push(
          context.onInput(() => {
            const steered = inputOf(context.take({ followUps: false }));
            if (isEmpty(steered)) return;
            steering = steering.then(() => deliver(steer, steered));
          }),
        );
      }
      const abort = (): void => {
        void session.abort().then((result) => {
          // Nothing was running to interrupt: the turn is over as far as this run goes.
          if (result.kind === "rejected") settle({ kind: "aborted" });
        });
      };
      if (context.signal.aborted) {
        if (prompt === undefined) abort();
        else settle({ kind: "aborted" });
        return;
      }
      context.signal.addEventListener("abort", abort, { once: true });
      offs.push(() => context.signal.removeEventListener("abort", abort));
      // A turn the runtime began is already under way: there is nothing to prompt.
      if (prompt === undefined || "adopt" in start) return;
      const input = start.prompt;
      void session
        .prompt(prompt.text, {
          inputId,
          ...(prompt.images.length === 0 ? {} : { images: prompt.images }),
        })
        .then(
          (result) => {
            if (result.kind !== "rejected") return;
            // The runtime began a turn of its own just now: this one follows that turn, and the
            // prompt waits for its end.
            if (
              result.code === "busy" &&
              session.status().value.kind === "running"
            ) {
              this.#undelivered.unshift(input);
              return;
            }
            if (result.code === "session_not_found") {
              gone = true;
              this.#undelivered.unshift(input);
              this.#lost(session);
              settle({
                kind: "failed",
                failure: "unknown",
                reason: result.reason,
              });
              return;
            }
            settle({
              kind: "failed",
              failure: result.failure ?? "invalid_request",
              reason: `${result.code}: ${result.reason}`,
            });
          },
          (error: unknown) =>
            settle({
              kind: "failed",
              failure: "unknown",
              reason: error instanceof Error ? error.message : String(error),
            }),
        );
    });
    // A steer still on its way may yet come back: the caller reads what did.
    await steering;
    return gone ? "gone" : outcome;
  }

  /** The runtime process is gone: the next run opens it again, resuming the conversation. */
  #lost(session: Session): void {
    if (this.#opened?.session !== session) return;
    this.#opened = undefined;
    this.#resume = session.id;
    this.#tasks.clear();
    this.#unwatch?.();
    this.#unwatch = undefined;
    void session.dispose().catch(() => undefined);
  }
}
