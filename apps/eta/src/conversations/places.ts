/**
 * Where an agent's session lives.
 *
 * The engine decides what a message does; where the session that answers it runs is a separate
 * matter, and the engine should not care. It asks a *place* for the agent's session in a
 * conversation and gets a handle on it, and everything it does with the session (join a turn,
 * stop it, run it and wait for what it said) is a method of that handle. There are two places: this
 * process (the primary's own sessions, which is what the engine used to talk to directly) and a
 * machine that runs the daemon (`machines/remote-place.ts`, over the link). The engine's rows,
 * chains, steering, stopping and recovery are the same for both.
 */
import type {
  DaemonRunEvent,
  PromptImage,
  RunOutcome,
  ThinkingLevel,
} from "@eta/client-contracts";
import type { ManagedSession, SessionsService } from "@eta/server";
import type { AgentRecord } from "../agents/store";
import type { MachineRecord } from "../machines/store";
import { kernelOn } from "@eta/core";
import { lastSeq, runAndWait } from "@eta/daemon";
import { formatModelId } from "@eta/server";

/** One session, as the engine drives it. */
export interface SessionHandle {
  readonly id: string;
  /** Whether a turn is in flight, which a steer can join. */
  readonly running: boolean;
  /** Put words (and images) into the turn in flight; they arrive at its next boundary. */
  steer: (text: string, images?: PromptImage[]) => Promise<void>;
  /** The model the session runs on now, as `provider:modelId`; undefined when it cannot say. */
  model: () => Promise<string | undefined>;
  /** How far the session's journal has got: what its next run writes comes after this. */
  lastSeq: () => Promise<number>;
  /**
   * Give the session these words as its next run and wait until it is quiet. `keepGoing` lets a
   * caller that is shutting down end the wait between two runs of the same reply.
   */
  run: (
    prompt: string,
    keepGoing: () => boolean,
    images?: PromptImage[],
  ) => Promise<RunOutcome>;
  /** Ask the run in flight to stop. */
  abort: () => void;
  /** Observe run activity while a caller needs liveness evidence. */
  onActivity?: (listener: (kind: DaemonRunEvent["kind"]) => void) => () => void;
}

/** What a place needs to find or make an agent's session in a conversation. */
export interface EnsureInput {
  /**
   * What the session is held in: a conversation, or a task (`tasks/session-key.ts`). Its id is the
   * session's `conversationId`; its name is the session's title.
   */
  conversation: { id: string; name: string };
  agent: AgentRecord;
  /** The machine the project is on. */
  machine: MachineRecord;
  /** The project's directory, on that machine. */
  cwd: string;
  /** The session the participant row names, when it names one. */
  existing: string | null;
  /** Who the agent is and what it was told: the platform section of its system prompt. */
  prompt: string;
  /** What `prompt` and the persona were read from; a session opened with another is reopened. */
  stamp: string;
  /** A session was made: record it before anything else can fail. */
  created: (sessionId: string) => void;
}

export interface SessionPlace {
  /**
   * The agent's session in this conversation: the one the participant row names, brought in line
   * with the agent as it is now, or a new one made on the spot.
   */
  ensure: (input: EnsureInput) => Promise<SessionHandle>;
  /**
   * Put these settings on a session that exists (an agent was edited). A session that cannot be
   * reached or is busy throws; the caller makes a warning of it.
   */
  configure: (
    sessionId: string,
    machine: MachineRecord,
    settings: SessionSettings,
  ) => Promise<void>;
}

/** The settings of an agent that its sessions carry as their own. */
export interface SessionSettings {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The runtime a session's row names; a row that names none runs on eta's own loop. */
const runtimeOf = (runtime: string | undefined): string => runtime ?? "eta";

/** A session in this process. */
class LocalHandle implements SessionHandle {
  readonly #sessions: SessionsService;
  readonly #managed: ManagedSession;

  constructor(sessions: SessionsService, managed: ManagedSession) {
    this.#sessions = sessions;
    this.#managed = managed;
  }

  get id(): string {
    return this.#managed.meta.id;
  }

  get running(): boolean {
    return this.#managed.session.runner.running;
  }

  steer(text: string, images?: PromptImage[]): Promise<void> {
    return this.#sessions.prompt(this.id, {
      text,
      mode: "steer",
      ...(images === undefined || images.length === 0 ? {} : { images }),
    });
  }

  model(): Promise<string | undefined> {
    return Promise.resolve(
      formatModelId(this.#managed.session.kernel.config.read("model")),
    );
  }

  lastSeq(): Promise<number> {
    return Promise.resolve(lastSeq(this.#managed));
  }

  run(
    prompt: string,
    keepGoing: () => boolean,
    images?: PromptImage[],
  ): Promise<RunOutcome> {
    return runAndWait(this.#managed, prompt, keepGoing, images);
  }

  abort(): void {
    this.#managed.session.runner.abort();
  }

  onActivity(listener: (kind: DaemonRunEvent["kind"]) => void): () => void {
    const ctx = this.#managed.session.kernel.ctx;
    const offs = [
      kernelOn(ctx)("tool:start", () => listener("tool-start")),
      kernelOn(ctx)("tool:update", () => listener("tool-update")),
      kernelOn(ctx)("tool:end", () => listener("tool-end")),
      kernelOn(ctx)("message:start", () => listener("message")),
      kernelOn(ctx)("message:update", () => listener("message")),
      kernelOn(ctx)("message:end", () => listener("message")),
    ];
    return () => {
      for (const off of offs) off();
    };
  }
}

/** This process's own sessions, through the upstream session host. */
export class LocalPlace implements SessionPlace {
  readonly #opened: Map<string, string>;
  readonly #warn: (message: string) => void;
  #sessions: SessionsService | undefined;

  /**
   * `opened` is what each open session's prompt was read from (the engine fills it in when the
   * session host asks for the prompt), to know when a session has to be opened again.
   */
  constructor(options: {
    opened: Map<string, string>;
    warn: (message: string) => void;
  }) {
    this.#opened = options.opened;
    this.#warn = options.warn;
  }

  attach(sessions: SessionsService): void {
    this.#sessions = sessions;
  }

  detach(): void {
    this.#sessions = undefined;
  }

  /** A handle on a session this process has open; undefined when the host is not running. */
  handleOf(managed: ManagedSession): SessionHandle | undefined {
    return this.#sessions === undefined
      ? undefined
      : new LocalHandle(this.#sessions, managed);
  }

  async ensure(input: EnsureInput): Promise<SessionHandle> {
    const sessions = this.#sessions;
    if (sessions === undefined)
      throw new Error("the session host is not running");
    const { agent, conversation } = input;
    if (input.existing !== null) {
      try {
        const { managed } = await sessions.open(input.existing);
        if (runtimeOf(managed.meta.runtime) === agent.runtime) {
          await this.#sync(sessions, input.existing, agent, input.stamp);
          return new LocalHandle(
            sessions,
            (await sessions.open(input.existing)).managed,
          );
        }
        // The agent moved to another runtime: a conversation is one runtime's, so it starts over.
        this.#warn(
          `[eta] session ${input.existing} (agent ${agent.id} in ${conversation.id}) runs on ${runtimeOf(managed.meta.runtime)}, the agent on ${agent.runtime}; starting a new one`,
        );
      } catch (error) {
        // The row outlived its journal: say so, then start over rather than failing every wake.
        if (!messageOf(error).startsWith("no such session")) throw error;
        this.#warn(
          `[eta] session ${input.existing} (agent ${agent.id} in ${conversation.id}) is gone; starting a new one`,
        );
      }
    }
    const id = await sessions.create({
      cwd: input.cwd,
      title: `${conversation.name} · ${agent.name}`,
      agentId: agent.id,
      conversationId: conversation.id,
      ...(agent.runtime === "eta" ? {} : { runtime: agent.runtime }),
      ...(agent.model === null ? {} : { model: agent.model }),
      ...(agent.persona === "" ? {} : { persona: agent.persona }),
    });
    input.created(id);
    if (agent.thinkingLevel !== null) {
      await sessions
        .thinkingLevel(id, agent.thinkingLevel)
        .catch((error: unknown) => this.#warn(`[eta] ${messageOf(error)}`));
    }
    const handle = new LocalHandle(sessions, (await sessions.open(id)).managed);
    return handle;
  }

  async configure(
    sessionId: string,
    _machine: MachineRecord,
    settings: SessionSettings,
  ): Promise<void> {
    const sessions = this.#sessions;
    if (sessions === undefined)
      throw new Error("the session host is not running");
    if (settings.model !== undefined)
      await sessions.modelSet(sessionId, settings.model);
    if (settings.thinkingLevel !== undefined)
      await sessions.thinkingLevel(sessionId, settings.thinkingLevel);
  }

  /**
   * An agent can be edited after its sessions exist. The model and the thinking level are given
   * to a session when it is made and are its own after that (`configure` is how an edit of the
   * agent overrides them). The
   * instructions and the persona are read when a session opens, so a session that was opened with
   * other ones is closed here and the open that follows reads the new ones. Never while it is
   * running: wakes are serial, so by the time one starts its session is idle.
   */
  async #sync(
    sessions: SessionsService,
    id: string,
    agent: AgentRecord,
    stamp: string,
  ): Promise<void> {
    await sessions.open(id);
    if (this.#opened.get(id) !== stamp) {
      await sessions.setMeta(id, {
        persona: agent.persona === "" ? undefined : agent.persona,
      });
      await sessions.close(id);
    }
  }
}
