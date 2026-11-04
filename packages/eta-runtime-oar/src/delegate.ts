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
 * - **The abort** interrupts the runtime's turn; the run ends with the turn's own end.
 * - **The host's tools** (a task board, a way to reach other agents) are served to the runtime
 *   over MCP (`serveMcpTools`) and run through the session's own middleware, so a tool's policy
 *   is the same whoever calls it.
 * - **Resume:** the runtime's session id is remembered on the eta session, so a restart picks up
 *   the same conversation instead of starting the runtime from nothing.
 */
import type {
  Event,
  HostTool,
  HostToolContent,
  HostToolResult,
  InputImage,
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
import type { RuntimeCatalog, RuntimeId } from "./catalog";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveMcpTools } from "@botiverse/oar";
import { toToolResultMessage } from "@eta/core";
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
  warn: (message: string) => void;
}

/** What the runtime session was opened with: a run on other settings reopens it. */
interface Opened {
  session: Session;
  model: string | undefined;
  effort: string | undefined;
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

/** A session tool's result as an MCP tool answer. */
function hostResultOf(name: string, raw: unknown): HostToolResult {
  const message = toToolResultMessage({ id: name, name }, raw);
  if (message.role !== "toolResult") return String(raw);
  const content: HostToolContent[] = message.content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image", data: block.data, mimeType: block.mimeType },
  );
  return { content, isError: message.isError };
}

export class OarDelegate implements RunDelegate {
  readonly #options: OarDelegateOptions;
  #opened: Opened | undefined;
  #opening: Promise<Opened> | undefined;
  #resume: string | undefined;
  #served: ServedMcpTools | undefined;
  /** The runtime session's running total charged to messages so far. */
  #charged: TokenTotals | undefined;
  /** The run in flight, for the tools the runtime calls back into. */
  #run: RunDelegateContext | undefined;
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
      const config = context.config();
      const model = modelFor(this.#options.runtime, config);
      const listed = this.#options.catalog
        .peek(this.#options.runtime)
        ?.models.find((entry) => entry.id === model);
      const effort = effortFor(config.thinkingLevel, listed?.efforts);
      const opened = await this.#ensure(context, model, effort);
      const translator = new Translator(
        context,
        {
          provider: this.#options.runtime,
          model: model ?? opened.session.model().value ?? this.#options.runtime,
        },
        this.#charged,
      );
      let input = inputOf(context.opening);
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
        // What arrived while the turn ran, and could not be steered into it, opens the next one.
        const next = context.take({ followUps: true });
        if (next.length === 0) return { status: "completed" };
        input = inputOf(next);
      }
    } finally {
      this.#run = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
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

  /** The runtime session for these settings: the open one, or one (re)opened for them. */
  async #ensure(
    context: RunDelegateContext,
    model: string | undefined,
    effort: string | undefined,
  ): Promise<Opened> {
    const current = this.#opened;
    if (
      current !== undefined &&
      current.model === model &&
      current.effort === effort
    )
      return current;
    if (current !== undefined) {
      // Other settings: let this one go and resume its conversation under the new ones.
      this.#opened = undefined;
      this.#resume = current.session.id;
      await current.session.dispose().catch(() => undefined);
    }
    this.#opening = this.#open(context, model, effort);
    try {
      this.#opened = await this.#opening;
      return this.#opened;
    } finally {
      this.#opening = undefined;
    }
  }

  async #open(
    context: RunDelegateContext,
    model: string | undefined,
    effort: string | undefined,
  ): Promise<Opened> {
    const { runtime: id, catalog, cwd } = this.#options;
    const runtime = catalog.runtime(id);
    const installation = await catalog.installation(id);
    const refused = runtime.refusedSessionOptions ?? {};
    const served =
      refused.mcpServers === undefined ? await this.#serve(context) : undefined;
    const agentPrompt = this.#options.agentPrompt();
    const appends =
      agentPrompt !== undefined && refused.appendSystemPrompt === undefined;
    const options = (resume: string | undefined): SessionOptions => ({
      cwd,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(resume === undefined ? {} : { resume }),
      // A resumed conversation keeps the prompt it was opened with (claude refuses a new one
      // on resume), so only a new one is told.
      ...(appends && resume === undefined
        ? { appendSystemPrompt: agentPrompt }
        : {}),
      ...(served === undefined ? {} : { mcpServers: [served.server] }),
    });
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
      model,
      effort,
      // A resumed conversation already heard who it is.
      prompted: appends || resumed,
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
          if (run === undefined)
            return {
              content: [{ type: "text", text: "No run is in flight." }],
              isError: true,
            };
          const raw = await run.executeTool(tool.name, input, {
            toolCallId: `mcp-${crypto.randomUUID()}`,
          });
          return hostResultOf(tool.name, raw);
        },
      }));
    if (tools.length === 0) return undefined;
    this.#served = await serveMcpTools({ name: "eta", tools });
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
      images.map(async (image, index) => {
        const extension = image.mimeType.split("/")[1] ?? "png";
        const path = join(
          dir,
          `${Date.now().toString(36)}-${index}.${extension}`,
        );
        await writeFile(path, Buffer.from(image.data, "base64"));
        return { path, mediaType: image.mimeType };
      }),
    );
  }

  /** One prompt and the runtime's turn on it, told through the translator. */
  async #turn(
    session: Session,
    translator: Translator,
    input: Input,
    context: RunDelegateContext,
  ): Promise<TurnOutcome> {
    const images = await this.#images(input.images);
    return await new Promise<TurnOutcome>((resolve) => {
      let settled = false;
      const offs: (() => void)[] = [];
      const settle = (outcome: TurnOutcome): void => {
        if (settled) return;
        settled = true;
        for (const off of offs) off();
        translator.finish(
          outcome.kind === "completed" ? "completed" : outcome.kind,
          failureOf(outcome),
        );
        resolve(outcome);
      };
      const inputId = crypto.randomUUID();
      offs.push(
        session.events((event: Event) => {
          if (settled) return;
          translator.see(event);
          if (event.agentPath.length > 0) return;
          if (event.kind === "turn_ended") {
            // The turn's usage rides in the same frame, right after its end.
            const outcome = event.outcome;
            setTimeout(settle, 0, outcome);
          } else if (event.kind === "exited") {
            this.#lost(session);
            settle({
              kind: "failed",
              failure: "runtime_exited",
              reason: `${this.#options.runtime} exited${event.code === null ? "" : ` with code ${event.code}`}${event.reason === undefined ? "" : `: ${event.reason}`}`,
            });
          } else if (
            event.kind === "input_dropped" &&
            event.inputId === inputId &&
            event.reason === "runtime_refused"
          ) {
            settle({
              kind: "failed",
              failure: event.failure ?? "invalid_request",
              reason: event.message ?? "the runtime refused the prompt",
            });
          }
        }),
      );
      // Steering: into the turn where the runtime takes it; otherwise it waits for the turn's end.
      if (session.steer !== undefined) {
        const steer = session.steer.bind(session);
        offs.push(
          context.onInput(() => {
            const steered = inputOf(context.take({ followUps: false }));
            if (steered.text === "") return;
            void steer(steered.text).then((result) => {
              if (result.kind === "rejected")
                this.#options.warn(
                  `[eta-runtime-oar] a steer did not land: ${result.reason}`,
                );
            });
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
        .prompt(input.text, {
          inputId,
          ...(images.length === 0 ? {} : { images }),
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
  }

  /** The runtime process is gone: the next run opens it again, resuming the conversation. */
  #lost(session: Session): void {
    if (this.#opened?.session !== session) return;
    this.#opened = undefined;
    this.#resume = session.id;
    void session.dispose().catch(() => undefined);
  }
}
