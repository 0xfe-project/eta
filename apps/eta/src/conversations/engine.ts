import type {
  MessageStatus,
  MessageView,
  PromptImage,
  SendResult,
  SteerHeldResult,
} from "@eta/client-contracts";
import type { KernelModels, KernelTool } from "@eta/core";
import type { AskObserver, ImageLimits } from "@eta/harness";
import type { ManagedSession, SessionMeta, SessionsService } from "@eta/server";
import type { SshTransport } from "@eta/ssh";
/**
 * The engine: what a message does.
 *
 * A message names (or implies) the agents it wakes, and each wake is a reply row that is queued,
 * works, and ends. This file is the part that turns rows into runs:
 *
 * - **One session per (agent x conversation)**, made at the agent's first wake in the project's
 *   directory, with the agent's model, persona and instructions, and found again by the
 *   participant row ever after (a restart is a fresh process reading the same rows).
 * - **Serial on a session, parallel across sessions.** A session answers one thing at a time; an
 *   agent in three conversations has three sessions, and a conversation of three agents runs
 *   three at once. The chain key is the participant, because that is the session before it exists.
 * - **The row is the wake.** There is no queue beside the timeline: a reply row that is `queued`
 *   is a wake waiting for its session, `working` one that is running, and a restart fails whatever
 *   was left in flight.
 *
 * It holds the only in-memory state there is: which reply is running on which session (to stop or
 * steer it) and the chains. Everything else is a read of the database.
 */
import type { Database } from "bun:sqlite";
import type { AgentInput, AgentRecord, AgentStore } from "../agents/store";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { AttachmentRecord, AttachmentStore } from "./attachments";
import type { SessionHandle, SessionPlace } from "./places";
import type { ConversationPolicies } from "./policy";
import type { ConversationRecord, ConversationStore } from "./store";
import type { Timeline } from "./timeline";
import { homedir } from "node:os";
import { isExternalRuntime } from "@eta/client-contracts";
import { heldFor } from "@eta/client-contracts/routing";
import { kernelOn } from "@eta/core";
import { lastSeq, LinkError, listen } from "@eta/daemon";
import { imageLimitsFor } from "@eta/harness";
import { parseModelId } from "@eta/server";
import { externalAgentProjectError } from "../agents/bounds";
import { explainRunError, missingModel } from "../agents/model";
import { heldIn } from "../session-owner";
import { viewOf as attachmentView } from "./attachments";
import { briefing } from "./briefing";
import { LocalPlace, messageOf } from "./places";
import { judgeMention, resolveNamed, WAKE_BUDGET } from "./routing";
import { conversationTools } from "./tools";

/** What a reply says when the process died under it. */
export const RESTART_TEXT = "The server restarted before this reply finished.";
/** What a reply that was being stopped when the server went says about it. */
export const RESTART_STOP_NOTE =
  "The server restarted while this reply was being stopped, so it was stopped here.";

/**
 * How long a run is given to end once it was told to stop. After that the reply is the user's:
 * it ends as stopped, and whatever the run says later is not written.
 */
const STOP_GRACE_MS = 5_000;

/** One wake, as a feature that wants to act around its run sees it. */
export interface RunInfo {
  conversationId: string;
  agentId: string;
  replyId: string;
  /** The session that runs it. */
  sessionId: string;
  /** The project's directory, when it is on this machine; a project elsewhere has none to read. */
  cwd: string | undefined;
  /** What the agent is told: the briefing. */
  told: string;
  /** The message that woke it. */
  trigger: MessageView;
}

/**
 * What a feature may do around a wake's run (memory is the first). Both are optional, and neither
 * can fail a reply: an error is reported and the run goes on as if the hook had nothing to say.
 */
export interface RunHooks {
  /** Words put ahead of the briefing for this run. Waited for, so it must be quick. */
  beforeRun?: (
    run: RunInfo,
  ) => string | undefined | Promise<string | undefined>;
  /** The reply ended `done`, `failed` or `stopped` with this text. Not waited for. */
  afterRun?: (
    run: RunInfo & { status: MessageStatus; said: string },
  ) => void | Promise<void>;
}

/**
 * Several features' hooks as one. Words from every `beforeRun` go ahead of the briefing, in list
 * order; every `afterRun` is told, and one that fails does not keep the others from hearing it.
 */
export function combineRunHooks(hooks: readonly RunHooks[]): RunHooks {
  return {
    beforeRun: async (run) => {
      const words = (
        await Promise.all(hooks.map((hook) => hook.beforeRun?.(run)))
      ).filter(
        (text): text is string => text !== undefined && text.trim() !== "",
      );
      return words.length === 0 ? undefined : words.join("\n\n");
    },
    afterRun: async (run) => {
      const settled = await Promise.allSettled(
        hooks.map((hook) => hook.afterRun?.(run)),
      );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed !== undefined) throw failed.reason;
    },
  };
}

export interface EngineOptions {
  runHooks?: RunHooks | undefined;
  /** What an agent's plugins add to the stamp of its sessions: a change reopens them. */
  pluginStamp?: ((agent: AgentRecord) => string) | undefined;
  /** Look at the plugins on disk again; waited for before a session is brought in line. */
  pluginsRead?: (() => Promise<void>) | undefined;
  /** Product state (memory pause, Captain membership) that makes an open session stale. */
  sessionStamp?:
    | ((conversationId: string, agentId: string) => string)
    | undefined;
  /**
   * Where the sessions of a project on a daemon machine live. Without one, such a project's
   * replies fail as unavailable, which is what a host with no link to other machines should say.
   */
  remote?: SessionPlace | undefined;
  db: Database;
  agents: AgentStore;
  machines: MachineStore;
  projects: ProjectStore;
  conversations: ConversationStore;
  /** What each kind of conversation does differently: who a message goes to, what an agent is told. */
  policies: ConversationPolicies;
  timeline: Timeline;
  /** The files people attach to messages. */
  attachments: AttachmentStore;
  /** A way to run a script on a machine other than this one, to put attached files there. */
  shell?: ((machine: MachineRecord) => SshTransport) | undefined;
  /** The model layer, to know whether a session's model takes images; not there until the server is up. */
  models?: (() => KernelModels | undefined) | undefined;
  /** Say that product state moved: these conversations, or all of them. */
  changed: (conversations?: readonly string[] | "all") => void;
  warn: (message: string) => void;
  /** How long a run told to stop has before its reply is stopped without it; 5 seconds. */
  stopGraceMs?: number | undefined;
}

/** A reply that is running: which session runs it, to stop it or to join it. */
interface Running {
  replyId: string;
  handle: SessionHandle;
  /** Who runs it and where, for the words a reply that is stopped without its run says. */
  agent: string;
  machine: { id: string; name: string; remote: boolean };
  /** Settles when the run itself has ended, however it ended. */
  ended: Promise<void>;
  /** Stop waiting for the run: its reply is over, whatever the run does. */
  release: () => void;
  /** The end of the wait for a run that was told to stop. */
  deadline?: ReturnType<typeof setTimeout> | undefined;
}

export class Engine {
  readonly #db: Database;
  readonly #agents: AgentStore;
  readonly #machines: MachineStore;
  readonly #projects: ProjectStore;
  readonly #conversations: ConversationStore;
  readonly #policies: ConversationPolicies;
  readonly #timeline: Timeline;
  readonly #attachments: AttachmentStore;
  readonly #shell: EngineOptions["shell"];
  readonly #models: EngineOptions["models"];
  readonly #changed: EngineOptions["changed"];
  readonly #warn: (message: string) => void;
  readonly #hooks: RunHooks;
  readonly #local: LocalPlace;
  readonly #remote: SessionPlace | undefined;
  readonly #pluginStamp: EngineOptions["pluginStamp"];
  readonly #pluginsRead: EngineOptions["pluginsRead"];
  readonly #sessionStamp: EngineOptions["sessionStamp"];
  readonly #stopGraceMs: number;

  #closing = false;
  /** Replies waiting their turn on a participant's session, by `conversation:agent`. */
  readonly #chains = new Map<string, Promise<unknown>>();
  /** Agent edits and wakes share one settings update at a time on each session. */
  readonly #configuring = new Map<string, Promise<void>>();
  /** The reply each participant's session is running right now. */
  readonly #running = new Map<string, Running>();
  /**
   * Runs whose reply was stopped without them, by `conversation:agent`: they may still be going on
   * the session, and the next run there waits for them a moment first.
   */
  readonly #leftover = new Map<string, Promise<void>>();
  /** What each open session was opened with, to know when it has to be opened again. */
  readonly #opened = new Map<string, string>();
  /** What each session made away from its project's machine is told about that, by `conversation:agent`. */
  readonly #away = new Map<string, string>();

  constructor(options: EngineOptions) {
    this.#db = options.db;
    this.#agents = options.agents;
    this.#machines = options.machines;
    this.#projects = options.projects;
    this.#conversations = options.conversations;
    this.#policies = options.policies;
    this.#timeline = options.timeline;
    this.#attachments = options.attachments;
    this.#shell = options.shell;
    this.#models = options.models;
    this.#changed = options.changed;
    this.#warn = options.warn;
    this.#hooks = options.runHooks ?? {};
    this.#remote = options.remote;
    this.#pluginStamp = options.pluginStamp;
    this.#pluginsRead = options.pluginsRead;
    this.#sessionStamp = options.sessionStamp;
    this.#stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    options.remote?.onLost?.((machineId, reason) =>
      this.#machineLost(machineId, reason),
    );
    this.#local = new LocalPlace({
      opened: this.#opened,
      warn: options.warn,
    });
  }

  /** The session host this engine runs on; set when the conversations plugin is applied. */
  attach(sessions: SessionsService): void {
    this.#local.attach(sessions);
    this.#closing = false;
  }

  /**
   * Stop taking wakes and let the ones in flight go: runs are aborted, and whatever has not
   * ended becomes a failure that says why. Resolves when nothing of this engine is running.
   */
  async detach(): Promise<void> {
    this.#closing = true;
    for (const running of this.#running.values()) {
      clearTimeout(running.deadline);
      running.handle.abort();
    }
    await Promise.allSettled([...this.#chains.values()]);
    this.#local.detach();
  }

  /* ---------------------------------------------------------------- hooks */

  /**
   * Who the agent is in this conversation and what it was told to be — the platform section of its
   * system prompt; the harness's base prompt stays as it is. Read when the session opens, so a
   * change to the agent reaches a session the next time it is opened (see `#syncSession`).
   */
  readonly agentPromptFor = (meta: SessionMeta): string | undefined => {
    if (meta.agentId === undefined) return undefined;
    const agent = this.#agents.get(meta.agentId);
    if (agent === undefined) return undefined;
    const away =
      meta.conversationId === undefined
        ? undefined
        : this.#away.get(keyOf(meta.conversationId, meta.agentId));
    this.#opened.set(meta.id, this.#stamp(agent, away, meta.conversationId));
    return withAway(agentPromptOf(agent, heldIn(meta.conversationId)), away);
  };

  /** What a session's prompt, persona and plugins were read from. */
  #stamp(agent: AgentRecord, away?: string, conversationId?: string): string {
    return `${stampOf(agent)}${this.#pluginStamp?.(agent) ?? ""}${away ?? ""}${
      conversationId === undefined || this.#sessionStamp === undefined
        ? ""
        : this.#sessionStamp(conversationId, agent.id)
    }`;
  }

  /**
   * The machine an agent's sessions in a project are made on: external runtimes use only their
   * pinned machine and never fall back to the project's; built-in `"eta"` agents use their pinned
   * machine when set, else the project's.
   */
  machineFor(
    agent: AgentRecord,
    projectMachineId: string,
  ): MachineRecord | undefined {
    if (isExternalRuntime(agent.runtime)) {
      return agent.machineId === null
        ? undefined
        : this.#machines.get(agent.machineId);
    }
    const pinned =
      agent.machineId === null
        ? undefined
        : this.#machines.get(agent.machineId);
    return pinned ?? this.#machines.get(projectMachineId);
  }

  /**
   * What a session made on another machine than its project's is told about that (the platform
   * section, never the transcript), by `conversation:agent`; read when the session opens.
   */
  #setAway(
    conversationId: string,
    agentId: string,
    away: string | undefined,
  ): void {
    const key = keyOf(conversationId, agentId);
    if (away === undefined) this.#away.delete(key);
    else this.#away.set(key, away);
  }

  /** The tools an agent's session has beyond the harness's: reaching the other members. */
  readonly sessionTools = (input: { meta: SessionMeta }): KernelTool[] => {
    const { agentId, conversationId } = input.meta;
    if (agentId === undefined || conversationId === undefined) return [];
    // A task's or a routine run's session is held in no conversation: it has no members to reach.
    if (heldIn(conversationId) !== "conversation") return [];
    return conversationTools(this, conversationId, agentId);
  };

  /**
   * A run on a member's session that no reply started: the runtime began a turn of its own (Claude
   * Code answering a background task's notification, after the reply that started the task
   * ended). It is said in the conversation like any reply, in a row of its own that works while
   * the run does, and that a message can join or the user can stop.
   *
   * Only a session on an external runtime: an eta session's runs are all started by somebody.
   */
  readonly sessionAttach = (input: ManagedSession): Promise<void> => {
    const { agentId, conversationId, runtime } = input.meta;
    if (
      agentId === undefined ||
      conversationId === undefined ||
      runtime === undefined ||
      heldIn(conversationId) !== "conversation"
    )
      return Promise.resolve();
    kernelOn(input.session.kernel.ctx)("turn:run-start", () => {
      // A reply of the engine's is running on it: the run is that reply's.
      if (this.#closing || this.#running.has(keyOf(conversationId, agentId)))
        return;
      this.#unprompted(input, conversationId, agentId);
    });
    return Promise.resolve();
  };

  /**
   * The row of a run no reply started. It is written at the run's first turn, not its start: a
   * runtime can open a turn that says and does nothing (two notifications answered in the second
   * of two turns), and that is no reply. A run that fails before saying anything still gets one.
   */
  #unprompted(
    managed: ManagedSession,
    conversationId: string,
    agentId: string,
  ): void {
    if (this.#conversations.participant(conversationId, agentId) === undefined)
      return;
    const handle = this.#local.handleOf(managed);
    if (handle === undefined) return;
    const key = keyOf(conversationId, agentId);
    const on = kernelOn(managed.session.kernel.ctx);
    // The run has started: what it writes comes after what the journal holds now.
    const data = { runFrom: lastSeq(managed), unprompted: true };
    const heard = listen(managed);
    let row: MessageView | undefined;
    const write = (
      status: "working" | "failed",
      text = "",
    ): MessageView | undefined => {
      try {
        return this.#timeline.append({
          conversationId,
          kind: "message",
          author: "agent",
          agentId,
          status,
          text,
          data: status === "failed" ? { ...data, code: "run_failed" } : data,
        });
      } catch (error) {
        this.#warn(
          `[eta] a run ${agentId} began on its own in ${conversationId} has no row: ${messageOf(error)}`,
        );
        return undefined;
      }
    };
    let runEnded!: () => void;
    const over = new Promise<void>((resolve) => (runEnded = resolve));
    const offStart = on("turn:start", () => {
      offStart();
      // A reply of the engine's took the session meanwhile: what the run says is that reply's.
      if (this.#running.has(key)) return;
      row = write("working");
      if (row === undefined) return;
      const machine = this.#machines.primary();
      this.#running.set(key, {
        replyId: row.id,
        handle,
        agent: this.#agents.get(agentId)?.name ?? "The agent",
        machine: {
          id: machine?.id ?? "",
          name: machine?.name ?? "",
          remote: false,
        },
        ended: over,
        // Nothing waits for this run: the end below finds its row already over.
        release: () => undefined,
      });
      this.#changed([conversationId]);
    });
    const offEnd = on("turn:run-end", ({ status, error }) => {
      offStart();
      offEnd();
      heard.stop();
      runEnded();
      if (row === undefined) {
        if (status === "failed" && !this.#running.has(key)) {
          write("failed", error ?? "The run failed.");
          this.#changed([conversationId]);
        }
        return;
      }
      const mine = this.#running.get(key);
      if (mine?.replyId === row.id) {
        clearTimeout(mine.deadline);
        this.#running.delete(key);
      }
      const said = heard.said();
      const ended = {
        ...row.data,
        ...(said.activity.length === 0 ? {} : { activity: said.activity }),
      };
      this.#timeline.finish(
        row.id,
        status === "failed"
          ? {
              status: "failed",
              text: error ?? "The run failed.",
              thinking: said.thinking,
              data: { ...ended, code: "run_failed" },
            }
          : {
              status: status === "aborted" ? "stopped" : "done",
              text: said.text,
              thinking: said.thinking,
              data: ended,
            },
      );
      this.#changed([conversationId]);
    });
  }

  /** A session's question turns its reply into one that waits for the user, and back. */
  readonly askObserve = (meta: SessionMeta): AskObserver | undefined => {
    const { agentId, conversationId } = meta;
    if (agentId === undefined || conversationId === undefined) return undefined;
    return (action) => {
      const running = this.#running.get(keyOf(conversationId, agentId));
      if (running === undefined) return;
      const row =
        action === "asked"
          ? this.#timeline.transition(
              running.replyId,
              ["working"],
              "waiting_for_input",
            )
          : this.#timeline.transition(
              running.replyId,
              ["waiting_for_input"],
              "working",
            );
      if (row !== undefined) this.#changed([conversationId]);
    };
  };

  /**
   * The task's session, on the machine and in the directory the task works in: the one this run
   * continues, or a new one made the way a conversation's session is made (the agent's model,
   * persona, instructions, skills, MCP servers and memory) and nothing of what that
   * session remembers: no history, no participant row. Where it lives is the machine's: this
   * process, or a daemon over the link.
   *
   * `key` is what the session is held in and `existing` the session to carry on in
   * (`session-owner.ts`): a run that continues another one passes the key that session was made
   * with, since that is what the machine holding it files its journal, prompt and tools under.
   */
  async openRunSession(input: {
    key: string;
    /** The session to carry on in; null opens a new one. */
    existing: string | null;
    title: string;
    agent: AgentRecord;
    machine: MachineRecord;
    cwd: string;
    /** The session was made: record it before anything else can fail. */
    created: (sessionId: string) => void;
    /** The machine the task's project is on, when the session is made on another one. */
    awayFrom?: MachineRecord | undefined;
  }): Promise<SessionHandle> {
    if (
      isExternalRuntime(input.agent.runtime) &&
      (input.agent.machineId === null ||
        input.machine.id !== input.agent.machineId)
    )
      throw new Error(
        `${input.agent.name} runs on ${input.agent.runtime} and may only run on its pinned machine`,
      );
    const unset = missingModel(input.agent);
    if (unset !== undefined) throw new Error(unset);
    const place = this.#placeOf(input.machine);
    if (place === undefined)
      throw new Error(`Sessions cannot run on ${input.machine.name} yet.`);
    const away =
      input.awayFrom === undefined
        ? undefined
        : awayNote(input.machine.name, input.awayFrom.name, true);
    this.#setAway(input.key, input.agent.id, away);
    await this.#pluginsRead?.();
    return await place.ensure({
      conversation: { id: input.key, name: input.title },
      agent: input.agent,
      machine: input.machine,
      cwd: input.cwd,
      existing: input.existing,
      prompt: withAway(agentPromptOf(input.agent, heldIn(input.key)), away),
      stamp: this.#stamp(input.agent, away, input.key),
      created: input.created,
    });
  }

  #placeOf(machine: MachineRecord): SessionPlace | undefined {
    return machine.kind === "primary"
      ? this.#local
      : machine.kind === "daemon"
        ? this.#remote
        : undefined;
  }

  /* ---------------------------------------------------------------- send */

  /**
   * The user says something. The row is written and the wakes are queued before this returns;
   * the runs happen after it. A `steer` joins an agent that is already answering instead of
   * starting a second reply, and a retry with the same `clientId` is the same message.
   */
  /**
   * Take back a held message. False when it is no longer waiting: a lane took it, and it is a
   * message of the conversation now — recalling then would be deleting what was already said.
   */
  recall(conversationId: string, messageId: string): boolean {
    this.#requireConversation(conversationId);
    const recalled = this.#timeline.recall(messageId);
    if (recalled) this.#changed([conversationId]);
    return recalled;
  }

  /**
   * Put a held message into the turns in flight, as if it had been sent with `steer`. One step on
   * the host rather than a recall and a send from the client: the check that it is still held and
   * taking it out of the queue are one transaction (`Timeline.steerOut`), so a lane that read it
   * first makes this a no-op instead of a second copy of the words.
   *
   * The agents it joins are the ones it was waiting for (`data.woke`) that have a turn to join.
   * None of them (a turn being stopped, a lane between replies) leaves it held. A join that fails
   * because the turn ended under it gets a reply of its own, as `send` does.
   */
  async steerHeld(
    conversationId: string,
    messageId: string,
  ): Promise<SteerHeldResult> {
    const conversation = this.#requireConversation(conversationId);
    const row = this.#timeline.get(messageId);
    const none = { conversationId, joined: [], replies: [], dropped: [] };
    // Another conversation's message is a wrong call, not one a lane got to first.
    if (row !== undefined && row.conversationId !== conversationId)
      throw new Error(`no message ${messageId} in this conversation`);
    if (row === undefined || row.data.held === undefined)
      return { ...none, steered: false, reason: "taken" };
    const waitingFor = Array.isArray(row.data.woke)
      ? (row.data.woke as string[])
      : [];
    const joining = waitingFor.filter((agentId) =>
      this.#joinable(conversationId, agentId),
    );
    if (joining.length === 0)
      return { ...none, steered: false, reason: "idle" };
    const into =
      row.author === "user"
        ? this.#insertTarget(conversationId, joining)
        : undefined;
    const out = this.#timeline.steerOut(messageId, joining, into);
    if (out === undefined) return { ...none, steered: false, reason: "taken" };
    this.#changed([conversationId]);

    const joined: string[] = [];
    const replies: MessageView[] = [];
    for (const agentId of joining) {
      try {
        await this.#join(conversation, agentId, out.message);
        joined.push(agentId);
      } catch (error) {
        this.#warn(`[eta] could not steer ${agentId}: ${String(error)}`);
        replies.push(
          this.#timeline.queueReply(conversationId, agentId, out.message),
        );
      }
    }
    if (joined.length !== joining.length) {
      // Joined by some: still drawn in the message it went into, and the replies of the rest come
      // after it as any queued reply does. Joined by none: a message of its own (`send` too).
      const { into: _into, ...rest } = out.message.data;
      this.#timeline.setData(messageId, {
        ...(joined.length > 0 ? out.message.data : rest),
        woke: [
          ...(out.message.data.woke as string[]),
          ...replies.map((reply) => reply.agentId!),
        ],
        joined,
      });
    }
    for (const reply of replies)
      this.#schedule(conversationId, reply.agentId!, reply.id);
    this.#changed([conversationId]);
    return {
      conversationId,
      steered: joined.length > 0,
      ...(joined.length > 0 ? {} : { reason: "ended" as const }),
      joined,
      message: this.#timeline.get(messageId)!,
      replies: replies.map((reply) => this.#timeline.get(reply.id)!),
      dropped: out.dropped,
    };
  }

  async send(input: {
    conversationId: string;
    text: string;
    /**
     * Only the host may write a Captain or system row; the public conversations.send action
     * never sets either.
     */
    author?: "user" | "captain" | "system" | undefined;
    /** The Captain agent id when `author` is Captain. */
    agentId?: string | undefined;
    /** The discussion root. Captain assignments keep their own root for an independent budget. */
    rootMessageId?: string | undefined;
    /**
     * A host hook after the message and its reply rows are written, but before any reply is
     * scheduled. Captain uses this to persist assignment provenance before a fast target can run.
     */
    dispatched?:
      | ((input: {
          message: MessageView;
          replies: readonly MessageView[];
        }) => void)
      | undefined;
    /**
     * Where the sender folded pastes inside `text` (`ConversationArgs["send"]["blocks"]`). Not
     * looked at: written verbatim into the row's `data.blocks`, for renderers. The prompt the
     * agents read is `text` alone, with the blocks in it as the plain text they stand for.
     */
    blocks?: readonly (readonly [number, number])[] | undefined;
    /**
     * Host-only marks merged into the row's `data`, for renderers (e.g. `captainOutcome`). The
     * public conversations.send action never sets it, and it never reaches the prompt.
     */
    data?: Readonly<Record<string, unknown>> | undefined;
    mentions: readonly string[];
    mode: "queue" | "steer";
    /**
     * A user message whose turns this one is put into (`ConversationArgs["send"]["into"]`): it
     * goes to every agent answering that message right now, whatever `mentions` and `mode` say,
     * and is recorded as `data.into`. With nobody answering it any more, it is sent as `mentions`
     * and `mode: "queue"` would have it, without the mark.
     */
    into?: string | undefined;
    clientId?: string | undefined;
    /** Ids of files uploaded to this conversation (`AttachmentStore.receive`). */
    attachments?: readonly string[] | undefined;
  }): Promise<SendResult> {
    const conversation = this.#requireConversation(input.conversationId);
    let into: string | undefined;
    let { mentions, mode } = input;
    if (input.into !== undefined) {
      const target = this.#timeline.get(input.into);
      if (
        target === undefined ||
        target.conversationId !== conversation.id ||
        target.author !== "user"
      )
        throw new Error(
          `no message ${input.into} of yours in this conversation`,
        );
      const answering = this.answering(conversation.id, target.id);
      if (answering.length > 0) {
        into = target.id;
        mentions = answering;
        mode = "steer";
      } else mode = "queue";
    }
    const text = input.text.trim();
    if (text === "" && (input.attachments?.length ?? 0) === 0)
      throw new Error("conversations.send needs text (or an attachment)");
    if (input.clientId !== undefined) {
      if (input.clientId === "" || input.clientId.length > 128)
        throw new Error("clientId must be 1 to 128 characters");
      const earlier = this.#timeline.get(input.clientId);
      if (earlier !== undefined) {
        if (
          earlier.conversationId !== conversation.id ||
          earlier.author !== (input.author ?? "user")
        )
          throw new Error(`clientId ${input.clientId} is taken`);
        return this.#sent(earlier);
      }
    }

    const id = input.clientId ?? crypto.randomUUID();
    const files = this.#attachments.check(
      { conversationId: conversation.id },
      input.attachments ?? [],
    );
    const planned: { agentId: string; join: boolean }[] = [];
    const replies: MessageView[] = [];
    let message!: MessageView;
    let nobody = false;
    this.#db.transaction(() => {
      const routing = this.#policies.of(conversation.kind).route({
        members: this.#conversations
          .participants(conversation.id)
          .map((participant) => participant.agentId),
        mentions,
        steward: conversation.stewardId,
      });
      nobody = routing.targets.length === 0;
      for (const agentId of routing.targets) {
        planned.push({
          agentId,
          join: mode === "steer" && this.#joinable(conversation.id, agentId),
        });
      }
      // A plain steer (`/steer`, the TUI's Tab) is drawn where an Insert is: in the message whose
      // turns it joins.
      if (into === undefined && (input.author ?? "user") === "user")
        into = this.#insertTarget(
          conversation.id,
          planned.filter((p) => p.join).map((p) => p.agentId),
        );
      /*
       * A message nobody can take yet is not a message of the conversation yet: every target still
       * has a reply of its own in flight, so nothing would read it until one of them finished. It
       * is written as `queued` — the same status a reply waits in — and the lane that picks it up
       * turns it into a message. Sending two in a row while the first is unanswered used to put
       * both in the transcript and leave the second one unrecallable.
       */
      // The client tells it the same way as it sends (`heldFor`), and shows the message queued.
      const held =
        heldFor(
          routing.targets,
          (agentId) =>
            !planned.some(
              (target) => target.agentId === agentId && target.join,
            ) && this.#chains.has(keyOf(conversation.id, agentId)),
        ).length > 0;
      message = this.#timeline.append({
        id,
        conversationId: conversation.id,
        kind: "message",
        author: input.author ?? "user",
        agentId: input.agentId,
        text,
        mentions: routing.named,
        rootMessageId: input.rootMessageId ?? id,
        data: {
          ...input.data,
          // Held: written, but not a message of the conversation yet — see `held` above. `status`
          // is left alone on purpose: `queued` means "a reply waiting to run", and every in-flight
          // query in the store would pick a user row up as one.
          ...(held ? { held: true } : {}),
          woke: planned.filter((p) => !p.join).map((p) => p.agentId),
          joined: planned.filter((p) => p.join).map((p) => p.agentId),
          ...(into === undefined ? {} : { into }),
          // Where the sender's folded pastes sit in `text`, kept as sent (see `send`'s input).
          ...(input.blocks && input.blocks.length > 0
            ? { blocks: input.blocks }
            : {}),
          ...(files.length === 0
            ? {}
            : { attachments: files.map(attachmentView) }),
        },
      });
      this.#attachments.claim(
        files.map((file) => file.id),
        id,
      );
      for (const target of planned) {
        if (!target.join)
          replies.push(
            this.#timeline.queueReply(conversation.id, target.agentId, message),
          );
      }
    })();

    const joined: string[] = [];
    for (const target of planned) {
      if (!target.join) continue;
      try {
        await this.#join(conversation, target.agentId, message);
        joined.push(target.agentId);
      } catch (error) {
        // It could not join (the turn ended under it, the session would not take it): answer it
        // as a reply of its own instead, so the words are not lost.
        this.#warn(`[eta] could not steer ${target.agentId}: ${String(error)}`);
        replies.push(
          this.#timeline.queueReply(conversation.id, target.agentId, message),
        );
      }
    }
    if (joined.length !== planned.filter((p) => p.join).length) {
      // Joined by some, it stays in the message it was put into and the replies of the rest come
      // after it, as `steerHeld` has it. Joined by none, it is not part of that message any more:
      // it reads as its own message, with its replies under it.
      const { into: _into, ...rest } = message.data;
      this.#timeline.setData(message.id, {
        ...(joined.length > 0 ? message.data : rest),
        woke: replies.map((reply) => reply.agentId),
        joined,
      });
    }
    input.dispatched?.({
      message: this.#timeline.get(message.id)!,
      replies: [...replies],
    });
    for (const reply of replies)
      this.#schedule(conversation.id, reply.agentId!, reply.id);

    this.#changed([conversation.id]);
    return {
      message: this.#timeline.get(message.id)!,
      replies: replies.map((reply) => this.#timeline.get(reply.id)!),
      joined,
      nobody,
    };
  }

  /**
   * The agents answering a message right now, with a turn that can be steered: their reply in
   * flight is the one that message woke (`replyToId`), in the order they were woken.
   */
  answering(conversationId: string, messageId: string): string[] {
    return this.#timeline
      .repliesTo(messageId)
      .flatMap((reply) =>
        reply.agentId !== null &&
        this.#running.get(keyOf(conversationId, reply.agentId))?.replyId ===
          reply.id &&
        this.#joinable(conversationId, reply.agentId)
          ? [reply.agentId]
          : [],
      );
  }

  /**
   * The user message a steer into `agentIds`' turns is drawn in (`data.into`), as an Insert from
   * that message's popover is: the message each turn answers — its reply's root, so a reply an
   * @mention woke counts as answering the message that started the exchange. A root that was
   * itself drawn in another message stands for that one. Turns answering different messages put
   * it in the latest of them: the one nearest where it was written, so it does not jump up the
   * transcript (or out of the loaded part of it). Undefined when no turn answers a user message.
   */
  #insertTarget(
    conversationId: string,
    agentIds: readonly string[],
  ): string | undefined {
    let target: MessageView | undefined;
    for (const agentId of agentIds) {
      const running = this.#running.get(keyOf(conversationId, agentId));
      const reply =
        running === undefined ? undefined : this.#timeline.get(running.replyId);
      let root =
        reply?.rootMessageId == null
          ? undefined
          : this.#timeline.get(reply.rootMessageId);
      for (
        let hops = 0;
        hops < 4 && typeof root?.data.into === "string";
        hops++
      )
        root = this.#timeline.get(root.data.into);
      if (
        root === undefined ||
        root.conversationId !== conversationId ||
        root.author !== "user" ||
        root.data.held !== undefined
      )
        continue;
      if (target === undefined || root.seq > target.seq) target = root;
    }
    return target?.id;
  }

  /** Whether there is a turn to steer: the member's reply is running, and is not being stopped. */
  #joinable(conversationId: string, agentId: string): boolean {
    const running = this.#running.get(keyOf(conversationId, agentId));
    return (
      running !== undefined &&
      running.handle.running &&
      this.#timeline.get(running.replyId)?.status !== "stopping"
    );
  }

  /** What a send did, read back from the rows it wrote: a retried send answers the same. */
  #sent(message: MessageView): SendResult {
    const replies = this.#timeline.repliesTo(message.id);
    const joined = Array.isArray(message.data.joined)
      ? (message.data.joined as string[])
      : [];
    return {
      message,
      replies,
      joined,
      nobody: replies.length === 0 && joined.length === 0,
    };
  }

  /**
   * Put a message into the turn an agent is already running. It is told what it has not seen, like
   * any wake, and the words arrive at the turn's next boundary.
   */
  async #join(
    conversation: ConversationRecord,
    agentId: string,
    message: MessageView,
  ): Promise<void> {
    const participant = this.#conversations.participant(
      conversation.id,
      agentId,
    );
    const running = this.#running.get(keyOf(conversation.id, agentId));
    if (running === undefined || participant?.sessionId == null)
      throw new Error("no session to join");
    const held = this.#conversations.ofSession(participant.sessionId);
    const machine =
      held === undefined ? undefined : this.#machines.get(held.machineId);
    if (machine === undefined) throw new Error("no session to join");
    const told = await this.#briefingFor(
      conversation,
      participant,
      message,
      running.handle,
      machine,
    );
    // The briefing waits (on files, on the model), and the turn may end meanwhile. A steer into a
    // session with no turn would start a run nobody waits for, so its answer would reach no
    // reply. Whether there is a turn is the session's machine's to say (a daemon's turn can end
    // while the word of it is still on the link), so the steer is sent as one that only a run in
    // flight takes; a refusal throws, and the caller gives the message a reply of its own.
    await running.handle.steer(told.text, told.images);
    this.#conversations.setSeen(conversation.id, agentId, told.seen);
  }

  /* ---------------------------------------------------------------- mention */

  /**
   * An agent names other members from inside its reply. It costs one of the five wakes its user
   * message may start; the answer is what the agent reads back as the tool's result.
   */
  mention(input: {
    conversationId: string;
    agentId: string;
    names: readonly string[];
    text: string;
  }): { ok: boolean; text: string } {
    const running = this.#running.get(
      keyOf(input.conversationId, input.agentId),
    );
    const reply =
      running === undefined ? undefined : this.#timeline.get(running.replyId);
    if (reply?.rootMessageId == null) {
      return {
        ok: false,
        text: "You can only mention other members while you are answering a message.",
      };
    }
    const members = this.#conversations
      .participants(input.conversationId)
      .flatMap((participant) => {
        const agent = this.#agents.get(participant.agentId);
        return agent === undefined
          ? []
          : [{ id: agent.id, name: agent.name, systemRole: agent.systemRole }];
      });
    const { ids, unknown } = resolveNamed(input.names, members, input.agentId);
    if (ids.length === 0) {
      const others = members
        .filter((member) => member.id !== input.agentId)
        .map((member) => member.name);
      return {
        ok: false,
        text:
          `Nobody was woken: ${unknown.join(", ") || "no one"} is not another member of this conversation. ` +
          `The other members are: ${others.join(", ") || "(none)"}.`,
      };
    }

    const root = reply.rootMessageId;
    let verdict: ReturnType<typeof judgeMention> = "capped";
    const woken: MessageView[] = [];
    this.#db.transaction(() => {
      const message = this.#timeline.append({
        conversationId: input.conversationId,
        kind: "mention",
        author: "agent",
        agentId: input.agentId,
        text: input.text,
        mentions: ids,
        rootMessageId: root,
      });
      verdict = judgeMention(
        this.#timeline.countMentions(input.conversationId, root),
      );
      if (verdict === "capped") return;
      for (const id of ids)
        woken.push(
          this.#timeline.queueReply(input.conversationId, id, message),
        );
      if (verdict === "wake_last") {
        this.#timeline.system(
          input.conversationId,
          `This thread has used its ${WAKE_BUDGET} wake-ups; later mentions stay in the conversation but wake nobody until the user writes again.`,
          { event: "wake_budget", budget: WAKE_BUDGET },
        );
      }
    })();
    for (const reply of woken)
      this.#schedule(input.conversationId, reply.agentId!, reply.id);
    this.#changed([input.conversationId]);

    const names = ids.map((id) => nameIn(members, id)).join(", ");
    if (verdict === "capped") {
      return {
        ok: true,
        text: `Your message is in the conversation, but it woke nobody: this thread has used its ${WAKE_BUDGET} wake-ups.`,
      };
    }
    const unheard =
      unknown.length === 0 ? "" : ` (${unknown.join(", ")} is not a member.)`;
    return {
      ok: true,
      text: `Woke ${names}; they will answer in the conversation.${unheard}${verdict === "wake_last" ? ` That was the last wake-up this thread gets.` : ""}`,
    };
  }

  /**
   * An image of this conversation for the `read_image` tool. `ref` is an attachment id or the
   * path the agent was told, which starts with the id; only this conversation's files can be named.
   */
  async image(
    conversationId: string,
    agentId: string,
    ref: string,
  ): Promise<{ mime: string; dataBase64: string }> {
    const running = this.#running.get(keyOf(conversationId, agentId));
    const limits =
      running === undefined
        ? undefined
        : await this.#imageLimits(running.handle);
    if (limits === undefined)
      throw new Error("The model you run on does not support images.");
    const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.exec(
      ref.split(/[\\/]/).pop()!,
    )?.[0];
    const record = id === undefined ? undefined : this.#attachments.get(id);
    if (record === undefined || record.conversationId !== conversationId)
      throw new Error(`No such attachment in this conversation: ${ref}`);
    return await this.#attachments.image(record, limits);
  }

  /** The room an agent is in, as the `conversation_info` tool tells it. */
  describe(conversationId: string, me: string): string {
    const conversation = this.#requireConversation(conversationId);
    const project = this.#projects.get(conversation.projectId);
    const steward = conversation.stewardId;
    const participants = this.#conversations.participants(conversationId);
    const members = participants.map((participant) => {
      const name = this.#agents.get(participant.agentId)?.name ?? "(deleted)";
      const marks = [
        participant.agentId === me ? "you" : undefined,
        participant.agentId === steward ? "steward" : undefined,
      ].filter((mark) => mark !== undefined);
      return marks.length === 0 ? name : `${name} (${marks.join(", ")})`;
    });
    const described = this.#policies
      .of(conversation.kind)
      .describe(conversation);
    return [
      `Conversation: ${conversation.name}${described.note === undefined ? "" : ` (${described.note})`}`,
      `Project: ${project === undefined ? "(gone)" : `${project.name}, at ${project.path}`}`,
      `Goal: ${conversation.goal === "" ? "(not set)" : conversation.goal}`,
      `Decided so far: ${conversation.decided === "" ? "(nothing yet)" : conversation.decided}`,
      `Members: ${members.join(", ")}`,
      ...described.lines,
    ].join("\n");
  }

  /* ------------------------------------------------------------- context */

  /**
   * Start every member's context over. After many compactions a session's context decays, and
   * the way out is a new session. Refused while a reply is in flight: the run holds its session.
   * What the members are told next is only what is said after this; the conversation's goal and
   * decisions still reach them through `conversation_info`.
   */
  resetContext(conversationId: string): number {
    this.#requireConversation(conversationId);
    if (
      this.#timeline.active(conversationId).length > 0 ||
      [...this.#running.keys()].some((key) =>
        key.startsWith(`${conversationId}:`),
      )
    )
      throw new Error(
        "a reply is still running here; stop it before clearing the context",
      );
    const released = this.#conversations.clearSessions(conversationId);
    this.#changed([conversationId]);
    return released.length;
  }

  /* ---------------------------------------------------------------- stop */

  /** Stop one reply, or every reply in flight in a conversation. Returns the rows as they now read. */
  stop(conversationId: string, messageId?: string): MessageView[] {
    this.#requireConversation(conversationId);
    const rows =
      messageId === undefined
        ? this.#timeline.active(conversationId)
        : [this.#timeline.get(messageId)].filter(
            (row): row is MessageView =>
              row !== undefined && row.conversationId === conversationId,
          );
    const stopped = rows.flatMap((row) => this.#stopRow(row) ?? []);
    if (stopped.length > 0) this.#changed([conversationId]);
    return stopped;
  }

  /** Stop everything an agent has in flight, everywhere (it is being deleted). */
  stopAgent(agentId: string): void {
    const touched = new Set<string>();
    for (const row of this.#timeline.active()) {
      if (row.agentId !== agentId) continue;
      if (this.#stopRow(row) !== undefined) touched.add(row.conversationId);
    }
    if (touched.size > 0) this.#changed([...touched]);
  }

  /** Save an agent edit and its pending session settings in one transaction. */
  saveAgent(
    before: AgentRecord,
    patch: Partial<AgentInput>,
    options: { reapplyModel?: boolean } = {},
  ): { agent: AgentRecord; sessions: string[] } {
    return this.#db.transaction(() => {
      const agent = this.#agents.update(before.id, patch)!;
      if (agent.runtime !== before.runtime) {
        // The next wake opens sessions on the new runtime with its own settings.
        this.#conversations.queueSessionSettings(agent.id, null);
        return { agent, sessions: [] };
      }
      const modelChanged =
        agent.model !== before.model || options.reapplyModel === true;
      const levelChanged = agent.thinkingLevel !== before.thinkingLevel;
      if (!modelChanged && !levelChanged) return { agent, sessions: [] };
      this.#conversations.queueSessionSettings(agent.id, {
        ...(modelChanged ? { model: agent.model } : {}),
        ...(levelChanged ? { thinkingLevel: agent.thinkingLevel } : {}),
      });
      return { agent, sessions: this.#conversations.sessionsOfAgent(agent.id) };
    })();
  }

  /** Idle sessions take an agent edit immediately. A wake retries what is still pending. */
  async applySettings(sessions: readonly string[]): Promise<void> {
    for (const sessionId of sessions) {
      const held = this.#conversations.ofSession(sessionId);
      const machine =
        held === undefined ? undefined : this.#machines.get(held.machineId);
      const place = machine === undefined ? undefined : this.#placeOf(machine);
      if (machine !== undefined && place !== undefined)
        await this.#applyPendingSettings(sessionId, machine, place);
    }
  }

  #applyPendingSettings(
    sessionId: string,
    machine: MachineRecord,
    place: SessionPlace,
  ): Promise<void> {
    const previous = this.#configuring.get(sessionId) ?? Promise.resolve();
    const configure = () => this.#configurePending(sessionId, machine, place);
    const next = previous.then(configure, configure);
    this.#configuring.set(sessionId, next);
    return next.finally(() => {
      if (this.#configuring.get(sessionId) === next)
        this.#configuring.delete(sessionId);
    });
  }

  async #configurePending(
    sessionId: string,
    machine: MachineRecord,
    place: SessionPlace,
  ): Promise<void> {
    let pending = this.#conversations.pendingSessionSettings(sessionId);
    while (pending !== undefined) {
      const {
        saved,
        settings: { model, ...remaining },
      } = pending;
      try {
        if (model !== undefined) {
          if (model !== null)
            await place.configure(sessionId, machine, { model });
        } else {
          await place.configure(sessionId, machine, remaining);
        }
        // A failed thinking-level change should not replay a model switch that already worked.
        this.#conversations.finishSessionSettings(
          sessionId,
          saved,
          model === undefined ? {} : remaining,
        );
      } catch (error) {
        this.#warn(
          `[eta] could not update session ${sessionId} to the edited agent: ${messageOf(error)}`,
        );
      }
      pending = this.#conversations.pendingSessionSettings(sessionId);
      // A busy session or an unreachable machine gets another chance on its next wake.
      if (pending?.saved === saved) return;
    }
  }

  /** Stop one member's replies in one conversation (it is being taken out). */
  stopMember(conversationId: string, agentId: string): void {
    for (const row of this.#timeline.active(conversationId)) {
      if (row.agentId === agentId) this.#stopRow(row);
    }
  }

  /**
   * A reply that has not started simply never will; one that is running is told to stop and ends
   * as `stopped` when the run gives up. The stop is the user's, not the run's: a run that has not
   * ended within the grace, or whose machine could not be told, is let go of and its reply ends
   * as stopped anyway, saying why. Stopping a reply that is already stopping does that at once.
   */
  #stopRow(row: MessageView): MessageView | undefined {
    if (row.status === "queued") {
      return this.#timeline.finish(row.id, { status: "stopped", text: "" });
    }
    const running =
      row.agentId === null
        ? undefined
        : this.#running.get(keyOf(row.conversationId, row.agentId));
    const mine = running?.replyId === row.id ? running : undefined;
    if (row.status === "stopping") {
      return this.#letGo(
        row.id,
        "stop_unanswered",
        mine === undefined ? undefined : unanswered(mine),
      );
    }
    if (row.status !== "working" && row.status !== "waiting_for_input")
      return undefined;
    // Nothing runs it (its run is gone): there is nothing to wait for.
    if (mine === undefined) return this.#letGo(row.id, "stop_unanswered");
    const stopping = this.#timeline.transition(
      row.id,
      ["working", "waiting_for_input"],
      "stopping",
    );
    if (stopping === undefined) return undefined;
    clearTimeout(mine.deadline);
    mine.deadline = setTimeout(() => {
      if (
        this.#letGo(row.id, "stop_unanswered", unanswered(mine)) !== undefined
      )
        this.#changed([row.conversationId]);
    }, this.#stopGraceMs);
    mine.handle.stop().catch((error: unknown) => {
      this.#warn(`[eta] could not stop ${mine.handle.id}: ${messageOf(error)}`);
      const why = messageOf(error);
      const note = `Could not tell ${mine.machine.name} to stop ${mine.agent} (${why}), so it was stopped here.`;
      if (
        this.#letGo(row.id, "stop_unreachable", note, { stopError: why }) !==
        undefined
      )
        this.#changed([row.conversationId]);
    });
    return stopping;
  }

  /**
   * End a reply as stopped without waiting for its run any longer, and say why. The run, if there
   * is one, is let go of: what it says later is not written, and the session's next run waits for
   * it a moment before it starts. Undefined when the reply had already ended.
   */
  #letGo(
    replyId: string,
    code: string,
    note?: string,
    extra?: Record<string, unknown>,
  ): MessageView | undefined {
    const row = this.#timeline.get(replyId);
    if (row === undefined) return undefined;
    const ended = this.#timeline.finish(replyId, {
      status: "stopped",
      text: row.text,
      thinking: row.thinking,
      data: {
        ...row.data,
        ...extra,
        code,
        ...(note === undefined ? {} : { stopNote: note }),
      },
    });
    if (ended !== undefined) this.#release(row);
    return ended;
  }

  /** Stop waiting for the run of a reply that is over: the session's next run waits for it instead. */
  #release(row: MessageView): void {
    if (row.agentId === null) return;
    const key = keyOf(row.conversationId, row.agentId);
    const running = this.#running.get(key);
    if (running?.replyId !== row.id) return;
    clearTimeout(running.deadline);
    this.#running.delete(key);
    this.#leftover.set(key, running.ended);
    void running.ended.then(() => {
      if (this.#leftover.get(key) === running.ended) this.#leftover.delete(key);
    });
    running.release();
  }

  /**
   * A machine's link went down: every reply running there ends now, saying so. One being stopped
   * is stopped; one still working failed, since what it did there is unknown. What the machine may
   * still be running is stopped when it is back (`RemotePlace`).
   */
  #machineLost(machineId: string, reason: string): void {
    const touched = new Set<string>();
    for (const running of [...this.#running.values()]) {
      if (running.machine.id !== machineId) continue;
      const row = this.#timeline.get(running.replyId);
      if (row === undefined) continue;
      const lost = `The link to ${running.machine.name} was lost (${reason})`;
      if (row.status === "stopping") {
        this.#letGo(row.id, "link_lost", `${lost}, so it was stopped here.`);
      } else {
        const failed = this.#timeline.finish(row.id, {
          status: "failed",
          text: `${lost} while this reply was running, so what it did there is unknown. Nothing was run again.`,
          data: { ...row.data, code: "link_lost" },
        });
        if (failed === undefined) continue;
        this.#release(row);
      }
      touched.add(row.conversationId);
    }
    if (touched.size > 0) this.#changed([...touched]);
  }

  /* ---------------------------------------------------------------- running */

  /** Queue a reply behind whatever its participant's session is doing. */
  #schedule(conversationId: string, agentId: string, replyId: string): void {
    const key = keyOf(conversationId, agentId);
    const next = (this.#chains.get(key) ?? Promise.resolve())
      .then(() => this.#execute(replyId))
      .catch((error: unknown) => {
        this.#warn(`[eta] a reply could not run: ${String(error)}`);
      });
    this.#chains.set(key, next);
    // A participant that has answered everything leaves no promise behind.
    void next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key);
    });
  }

  async #execute(replyId: string): Promise<void> {
    const reply = this.#timeline.get(replyId);
    // Stopped before its turn, or gone with its conversation: nothing to run.
    if (reply === undefined || reply.status !== "queued") return;
    // The message this reply answers reached its lane, so it is a message now. Idempotent: a
    // message that was never held is not `queued` and this touches nothing.
    if (reply.rootMessageId !== null)
      this.#timeline.deliver(reply.rootMessageId);
    const { conversationId } = reply;
    const fail = (code: string, text: string): void => {
      this.#timeline.finish(replyId, {
        status: "failed",
        text,
        data: { ...reply.data, code },
      });
      this.#changed([conversationId]);
    };
    if (this.#closing) return fail("restart", RESTART_TEXT);

    const conversation = this.#conversations.get(conversationId);
    const agent = this.#agents.get(reply.agentId ?? "");
    const participant =
      conversation === undefined || agent === undefined
        ? undefined
        : this.#conversations.participant(conversation.id, agent.id);
    if (
      conversation === undefined ||
      agent === undefined ||
      participant === undefined
    )
      return fail("gone", "The agent is no longer part of this conversation.");
    const project = this.#projects.get(conversation.projectId);
    const home =
      project === undefined ? undefined : this.#machines.get(project.machineId);
    if (project === undefined || home === undefined)
      return fail("unavailable", "The conversation's project is gone.");
    const boundProblem = externalAgentProjectError(
      agent,
      project,
      this.#machines,
    );
    if (boundProblem !== undefined) return fail("unavailable", boundProblem);
    // An agent pinned to a machine answers from there, wherever the project is: in its home
    // directory, told (out of the transcript's sight) that the project's paths are another
    // machine's.
    const machine = this.machineFor(agent, project.machineId);
    if (machine === undefined)
      return fail(
        "unavailable",
        `${agent.name}'s machine (${agent.machineId ?? "unassigned"}) is not registered.`,
      );
    const elsewhere = machine.id !== home.id;
    const cwd = elsewhere ? homeOf(machine) : project.path;
    const away = elsewhere
      ? awayNote(machine.name, home.name, false)
      : undefined;
    const place = this.#placeOf(machine);
    if (place === undefined) {
      return fail("unavailable", `Sessions cannot run on ${machine.name} yet.`);
    }
    const trigger = this.#timeline.get(reply.replyToId ?? "");
    if (trigger === undefined)
      return fail("gone", "The message this reply answers is gone.");
    const unset = missingModel(agent);
    if (unset !== undefined) return fail("unavailable", unset);
    this.#setAway(conversation.id, agent.id, away);

    let handle: SessionHandle;
    try {
      await this.#pluginsRead?.();
      handle = await place.ensure({
        conversation,
        agent,
        machine,
        cwd,
        // A session lives on the machine it was made on: one made elsewhere (the agent was
        // pinned, or moved) is not reached for here, and a new one is made.
        existing:
          (participant.machineId ?? home.id) === machine.id
            ? participant.sessionId
            : null,
        prompt: withAway(agentPromptOf(agent), away),
        stamp: this.#stamp(agent, away, conversation.id),
        created: (id) =>
          this.#conversations.setSession(
            conversation.id,
            agent.id,
            id,
            machine.id,
          ),
      });
    } catch (error) {
      return fail("unavailable", explainRunError(messageOf(error)));
    }
    // A stop that arrived while the session was being made.
    if (this.#timeline.get(replyId)?.status !== "queued") return;
    // A run whose reply was stopped without it may still be going on this session. It was told to
    // stop; it gets one more telling and a moment. A session still busy with it cannot take the
    // words: they would wait behind a run nobody waits for.
    const key = keyOf(conversationId, agent.id);
    const leftover = this.#leftover.get(key);
    if (leftover !== undefined) {
      handle.abort();
      if (!(await settlesWithin(leftover, this.#stopGraceMs)))
        return fail(
          "still_running",
          `${agent.name} is still busy with the reply you stopped, so this message was not given to it. Send it again in a moment.`,
        );
      if (this.#timeline.get(replyId)?.status !== "queued") return;
    }

    await this.#applyPendingSettings(handle.id, machine, place);
    if (this.#timeline.get(replyId)?.status !== "queued") return;
    // What it is told is settled before the row says it is working, so one push carries both.
    const told = await this.#briefingFor(
      conversation,
      this.#conversations.participant(conversationId, agent.id) ?? participant,
      trigger,
      handle,
      machine,
    );
    const info: RunInfo = {
      conversationId,
      agentId: agent.id,
      replyId,
      sessionId: handle.id,
      cwd: machine.kind === "primary" ? cwd : undefined,
      told: told.text,
      trigger,
    };
    const extra = await this.#beforeRun(info);
    const runFrom = await this.#lastSeq(handle);
    // A stop that arrived while the hook was asking.
    if (this.#timeline.get(replyId)?.status !== "queued") return;
    const prompt = extra === undefined ? told.text : `${extra}\n\n${told.text}`;
    this.#conversations.setSeen(conversationId, agent.id, told.seen);
    let release!: () => void;
    const released = new Promise<undefined>(
      (resolve) => (release = () => resolve(undefined)),
    );
    const running: Running = {
      replyId,
      handle,
      agent: agent.name,
      machine: {
        id: machine.id,
        name: machine.name,
        remote: machine.kind !== "primary",
      },
      ended: Promise.resolve(),
      release,
    };
    this.#running.set(key, running);
    // The row says where the run starts in the session. The page cannot tell from the session: its
    // view is sent on a pace of its own, so for a moment after this push the newest things the
    // view holds are still the last run's.
    if (runFrom !== undefined)
      this.#timeline.setData(replyId, { ...reply.data, runFrom });
    this.#timeline.transition(replyId, ["queued"], "working");
    this.#changed([conversationId]);

    try {
      const run = handle.run(prompt, () => !this.#closing, told.images);
      running.ended = run.then(
        () => undefined,
        () => undefined,
      );
      // The reply is let go of when the run would not stop (`#letGo`): it is over, and what the run
      // says when it does end is nobody's.
      const result = await Promise.race([run, released]);
      if (result === undefined) return;
      // What the run did with tools, and the order of its steps, stay on the row, so the page draws
      // it after the run as it did during it.
      const activity = {
        ...(result.activity === undefined ? {} : { activity: result.activity }),
        ...(result.process === undefined ? {} : { process: result.process }),
      };
      if (this.#closing && result.status === "aborted") {
        this.#timeline.finish(replyId, {
          status: "failed",
          text: result.text || RESTART_TEXT,
          thinking: result.thinking,
          data: { ...reply.data, ...activity, code: "restart" },
        });
      } else if (result.status === "failed") {
        this.#timeline.finish(replyId, {
          status: "failed",
          text:
            result.error === undefined
              ? "The run failed."
              : explainRunError(result.error),
          thinking: result.thinking,
          data: { ...reply.data, ...activity, code: "run_failed" },
        });
      } else {
        this.#timeline.finish(replyId, {
          status: result.status === "aborted" ? "stopped" : "done",
          text: result.text,
          thinking: result.thinking,
          data: { ...reply.data, ...activity },
        });
      }
    } catch (error) {
      // A link cut under the run: what the machine did is unknown, and nothing is run again.
      const lost =
        error instanceof LinkError &&
        (error.kind === "lost" || error.kind === "timeout");
      this.#timeline.finish(replyId, {
        status: "failed",
        text: lost
          ? `The link to ${machine.name} failed while this reply was running, so what it did there is unknown. Nothing was run again. (${error.message})`
          : explainRunError(messageOf(error)),
        data: { ...reply.data, code: lost ? "link_lost" : "run_failed" },
      });
    } finally {
      clearTimeout(running.deadline);
      if (this.#running.get(key) === running) this.#running.delete(key);
      this.#changed([conversationId]);
      this.#afterRun(info);
    }
  }

  /** Where the session stands before a run; a machine that cannot say does not stop the run. */
  async #lastSeq(handle: SessionHandle): Promise<number | undefined> {
    try {
      return await handle.lastSeq();
    } catch (error) {
      this.#warn(`[eta] no position for ${handle.id}: ${messageOf(error)}`);
      return undefined;
    }
  }

  /** The hook's words for this run; a hook that fails or says nothing leaves the run as it was. */
  async #beforeRun(info: RunInfo): Promise<string | undefined> {
    try {
      const extra = await this.#hooks.beforeRun?.(info);
      return extra === undefined || extra.trim() === "" ? undefined : extra;
    } catch (error) {
      this.#warn(`[eta] beforeRun failed: ${messageOf(error)}`);
      return undefined;
    }
  }

  /** Tell the hook how the reply ended, without waiting for it or letting it fail the reply. */
  #afterRun(info: RunInfo): void {
    const ended = this.#timeline.get(info.replyId);
    if (ended === undefined || this.#hooks.afterRun === undefined) return;
    const hook = this.#hooks.afterRun;
    void Promise.resolve()
      .then(() => hook({ ...info, status: ended.status, said: ended.text }))
      .catch((error: unknown) =>
        this.#warn(`[eta] afterRun failed: ${messageOf(error)}`),
      );
  }

  /**
   * What the agent is told for this wake, and how far that brings it. Files that came with the
   * messages it is told about are put where it can open them (on its session's machine) and named
   * under their messages; the images among them also go in as image input when its model takes
   * them.
   */
  async #briefingFor(
    conversation: ConversationRecord,
    participant: { agentId: string; lastSeq: number },
    trigger: MessageView,
    handle: SessionHandle,
    machine: MachineRecord,
  ) {
    const rows = this.#timeline.after(conversation.id, participant.lastSeq);
    const shown = rows.some((row) => row.id === trigger.id)
      ? rows
      : [...rows, trigger];
    const files = new Map<string, AttachmentRecord[]>();
    for (const row of shown) {
      const carried = this.#attachments.carried(row.data);
      if (carried.length > 0) files.set(row.id, carried);
    }
    const lines = new Map<string, string[]>();
    let images: PromptImage[] = [];
    if (files.size > 0) {
      const handed = await this.filesFor(
        [...files.values()].flat(),
        handle,
        machine,
      );
      for (const [rowId, carried] of files)
        lines.set(
          rowId,
          carried.map((file) => handed.lines.get(file.id) ?? ""),
        );
      images = handed.images;
    }
    return {
      ...briefing({
        conversation: conversation.name,
        me: participant.agentId,
        lastSeq: participant.lastSeq,
        rows,
        trigger,
        nameOf: (message) => this.#nameOf(message),
        agentName: (agentId) =>
          this.#agents.get(agentId)?.name ?? "another agent",
        filesOf: (message) => lines.get(message.id) ?? [],
      }),
      images,
    };
  }

  /**
   * Files that came with what a session is about to be told, as it can take them: put where it
   * can open them (on its machine), each named in a line for the text, and the images among them
   * as image input when its model takes them. `unseen` says there were images its model was not
   * shown. How a conversation's briefing hands files over (`#briefingFor`), for a task's comment.
   */
  async filesFor(
    files: readonly AttachmentRecord[],
    handle: SessionHandle,
    machine: MachineRecord,
  ): Promise<{
    lines: Map<string, string>;
    images: PromptImage[];
    unseen: boolean;
  }> {
    const lines = new Map<string, string>();
    if (files.length === 0) return { lines, images: [], unseen: false };
    const placed = await this.#place(files, machine);
    const limits = await this.#imageLimits(handle);
    const prepared =
      limits === undefined
        ? { images: [], omitted: new Map<string, string>() }
        : await this.#attachments.images(
            files.filter((file) => placed.paths.has(file.id)),
            limits,
          );
    let unseen = false;
    for (const file of files) {
      const path = placed.paths.get(file.id);
      const image = file.contentType.startsWith("image/");
      const note =
        path === undefined
          ? undefined
          : !image
            ? undefined
            : limits === undefined
              ? "the model you run on does not support images"
              : prepared.omitted.get(file.id);
      if (note !== undefined) unseen = true;
      lines.set(
        file.id,
        path === undefined
          ? `[attachment ${file.name} could not be put where you can read it: ${placed.failed.get(file.id) ?? "unknown error"}]`
          : `[attachment: ${path} (${file.contentType}, ${file.size} bytes)${
              note === undefined ? "" : `; not shown: ${note}`
            }]`,
      );
    }
    return { lines, images: prepared.images, unseen };
  }

  /** Put the files where the conversation's sessions can open them; a machine out of reach fails them all. */
  async #place(files: readonly AttachmentRecord[], machine: MachineRecord) {
    try {
      return await this.#attachments.deliver(
        files,
        this.#transportFor(machine),
      );
    } catch (error) {
      const failed = new Map(files.map((file) => [file.id, messageOf(error)]));
      return { paths: new Map<string, string>(), failed };
    }
  }

  /** How to run a script on the machine a session is on; undefined for this machine. */
  #transportFor(machine: MachineRecord): SshTransport | undefined {
    if (machine.kind === "primary") return undefined;
    if (this.#shell === undefined)
      throw new Error(`files cannot be sent to ${machine.name} from here`);
    return this.#shell(machine);
  }

  /** The image limits of the session's model, or undefined when it does not accept images. */
  async #imageLimits(handle: SessionHandle): Promise<ImageLimits | undefined> {
    try {
      const id = await handle.model();
      if (id === undefined) return undefined;
      const { provider, modelId } = parseModelId(id);
      const model = this.#models?.()?.getModel(provider, modelId);
      if (model?.input?.includes("image") !== true) return undefined;
      return imageLimitsFor({ provider, modelId });
    } catch {
      return undefined;
    }
  }

  #nameOf(message: MessageView): string {
    if (message.author === "user") return "the user";
    if (message.author === "system") return "system";
    return this.#agents.get(message.agentId ?? "")?.name ?? "another agent";
  }

  /* ---------------------------------------------------------------- reading */

  #requireConversation(id: string): ConversationRecord {
    const conversation = this.#conversations.get(id);
    if (conversation === undefined)
      throw new Error(`no such conversation: ${id}`);
    return conversation;
  }
}

/**
 * Who takes a user message that names nobody, as `conversation_info` says it: the steward, the only
 * member of a group without one, or nobody at all. Never somebody from outside the group.
 */
/** One participant, which is one session. */
function keyOf(conversationId: string, agentId: string): string {
  return `${conversationId}:${agentId}`;
}

/** What a session's prompt and persona were read from; equal means it need not be reopened. */
function stampOf(agent: AgentRecord): string {
  return JSON.stringify([agent.name, agent.instructions, agent.persona]);
}

/** What a reply stopped without its run says: the run was told and did not end. */
function unanswered(running: Running): string {
  const where = running.machine.remote ? ` on ${running.machine.name}` : "";
  return `${running.agent}${where} did not stop when asked, so it was stopped here.`;
}

function nameIn(
  members: readonly { id: string; name: string }[],
  id: string,
): string {
  return members.find((member) => member.id === id)?.name ?? id;
}

/** Where a session on a machine starts when the project's directory is another machine's. */
function homeOf(machine: MachineRecord): string {
  return machine.home ?? (machine.kind === "primary" ? homedir() : "/");
}

/**
 * What an agent working on another machine than its project's is told. Only what is known for
 * certain: which machine it is on and whose the context is. Finding a checkout, or making one, is
 * the agent's to do with what the context gives it.
 */
function awayNote(here: string, there: string, task: boolean): string {
  return [
    "<system-reminder>",
    `You are running on ${here}, not on the machine this ${task ? "task" : "conversation"} belongs to (${there}).`,
    "Paths and files mentioned in the context may refer to that machine and may not exist here.",
    "Find what you need to do the work on this machine yourself.",
    "</system-reminder>",
  ].join("\n");
}

function withAway(prompt: string, away: string | undefined): string {
  return away === undefined ? prompt : `${prompt}\n\n${away}`;
}

/** Who an agent is here and what it was told: its system prompt's platform section, not its base. */
function agentPromptOf(
  agent: AgentRecord,
  held: "conversation" | "task" | "routine" = "conversation",
): string {
  const parts = [
    held === "task"
      ? `In this task you are ${agent.name}. You work on it alone, in a session of your own: nobody else is in it, and what you report on the task is what the user reads.`
      : held === "routine"
        ? `In this session you are ${agent.name}, running one of the user's routines. It is a session of your own: nobody else is in it, and the user reads only the report you send with the report tool.`
        : `In this conversation you are ${agent.name}. The other members, and the user, address you by that name.`,
  ];
  if (agent.instructions.trim() !== "") parts.push(agent.instructions);
  return parts.join("\n\n");
}

/** Whether the promise settles within `ms`. */
async function settlesWithin(
  promise: Promise<void>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, ms, false);
  });
  try {
    return await Promise.race([promise.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}
