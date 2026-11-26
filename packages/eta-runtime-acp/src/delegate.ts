/**
 * An ACP agent taking an eta session's runs.
 *
 * One eta session is one agent process and one ACP session in it, started at the first run and
 * kept until the session closes. A run is one `session/prompt` after another: the run's opening,
 * then whatever was queued while the agent answered. The protocol has one prompt at a time and no
 * way to add to a turn in flight, so an input that arrives mid-turn waits for the turn's end.
 *
 * - Opening: `session/resume` where the agent has it and this session has run before,
 *   `session/load` (its replay dropped: the journal already has it) where it has only that,
 *   `session/new` otherwise, and whenever the agent no longer has the old one.
 * - A process that died is noticed at the next run, which starts another and picks the session up
 *   again the same way.
 * - An idle agent's process can be let go (`release`) the same way, where the agent can pick its
 *   session up again: one that can do neither `session/resume` nor `session/load` is never let go,
 *   since a new session would not know the conversation.
 * - Cancelling is `session/cancel`; the agent answers the prompt as `cancelled`. One that does
 *   not, in time, loses its process.
 * - The host's tools reach the agent as an MCP server on this machine (`eta`), where the agent
 *   takes HTTP MCP servers; a call runs through the session's own middleware chain. The set is
 *   read again at every run, and one that changed is served anew with `list_changed`, so the
 *   agent sees it at its next turn without a new process (`HostTools`, `@eta/runtime-kit`). The
 *   session's plugin MCP servers go along in the same list.
 * - `session/request_permission` is answered here, always with yes (the agent's own allow option,
 *   this once): nobody is asked and nothing reaches the Inbox. A request outside a turn, or after
 *   the turn was cancelled, is answered `cancelled`.
 * - The process starts in the session's working directory.
 */
import type {
  AgentCapabilities,
  ContentBlock,
  LoadSessionRequest,
  McpServer,
  NewSessionRequest,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  SystemPrompt,
} from "@agentclientprotocol/sdk";
import type { PromptResponse as UnstablePromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { AcpAgentConfig, SessionMcpServer } from "@eta/client-contracts";
import type {
  AgentMessage,
  DelegatedRunResult,
  RunDelegate,
  RunDelegateContext,
} from "@eta/core";
import type { AcpChoices } from "./models";
import { hostResultOf, HostTools, NO_RUN } from "@eta/runtime-kit";
import { choicesOf, effortFor } from "./models";
import { AcpProcess, messageOf, methods } from "./process";
import { Translator } from "./translate";

export interface AcpDelegateOptions {
  /** `acp.<id>`. */
  runtime: string;
  /** The agent as it is configured now; throws with the reason when it is not. */
  agent: () => AcpAgentConfig;
  sessionId: string;
  cwd: string;
  resume: string | undefined;
  agentPrompt: () => string | undefined;
  remember: (nativeSession: string) => void | Promise<void>;
  mcpServers: readonly SessionMcpServer[] | undefined;
  /** The host's tools this session is offered, by name; read when the agent's session opens. */
  hostTools: () => readonly string[];
  /** What a session of this agent can be set to, whenever the agent says. */
  learn: (choices: AcpChoices) => void;
  warn: (message: string) => void;
  /** How long a cancelled prompt may take to end before the process is stopped. */
  cancelGraceMs?: number;
}

interface Opened {
  process: AcpProcess;
  agent: AcpAgentConfig;
  capabilities: AgentCapabilities;
  /** Whether the agent has the agent's words already; if not, the first prompt carries them. */
  prompted: boolean;
}

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

type TurnOutcome =
  | { kind: "completed" }
  | { kind: "aborted" }
  | { kind: "failed"; error: string };

const CANCELLED: RequestPermissionResponse = {
  outcome: { outcome: "cancelled" },
};

/** An agent that says it wants a sign-in, in whatever words it uses. */
export function isAuthError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === -32000 ||
    /auth|log ?in|sign ?in|credential|api key/i.test(messageOf(error))
  );
}

/** The session's MCP servers in ACP's shape; one the agent cannot take is left out. */
export function acpServers(
  servers: readonly SessionMcpServer[] | undefined,
  capabilities: AgentCapabilities,
  warn: (message: string) => void,
): McpServer[] {
  const out: McpServer[] = [];
  for (const server of servers ?? []) {
    if ("command" in server) {
      out.push({
        name: server.name,
        command: server.command,
        args: [...(server.args ?? [])],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      });
    } else if (capabilities.mcpCapabilities?.http === true) {
      out.push({
        type: "http",
        name: server.name,
        url: server.url,
        headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      });
    } else {
      warn(
        `[eta-runtime-acp] the MCP server ${server.name} is HTTP, which this agent does not take; left out`,
      );
    }
  }
  return out;
}

function optionFor(
  options: readonly PermissionOption[],
  kinds: readonly PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const found = options.find((option) => option.kind === kind);
    if (found !== undefined) return found;
  }
  return undefined;
}

export class AcpDelegate implements RunDelegate {
  readonly #options: AcpDelegateOptions;
  #opened: Opened | undefined;
  #connection: symbol | undefined;
  /** The agent's own session id, once there is one. */
  #native: string | undefined;
  #choices: AcpChoices = {};
  /** `session/load` replays the conversation: nothing of it is news. */
  #replaying = false;
  #running = false;
  #disposed = false;
  #translator: Translator | undefined;
  /** Aborted when the turn ends or is cancelled: a permission request after that is refused. */
  #permissions: AbortController | undefined;
  /** The agent's running cost that the transcript has been charged. */
  #charged = 0;
  readonly #undelivered: Input[] = [];
  /** The run in flight: where a call to one of the host's tools runs. */
  #run: RunDelegateContext | undefined;
  /** The host's tools, served to the agent and listed anew at every run. */
  readonly #host: HostTools;
  /** The release in flight: an open waits for the old process to be gone. */
  #releasing: Promise<void> | undefined;
  /** When this session last did something: a run, or an update from the agent. */
  #lastActive = Date.now();

  constructor(options: AcpDelegateOptions) {
    this.#options = options;
    this.#native = options.resume;
    this.#host = new HostTools({
      offered: options.hostTools,
      call: async (name, input) => {
        const run = this.#run;
        if (run === undefined) return NO_RUN;
        const raw = await run.executeTool(name, input, {
          toolCallId: `mcp-${crypto.randomUUID()}`,
        });
        return hostResultOf(name, raw).result;
      },
    });
  }

  async run(context: RunDelegateContext): Promise<DelegatedRunResult> {
    if (this.#disposed)
      return { status: "failed", error: "the session is closed" };
    if (this.#running)
      return { status: "failed", error: "the agent is already in a turn" };
    this.#running = true;
    this.#run = context;
    this.#lastActive = Date.now();
    try {
      let opened: Opened;
      try {
        opened = await this.#open(context);
      } catch (error) {
        if (context.signal.aborted) return { status: "aborted" };
        return { status: "failed", error: messageOf(error) };
      }
      // The host's tools as they are now: a set that changed since the agent last listed them is
      // served anew, and the agent told so (`list_changed`).
      await this.#host.refresh(context);
      let input = joined([
        ...this.#undelivered.splice(0),
        inputOf(context.opening),
      ]);
      for (;;) {
        if (isEmpty(input)) return { status: "completed" };
        if (context.signal.aborted) {
          this.#undelivered.unshift(input);
          return { status: "aborted" };
        }
        const prompt = this.#introduced(opened, input);
        input = { text: "", images: [] };
        const outcome = await this.#turn(opened, prompt, context);
        if (outcome.kind === "aborted") return { status: "aborted" };
        if (outcome.kind === "failed")
          return { status: "failed", error: outcome.error };
        if (context.signal.aborted) return { status: "aborted" };
        // What arrived while the agent answered opens the next prompt.
        input = inputOf(context.take({ followUps: true }));
      }
    } finally {
      this.#running = false;
      this.#run = undefined;
      this.#lastActive = Date.now();
    }
  }

  /** Whether an agent process is up for this session, and when the session last did anything. */
  residency(): { resident: boolean; lastActive: number } {
    return {
      resident: this.#opened !== undefined && !this.#opened.process.lost,
      lastActive: this.#lastActive,
    };
  }

  /**
   * Let the agent's process go between runs, keeping the conversation: the next run picks the
   * agent's session up again. Only an agent that can (`session/resume` or `session/load`); answers
   * whether it was let go.
   */
  async release(): Promise<boolean> {
    const opened = this.#opened;
    if (
      opened === undefined ||
      this.#disposed ||
      this.#running ||
      this.#releasing !== undefined ||
      this.#native === undefined
    )
      return false;
    const { capabilities } = opened;
    if (
      capabilities.sessionCapabilities?.resume == null &&
      capabilities.loadSession !== true
    )
      return false;
    this.#opened = undefined;
    this.#connection = undefined;
    this.#releasing = opened.process
      .stop()
      .catch(() => undefined)
      .finally(() => {
        this.#releasing = undefined;
      });
    await this.#releasing;
    return true;
  }

  /** Let the agent go: its questions, its session, its process. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#connection = undefined;
    this.#permissions?.abort();
    await this.#releasing;
    const opened = this.#opened;
    this.#opened = undefined;
    await this.#host.close();
    if (opened === undefined) return;
    const native = this.#native;
    if (
      !opened.process.lost &&
      native !== undefined &&
      opened.capabilities.sessionCapabilities?.close != null
    ) {
      await Promise.race([
        opened.process.agent
          .request(methods.agent.session.close, { sessionId: native })
          .catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    await opened.process.stop();
  }

  /** The agent's words go with the first prompt an agent that took no system prompt hears. */
  #introduced(opened: Opened, input: Input): Input {
    if (opened.prompted) return input;
    opened.prompted = true;
    const agentPrompt = this.#options.agentPrompt();
    if (agentPrompt === undefined) return input;
    return {
      ...input,
      text: `<agent>\n${agentPrompt}\n</agent>\n\n${input.text}`,
    };
  }

  /**
   * The host's tools (a task board, a way to reach other agents) as an MCP server on this
   * machine, for an agent that takes HTTP MCP servers. A call runs through the session's own
   * middleware chain, under the run in flight: a tool's policy holds here as anywhere.
   */
  async #serve(
    context: RunDelegateContext,
    capabilities: AgentCapabilities,
  ): Promise<SessionMcpServer | undefined> {
    const names = new Set(this.#options.hostTools());
    if (names.size === 0) return undefined;
    if (capabilities.mcpCapabilities?.http !== true) {
      this.#options.warn(
        `[eta-runtime-acp] ${this.#options.runtime} takes no HTTP MCP servers: its sessions do not get eta's own tools`,
      );
      return undefined;
    }
    const server = await this.#host.serve(context);
    if (server === undefined) return undefined;
    return {
      name: server.name,
      type: "http",
      url: server.url,
      ...(server.headers === undefined
        ? {}
        : { headers: { ...server.headers } }),
    };
  }

  async #open(context: RunDelegateContext): Promise<Opened> {
    // A process being let go still holds the agent's session: the next one waits for it to be gone.
    await this.#releasing;
    const known = this.#opened;
    if (known !== undefined) {
      if (!known.process.lost) return known;
      // The process died between runs, or under the last one: this run starts another.
      this.#opened = undefined;
      this.#options.warn(
        `[eta-runtime-acp] ${this.#options.runtime}: the agent process of ${this.#options.sessionId} is gone; starting another${known.process.lastWords}`,
      );
      await known.process.stop().catch(() => undefined);
    }
    const agent = this.#options.agent();
    const connection = Symbol("ACP connection");
    this.#connection = connection;
    const process = await AcpProcess.start(
      {
        command: agent.command,
        args: agent.args,
        env: agent.env,
        cwd: this.#options.cwd,
      },
      {
        update: (notification) => {
          if (this.#connection === connection)
            this.#update(notification, context.emit);
        },
        permission: async (request) => this.#permission(request),
      },
      { warn: this.#options.warn, label: this.#options.runtime },
    );
    try {
      const opened = await this.#session(process, agent, context);
      if (this.#disposed) throw new Error("the session is closed");
      this.#opened = opened;
      return opened;
    } catch (error) {
      await process.stop().catch(() => undefined);
      throw error;
    }
  }

  /** Pick up the agent's session where this one has run before, or open a new one. */
  async #session(
    process: AcpProcess,
    agent: AcpAgentConfig,
    context: RunDelegateContext,
  ): Promise<Opened> {
    const { runtime, warn, cwd } = this.#options;
    const capabilities = process.init.agentCapabilities ?? {};
    const host = await this.#serve(context, capabilities);
    const mcpServers = acpServers(
      [
        ...(host === undefined ? [] : [host]),
        ...(this.#options.mcpServers ?? []),
      ],
      capabilities,
      warn,
    );
    const agentPrompt = this.#options.agentPrompt();
    const systemPrompt: { systemPrompt?: SystemPrompt } =
      capabilities.sessionCapabilities?.systemPrompt != null &&
      agentPrompt !== undefined
        ? {
            systemPrompt: {
              mode: "append",
              content: [{ type: "text" as const, text: agentPrompt }],
            },
          }
        : {};
    const previous = this.#native;
    let options: readonly SessionConfigOption[] | null | undefined;
    let resumed = false;
    if (previous !== undefined) {
      const picked: LoadSessionRequest = {
        sessionId: previous,
        cwd,
        mcpServers,
        ...systemPrompt,
      };
      try {
        if (capabilities.sessionCapabilities?.resume != null) {
          const answer = await process.agent.request(
            methods.agent.session.resume,
            picked,
          );
          options = answer.configOptions;
          resumed = true;
        } else if (capabilities.loadSession === true) {
          this.#replaying = true;
          try {
            const answer = await process.agent.request(
              methods.agent.session.load,
              picked,
            );
            options = answer.configOptions;
            resumed = true;
          } finally {
            this.#replaying = false;
          }
        } else {
          warn(
            `[eta-runtime-acp] ${runtime} cannot pick a session up again; ${this.#options.sessionId} continues in a new one, without what the agent remembered`,
          );
        }
      } catch (error) {
        warn(
          `[eta-runtime-acp] ${runtime} no longer has session ${previous} (${messageOf(error)}); ${this.#options.sessionId} continues in a new one`,
        );
      }
    }
    if (!resumed) {
      try {
        const fresh: NewSessionRequest = { cwd, mcpServers, ...systemPrompt };
        const answer = await process.agent.request(
          methods.agent.session.new,
          fresh,
        );
        this.#native = answer.sessionId;
        await this.#options.remember(answer.sessionId);
        // A new agent session counts its cost from zero.
        this.#charged = 0;
        options = answer.configOptions;
      } catch (error) {
        if (isAuthError(error))
          throw new Error(
            `runtime_unavailable: ${agent.label} is not signed in (${messageOf(error)}). Sign in from a terminal on this machine first.`,
          );
        throw new Error(
          `${agent.label} could not open a session: ${messageOf(error)}${process.lastWords}`,
        );
      }
    }
    this.#learn(options);
    return {
      process,
      agent,
      capabilities,
      // A conversation that was picked up already heard who it is.
      prompted: "systemPrompt" in systemPrompt || resumed,
    };
  }

  #learn(options: readonly SessionConfigOption[] | null | undefined): void {
    if (options === undefined || options === null) return;
    this.#choices = choicesOf(options);
    this.#options.learn(this.#choices);
  }

  /** Set the agent to the session's model and thinking level, where it takes them. */
  async #configure(opened: Opened, context: RunDelegateContext): Promise<void> {
    const sessionId = this.#native;
    if (sessionId === undefined) return;
    const config = context.config();
    const effort = effortFor(
      config.thinkingLevel,
      this.#choices.effort?.values.map((item) => item.value) ?? [],
    );
    const wanted: [choice: AcpChoices["model"], value: string | undefined][] = [
      [
        this.#choices.model,
        config.model.provider === this.#options.runtime
          ? config.model.modelId
          : undefined,
      ],
      [this.#choices.effort, effort],
    ];
    for (const [choice, value] of wanted) {
      if (choice === undefined || value === undefined) continue;
      if (choice.current === value) continue;
      try {
        const answer = await opened.process.agent.request(
          methods.agent.session.setConfigOption,
          { sessionId, configId: choice.configId, value },
        );
        this.#learn(answer.configOptions);
      } catch (error) {
        throw new Error(
          `${opened.agent.label} did not take ${choice.configId} = ${value}: ${messageOf(error)}`,
        );
      }
    }
    // Set only where the agent offers the choice; otherwise nothing was asked of it.
    context.recordThinking(
      this.#choices.effort === undefined ? undefined : effort,
    );
  }

  #blocks(opened: Opened, input: Input): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    let text = input.text;
    if (input.images.length > 0) {
      if (opened.capabilities.promptCapabilities?.image === true)
        for (const image of input.images)
          blocks.push({
            type: "image",
            data: image.data,
            mimeType: image.mimeType,
          });
      else
        text = `${text}\n\n[${input.images.length} image(s) were attached; ${opened.agent.label} takes no images]`;
    }
    return [{ type: "text", text }, ...blocks];
  }

  async #turn(
    opened: Opened,
    input: Input,
    context: RunDelegateContext,
  ): Promise<TurnOutcome> {
    const sessionId = this.#native!;
    const { signal } = context;
    const model = this.#choices.model?.current;
    if (model !== undefined)
      context.emit("context:invalidated", {
        reason: "model",
        model,
        nativeSessionId: sessionId,
        runId: context.runId,
        at: Date.now(),
      });
    const translator = new Translator(
      {
        runId: context.runId,
        emit: context.emit,
        push: context.push,
        noteTurn: context.noteTurn,
      },
      {
        provider: this.#options.runtime,
        nativeSessionId: sessionId,
        model: model ?? context.config().model.modelId,
      },
      this.#charged,
    );
    const permissions = new AbortController();
    this.#permissions = permissions;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      // Whoever was asked is no longer asked; the agent hears `cancelled` for each.
      permissions.abort();
      void opened.process.agent
        .notify(methods.agent.session.cancel, { sessionId })
        .catch(() => undefined);
      grace = setTimeout(() => {
        this.#options.warn(
          `[eta-runtime-acp] ${this.#options.runtime} did not end its cancelled turn; stopping its process`,
        );
        void opened.process.stop();
      }, this.#options.cancelGraceMs ?? 10_000);
    };
    try {
      await this.#configure(opened, context);
      translator.setModel(
        this.#choices.model?.current ?? context.config().model.modelId,
      );
      this.#translator = translator;
      const prompt = opened.process.agent.request(
        methods.agent.session.prompt,
        { sessionId, prompt: this.#blocks(opened, input) },
      );
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      // An agent may answer with the turn's tokens: unstable in ACP, so absent from the stable type.
      const answer: UnstablePromptResponse = await prompt;
      if (answer.stopReason === "cancelled" || signal.aborted) {
        translator.finish("aborted", undefined, answer.usage);
        return { kind: "aborted" };
      }
      translator.finish("completed", undefined, answer.usage);
      if (answer.stopReason !== "end_turn")
        this.#options.warn(
          `[eta-runtime-acp] ${this.#options.runtime} ended its turn with ${answer.stopReason}`,
        );
      return { kind: "completed" };
    } catch (error) {
      if (signal.aborted) {
        translator.finish("aborted");
        return { kind: "aborted" };
      }
      const message = `${opened.agent.label} failed: ${messageOf(error)}${opened.process.lost ? opened.process.lastWords : ""}`;
      translator.finish("failed", message);
      return { kind: "failed", error: message };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (grace !== undefined) clearTimeout(grace);
      permissions.abort();
      this.#translator = undefined;
      this.#permissions = undefined;
      this.#charged = translator.charged;
    }
  }

  #update(
    notification: SessionNotification,
    emit: RunDelegateContext["emit"],
  ): void {
    if (this.#replaying) return;
    if (notification.sessionId !== this.#native) return;
    this.#lastActive = Date.now();
    const { update } = notification;
    if (update.sessionUpdate === "config_option_update") {
      const previous = this.#choices.model?.current;
      this.#learn(update.configOptions);
      const model = this.#choices.model?.current;
      if (model !== undefined && previous !== model) {
        if (this.#translator) this.#translator.setModel(model);
        else
          emit("context:invalidated", {
            reason: "model",
            model,
            nativeSessionId: notification.sessionId,
            at: Date.now(),
          });
      }
      return;
    }
    // Between prompts there is no turn to tell it in.
    this.#translator?.see(update);
  }

  #permission(request: RequestPermissionRequest): RequestPermissionResponse {
    const translator = this.#translator;
    const signal = this.#permissions?.signal;
    const opened = this.#opened;
    if (
      request.sessionId !== this.#native ||
      translator === undefined ||
      signal === undefined ||
      signal.aborted ||
      opened === undefined
    )
      return CANCELLED;
    // The call is in the transcript before the agent hears the answer.
    translator.call({ ...request.toolCall, status: undefined });
    // Yes, this once: the agent is not told to stop asking.
    const allow = optionFor(request.options, ["allow_once", "allow_always"]);
    return allow === undefined
      ? CANCELLED
      : { outcome: { outcome: "selected", optionId: allow.optionId } };
  }
}
