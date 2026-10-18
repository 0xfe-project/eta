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
import type { RunOutcome, ThinkingLevel } from "@eta/client-contracts";
import type { ManagedSession, SessionsService } from "@eta/server";
import type { AgentRecord } from "../agents/store";
import type { MachineRecord } from "../machines/store";
import type { ConversationRecord } from "./store";
import { runAndWait } from "@eta/daemon";

/** One session, as the engine drives it. */
export interface SessionHandle {
  readonly id: string;
  /** Whether a turn is in flight, which a steer can join. */
  readonly running: boolean;
  /** Put words into the turn in flight; they arrive at its next boundary. */
  steer: (text: string) => Promise<void>;
  /**
   * Give the session these words as its next run and wait until it is quiet. `keepGoing` lets a
   * caller that is shutting down end the wait between two runs of the same reply.
   */
  run: (prompt: string, keepGoing: () => boolean) => Promise<RunOutcome>;
  /** Ask the run in flight to stop. */
  abort: () => void;
}

/** What a place needs to find or make an agent's session in a conversation. */
export interface EnsureInput {
  conversation: ConversationRecord;
  agent: AgentRecord;
  /** The machine the project is on. */
  machine: MachineRecord;
  /** The project's directory, on that machine. */
  cwd: string;
  /** The session the participant row names, when it names one. */
  existing: string | null;
  /** The base of the system prompt: the harness's own, who the agent is, what it was told. */
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

  steer(text: string): Promise<void> {
    return this.#sessions.prompt(this.id, { text, mode: "steer" });
  }

  run(prompt: string, keepGoing: () => boolean): Promise<RunOutcome> {
    return runAndWait(this.#managed, prompt, keepGoing);
  }

  abort(): void {
    this.#managed.session.runner.abort();
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

  async ensure(input: EnsureInput): Promise<SessionHandle> {
    const sessions = this.#sessions;
    if (sessions === undefined)
      throw new Error("the session host is not running");
    const { agent, conversation } = input;
    if (input.existing !== null) {
      try {
        await this.#sync(sessions, input.existing, agent, input.stamp);
        return new LocalHandle(
          sessions,
          (await sessions.open(input.existing)).managed,
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
      ...(agent.model === null ? {} : { model: agent.model }),
      ...(agent.persona === "" ? {} : { persona: agent.persona }),
    });
    input.created(id);
    if (agent.thinkingLevel !== null) {
      await sessions
        .thinkingLevel(id, agent.thinkingLevel)
        .catch((error: unknown) => this.#warn(`[eta] ${messageOf(error)}`));
    }
    return new LocalHandle(sessions, (await sessions.open(id)).managed);
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
   * to a session when it is made and are its own after that (the user may change them with the
   * composer's controls; `configure` is how an edit of the agent overrides them). The
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
