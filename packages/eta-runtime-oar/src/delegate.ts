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
 *   over MCP (`serveMcpTools`) and run through the session's own middleware, so a tool's policy
 *   is the same whoever calls it. What the runtime reports of them is told back as the host's own
 *   (`HostCalls`): the tool's name, and the `details` an MCP answer has no room for.
 * - **Resume:** the runtime's session id is remembered on the eta session, so a restart picks up
 *   the same conversation instead of starting the runtime from nothing.
 * - **`/compact`** is the runtime's own (`Session.compact`), between turns only. It holds the
 *   runtime's input while it works, so a run that starts meanwhile waits for it. A session not
 *   open yet is opened just for that: its host tools need a run to serve them.
 */
import type {
  CompactionOutcome,
  Event,
  HostTool,
  HostToolContent,
  HostToolResult,
  InputImage,
  McpServer,
  ServedMcpTools,
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
import type { RuntimeCompaction } from "@eta/server";
import type { RuntimeCatalog, RuntimeId } from "./catalog";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveMcpTools } from "@botiverse/oar";
import { toToolResultMessage } from "@eta/core";
import { HOST_SERVER, HostCalls } from "./host-calls";
import { effortFor } from "./models";
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
  remember: (nativeSession: string) => void;
  /** The tools the host gave the session, by name: what is served to the runtime. */
  hostTools: () => readonly string[];
  /** MCP servers the runtime starts itself, beside the one serving the host's tools. */
  mcpServers?: readonly McpServer[] | undefined;
  /** Arguments for the runtime's process, on every open. */
  launchArgs?: readonly string[] | undefined;
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

/** A session tool's result as an MCP tool answer, and the details that answer cannot carry. */
function hostResultOf(
  name: string,
  raw: unknown,
): {
  result: Exclude<HostToolResult, string>;
  details: unknown;
} {
  const message = toToolResultMessage({ id: name, name }, raw);
  if (message.role !== "toolResult")
    return {
      result: { content: [{ type: "text", text: String(raw) }] },
      details: undefined,
    };
  const content: HostToolContent[] = message.content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image", data: block.data, mimeType: block.mimeType },
  );
  return {
    result: { content, isError: message.isError },
    details: message.details,
  };
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
  #served: ServedMcpTools | undefined;
  /** The names of the tools served: the only ones told back as the host's. */
  #hostTools: ReadonlySet<string> = new Set();
  /** The runtime session's running total charged to messages so far. */
  #charged: TokenTotals | undefined;
  /** The run in flight, for the tools the runtime calls back into. */
  #run: RunDelegateContext | undefined;
  /** The host tool calls of the run in flight. */
  #calls: HostCalls | undefined;
  /** What was taken for a turn and never reached the runtime: it opens the next prompt. */
  readonly #undelivered: Input[] = [];
  /** The compaction in flight; it never rejects. */
  #compacting: Promise<RuntimeCompaction> | undefined;
  /** Stops waiting for the compaction in flight. */
  #compactWait: AbortController | undefined;
  #disposed = false;

  constructor(options: OarDelegateOptions) {
    this.#options = options;
    this.#resume = options.resume;
  }

  async run(context: RunDelegateContext): Promise<DelegatedRunResult> {
    if (this.#disposed)
      return { status: "failed", error: "the session is closed" };
    this.#run = context;
    try {
      // A compaction holds the runtime's input: a prompt now would be refused.
      await until(this.#compacting, context.signal);
      if (context.signal.aborted) return { status: "aborted" };
      const settings = this.#settings(context.config());
      const opened = await this.#ensure(context, settings);
      this.#calls = new HostCalls(this.#options.runtime, this.#hostTools);
      const translator = new Translator(
        context,
        {
          provider: this.#options.runtime,
          model:
            settings.model ??
            opened.session.model().value ??
            this.#options.runtime,
        },
        this.#charged,
        this.#calls,
      );
      let input = joined([
        ...this.#undelivered.splice(0),
        inputOf(context.opening),
      ]);
      const agentPrompt = opened.prompted
        ? undefined
        : this.#options.agentPrompt();
      if (agentPrompt !== undefined) {
        input = {
          ...input,
          text: `<agent>\n${agentPrompt}\n</agent>\n\n${input.text}`,
        };
        opened.prompted = true;
      }
      for (;;) {
        const outcome = await this.#turn(
          opened.session,
          translator,
          input,
          context,
        );
        this.#charged = translator.charged;
        if (outcome.kind !== "completed") {
          return outcome.kind === "aborted"
            ? { status: "aborted" }
            : {
                status: "failed",
                error: failureOf(outcome) ?? "the turn failed",
              };
        }
        if (context.signal.aborted) return { status: "aborted" };
        // What arrived while the turn ran, and did not reach it, opens the next one.
        input = joined([
          ...this.#undelivered.splice(0),
          inputOf(context.take({ followUps: true })),
        ]);
        if (isEmpty(input)) return { status: "completed" };
      }
    } finally {
      this.#run = undefined;
      this.#calls = undefined;
    }
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
      session ??= await this.#openForCompaction(config);
      if (session.compact === undefined) return { outcome: "unsupported" };
      return compactionOf(
        await session.compact({ timeoutMs: COMPACT_WAIT_MS, signal }),
      );
    } catch (error) {
      // The conversation is gone: the next run starts a new one, and there is nothing to compact.
      if ((error as Error).name === "SessionNotFoundError")
        return { outcome: "empty" };
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
    return await catalog
      .runtime(id)
      .session(
        await catalog.installation(id),
        this.#sessionOptions(this.#settings(config), this.#resume, []),
      );
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#compactWait?.abort();
    await this.#compacting;
    const opened =
      this.#opened ?? (await this.#opening?.catch(() => undefined));
    this.#opened = undefined;
    await opened?.session.dispose().catch(() => undefined);
    await this.#served?.close().catch(() => undefined);
    this.#served = undefined;
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
    return { model, effort: effortFor(config.thinkingLevel, listed?.efforts) };
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
      this.#resume = current.session.id;
      await current.session.dispose().catch(() => undefined);
    }
    this.#opening = this.#open(context, settings);
    try {
      this.#opened = await this.#opening;
      return this.#opened;
    } finally {
      this.#opening = undefined;
    }
  }

  /** The agent's words as a system prompt, on a runtime that takes one. */
  #systemPrompt(): string | undefined {
    const { runtime, catalog, agentPrompt } = this.#options;
    return catalog.runtime(runtime).refusedSessionOptions
      ?.appendSystemPrompt === undefined
      ? agentPrompt()
      : undefined;
  }

  /** What a runtime session opens with. */
  #sessionOptions(
    { model, effort }: Settings,
    resume: string | undefined,
    mcpServers: readonly McpServer[],
  ): SessionOptions {
    const { launchArgs } = this.#options;
    const systemPrompt = this.#systemPrompt();
    return {
      cwd: this.#options.cwd,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(resume === undefined ? {} : { resume }),
      // Told on every open, resumed or not: a resumed conversation that was not told keeps the
      // prompt only until its next compaction (`resumedSessionOptions`), and then forgets it.
      ...(systemPrompt === undefined
        ? {}
        : { appendSystemPrompt: systemPrompt }),
      ...(mcpServers.length === 0 ? {} : { mcpServers }),
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
    const refused = runtime.refusedSessionOptions?.mcpServers !== undefined;
    const served = refused ? undefined : await this.#serve(context);
    const plugins = this.#options.mcpServers ?? [];
    if (refused && plugins.length > 0)
      this.#options.warn(
        `[eta-runtime-oar] ${id} takes no MCP servers; ${plugins.map((server) => server.name).join(", ")} left out`,
      );
    const mcpServers = refused
      ? []
      : [...(served === undefined ? [] : [served.server]), ...plugins];
    const options = (resume: string | undefined): SessionOptions =>
      this.#sessionOptions(settings, resume, mcpServers);
    let session: Session;
    try {
      session = await runtime.session(installation, options(this.#resume));
    } catch (error) {
      if (
        this.#resume === undefined ||
        (error as Error).name !== "SessionNotFoundError"
      )
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
    this.#options.remember(session.id);
    return {
      session,
      ...settings,
      // A resumed conversation already heard who it is.
      prompted: this.#systemPrompt() !== undefined || resumed,
    };
  }

  /** The host's tools, served once for the life of this delegate. */
  async #serve(
    context: RunDelegateContext,
  ): Promise<ServedMcpTools | undefined> {
    if (this.#served !== undefined) return this.#served;
    const names = new Set(this.#options.hostTools());
    const tools: HostTool[] = context
      .tools()
      .filter((tool) => names.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined
          ? {}
          : { description: tool.description }),
        inputSchema: ((tool as { parameters?: Record<string, unknown> })
          .parameters ?? {
          type: "object",
          properties: {},
        }) as Record<string, unknown>,
        handler: async (input) => {
          const run = this.#run;
          const calls = this.#calls;
          if (run === undefined || calls === undefined)
            return {
              content: [{ type: "text", text: "No run is in flight." }],
              isError: true,
            };
          const raw = await run.executeTool(tool.name, input, {
            toolCallId: `mcp-${crypto.randomUUID()}`,
          });
          const { result, details } = hostResultOf(tool.name, raw);
          calls.answered(tool.name, input, result.content, details);
          return result;
        },
      }));
    if (tools.length === 0) return undefined;
    this.#hostTools = new Set(tools.map((tool) => tool.name));
    this.#served = await serveMcpTools({ name: HOST_SERVER, tools });
    return this.#served;
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

  /** One prompt and the runtime's turn on it, told through the translator. */
  async #turn(
    session: Session,
    translator: Translator,
    input: Input,
    context: RunDelegateContext,
  ): Promise<TurnOutcome> {
    const prompt = await this.#deliverable(session, input);
    // The steers in flight, one after another; each ends when its fate is known.
    let steering: Promise<void> = Promise.resolve();
    const outcome = await new Promise<TurnOutcome>((resolve) => {
      let settled = false;
      const offs: (() => void)[] = [];
      /** Steers the runtime took, until a turn answers for them. */
      const accepted = new Map<string, Input>();
      let ended: TurnOutcome | undefined;
      const settle = (outcome: TurnOutcome): void => {
        if (settled) return;
        settled = true;
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
        session.rawEvents((record) => this.#calls?.see(record)),
        session.events((event: Event) => {
          if (settled) return;
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
            // The turn's usage rides in the same frame, right after its end.
            setTimeout(settle, 0, ended);
          } else if (event.kind === "exited") {
            this.#lost(session);
            settle({
              kind: "failed",
              failure: "runtime_exited",
              reason: `${this.#options.runtime} exited${event.code === null ? "" : ` with code ${event.code}`}${event.reason === undefined ? "" : `: ${event.reason}`}`,
            });
          } else if (event.kind === "input_dropped") {
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
        }),
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
        settle({ kind: "aborted" });
        return;
      }
      context.signal.addEventListener("abort", abort, { once: true });
      offs.push(() => context.signal.removeEventListener("abort", abort));
      void session
        .prompt(prompt.text, {
          inputId,
          ...(prompt.images.length === 0 ? {} : { images: prompt.images }),
        })
        .then(
          (result) => {
            if (result.kind === "rejected")
              settle({
                kind: "failed",
                failure: "invalid_request",
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
    return outcome;
  }

  /** The runtime process is gone: the next run opens it again, resuming the conversation. */
  #lost(session: Session): void {
    if (this.#opened?.session !== session) return;
    this.#opened = undefined;
    this.#resume = session.id;
    void session.dispose().catch(() => undefined);
  }
}
