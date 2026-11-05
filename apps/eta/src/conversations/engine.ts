import type {
  MessageStatus,
  MessageView,
  PromptImage,
  SendResult,
} from "@eta/client-contracts";
import type { KernelModels, KernelTool } from "@eta/core";
import type { AskObserver } from "@eta/harness";
import type { SessionMeta, SessionsService } from "@eta/server";
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
import type { AgentRecord, AgentStore } from "../agents/store";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { AttachmentRecord, AttachmentStore } from "./attachments";
import type { SessionHandle, SessionPlace, SessionSettings } from "./places";
import type { ConversationRecord, ConversationStore } from "./store";
import type { Timeline } from "./timeline";
import { homedir } from "node:os";
import { LinkError } from "@eta/daemon";
import { parseModelId } from "@eta/server";
import { isTaskSession } from "../tasks/session-key";
import { viewOf as attachmentView } from "./attachments";
import { briefing } from "./briefing";
import { LocalPlace, messageOf } from "./places";
import {
  judgeMention,
  resolveNamed,
  routeUserMessage,
  WAKE_BUDGET,
} from "./routing";
import { conversationTools } from "./tools";
import { effectiveSteward } from "./views";

/** What a reply says when the process died under it. */
export const RESTART_TEXT = "The server restarted before this reply finished.";

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
}

/** A reply that is running: which session runs it, to stop it or to join it. */
interface Running {
  replyId: string;
  handle: SessionHandle;
}

export class Engine {
  readonly #db: Database;
  readonly #agents: AgentStore;
  readonly #machines: MachineStore;
  readonly #projects: ProjectStore;
  readonly #conversations: ConversationStore;
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

  #closing = false;
  /** Replies waiting their turn on a participant's session, by `conversation:agent`. */
  readonly #chains = new Map<string, Promise<unknown>>();
  /** The reply each participant's session is running right now. */
  readonly #running = new Map<string, Running>();
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
    for (const running of this.#running.values()) running.handle.abort();
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
    this.#opened.set(meta.id, this.#stamp(agent, away));
    return withAway(
      agentPromptOf(agent, isTaskSession(meta.conversationId)),
      away,
    );
  };

  /** What a session's prompt, persona and plugins were read from. */
  #stamp(agent: AgentRecord, away?: string): string {
    return `${stampOf(agent)}${this.#pluginStamp?.(agent) ?? ""}${away ?? ""}`;
  }

  /**
   * The machine an agent's sessions in a project are made on: its own, when it is pinned to one
   * that is still here, else the project's.
   */
  machineFor(
    agent: AgentRecord,
    projectMachineId: string,
  ): MachineRecord | undefined {
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
    // A task's session is held in no conversation: it has no members to reach.
    if (isTaskSession(conversationId)) return [];
    return conversationTools(this, conversationId, agentId);
  };

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
   * (`tasks/session-key.ts`): a run that continues another one passes the key that session was made
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
      prompt: withAway(agentPromptOf(input.agent, true), away),
      stamp: this.#stamp(input.agent, away),
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

  async send(input: {
    conversationId: string;
    text: string;
    /**
     * Where the sender folded pastes inside `text` (`ConversationArgs["send"]["blocks"]`). Not
     * looked at: written verbatim into the row's `data.blocks`, for renderers. The prompt the
     * agents read is `text` alone, with the blocks in it as the plain text they stand for.
     */
    blocks?: readonly (readonly [number, number])[] | undefined;
    mentions: readonly string[];
    mode: "queue" | "steer";
    clientId?: string | undefined;
    /** Ids of files uploaded to this conversation (`AttachmentStore.receive`). */
    attachments?: readonly string[] | undefined;
  }): Promise<SendResult> {
    const conversation = this.#requireConversation(input.conversationId);
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
          earlier.author !== "user"
        )
          throw new Error(`clientId ${input.clientId} is taken`);
        return this.#sent(earlier);
      }
    }

    const id = input.clientId ?? crypto.randomUUID();
    const files = this.#attachments.check(
      conversation.id,
      input.attachments ?? [],
    );
    const planned: { agentId: string; join: boolean }[] = [];
    const replies: MessageView[] = [];
    let message!: MessageView;
    let nobody = false;
    this.#db.transaction(() => {
      const routing = routeUserMessage({
        kind: conversation.kind,
        members: this.#conversations
          .participants(conversation.id)
          .map((participant) => participant.agentId),
        mentions: input.mentions,
        steward: this.#stewardOf(conversation),
      });
      nobody = routing.targets.length === 0;
      if (routing.addSteward)
        this.#conversations.addParticipant(
          conversation.id,
          routing.targets[0]!,
        );
      for (const agentId of routing.targets) {
        planned.push({
          agentId,
          join:
            input.mode === "steer" && this.#joinable(conversation.id, agentId),
        });
      }
      /*
       * A message nobody can take yet is not a message of the conversation yet: every target still
       * has a reply of its own in flight, so nothing would read it until one of them finished. It
       * is written as `queued` — the same status a reply waits in — and the lane that picks it up
       * turns it into a message. Sending two in a row while the first is unanswered used to put
       * both in the transcript and leave the second one unrecallable.
       */
      const held =
        planned.length > 0 &&
        planned.every(
          (target) =>
            !target.join &&
            this.#chains.has(keyOf(conversation.id, target.agentId)),
        );
      message = this.#timeline.append({
        id,
        conversationId: conversation.id,
        kind: "message",
        author: "user",
        text,
        mentions: routing.named,
        rootMessageId: id,
        data: {
          // Held: written, but not a message of the conversation yet — see `held` above. `status`
          // is left alone on purpose: `queued` means "a reply waiting to run", and every in-flight
          // query in the store would pick a user row up as one.
          ...(held ? { held: true } : {}),
          woke: planned.filter((p) => !p.join).map((p) => p.agentId),
          joined: planned.filter((p) => p.join).map((p) => p.agentId),
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
      this.#timeline.setData(message.id, {
        ...message.data,
        woke: replies.map((reply) => reply.agentId),
        joined,
      });
    }
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
        return agent === undefined ? [] : [{ id: agent.id, name: agent.name }];
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

  /** The room an agent is in, as the `conversation_info` tool tells it. */
  describe(conversationId: string, me: string): string {
    const conversation = this.#requireConversation(conversationId);
    const project = this.#projects.get(conversation.projectId);
    const steward = this.#stewardOf(conversation);
    const members = this.#conversations
      .participants(conversationId)
      .map((participant) => {
        const name = this.#agents.get(participant.agentId)?.name ?? "(deleted)";
        const marks = [
          participant.agentId === me ? "you" : undefined,
          participant.agentId === steward ? "steward" : undefined,
        ].filter((mark) => mark !== undefined);
        return marks.length === 0 ? name : `${name} (${marks.join(", ")})`;
      });
    return [
      `Conversation: ${conversation.name}${conversation.kind === "direct" ? " (a private chat with the user)" : ""}`,
      `Project: ${project === undefined ? "(gone)" : `${project.name}, at ${project.path}`}`,
      `Goal: ${conversation.goal === "" ? "(not set)" : conversation.goal}`,
      `Decided so far: ${conversation.decided === "" ? "(nothing yet)" : conversation.decided}`,
      `Members: ${members.join(", ")}`,
    ].join("\n");
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

  /**
   * An agent's model or thinking level was edited: its sessions take the new ones, wherever they
   * run, replacing whatever those sessions had been running on. A session that
   * cannot be reached (its machine is offline) or is in the middle of a run is a warning: it
   * keeps what it has.
   */
  async applySettings(
    agentId: string,
    settings: SessionSettings,
  ): Promise<void> {
    if (settings.model === undefined && settings.thinkingLevel === undefined)
      return;
    for (const sessionId of this.#conversations.sessionsOfAgent(agentId)) {
      const held = this.#conversations.ofSession(sessionId);
      const machine =
        held === undefined ? undefined : this.#machines.get(held.machineId);
      const place = machine === undefined ? undefined : this.#placeOf(machine);
      if (machine === undefined || place === undefined) continue;
      try {
        await place.configure(sessionId, machine, settings);
      } catch (error) {
        this.#warn(
          `[eta] could not update session ${sessionId} to the edited agent: ${messageOf(error)}`,
        );
      }
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
   * as `stopped` when the run gives up. Stopping twice is not a second change.
   */
  #stopRow(row: MessageView): MessageView | undefined {
    if (row.status === "queued") {
      return this.#timeline.finish(row.id, { status: "stopped", text: "" });
    }
    if (row.status !== "working" && row.status !== "waiting_for_input")
      return undefined;
    const stopping = this.#timeline.transition(
      row.id,
      ["working", "waiting_for_input"],
      "stopping",
    );
    if (stopping !== undefined && row.agentId !== null) {
      this.#running.get(keyOf(row.conversationId, row.agentId))?.handle.abort();
    }
    return stopping;
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
    // An agent pinned to a machine answers from there, wherever the project is: in its home
    // directory, told (out of the transcript's sight) that the project's paths are another
    // machine's.
    const machine = this.machineFor(agent, project.machineId) ?? home;
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
        stamp: this.#stamp(agent, away),
        created: (id) =>
          this.#conversations.setSession(
            conversation.id,
            agent.id,
            id,
            machine.id,
          ),
      });
    } catch (error) {
      return fail("unavailable", messageOf(error));
    }
    // A stop that arrived while the session was being made.
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
    const key = keyOf(conversationId, agent.id);
    this.#running.set(key, { replyId, handle });
    // The row says where the run starts in the session. The page cannot tell from the session: its
    // view is sent on a pace of its own, so for a moment after this push the newest things the
    // view holds are still the last run's.
    if (runFrom !== undefined)
      this.#timeline.setData(replyId, { ...reply.data, runFrom });
    this.#timeline.transition(replyId, ["queued"], "working");
    this.#changed([conversationId]);

    try {
      const result = await handle.run(
        prompt,
        () => !this.#closing,
        told.images,
      );
      // What the run did with tools stays on the row, so the page draws it after the run too.
      const activity =
        result.activity === undefined ? {} : { activity: result.activity };
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
          text: result.error ?? "The run failed.",
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
          : messageOf(error),
        data: { ...reply.data, code: lost ? "link_lost" : "run_failed" },
      });
    } finally {
      this.#running.delete(key);
      this.#changed([conversationId]);
    }
    this.#afterRun(info);
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
      const all = [...files.values()].flat();
      const placed = await this.#place(all, conversation, machine);
      for (const [rowId, carried] of files) {
        lines.set(
          rowId,
          carried.map((file) => {
            const path = placed.paths.get(file.id);
            return path === undefined
              ? `[attachment ${file.name} could not be put where you can read it: ${placed.failed.get(file.id) ?? "unknown error"}]`
              : `[attachment: ${path} (${file.contentType}, ${file.size} bytes)]`;
          }),
        );
      }
      if (await this.#takesImages(handle))
        images = await this.#attachments.images(
          all.filter((file) => placed.paths.has(file.id)),
        );
    }
    return {
      ...briefing({
        conversation: conversation.name,
        me: participant.agentId,
        lastSeq: participant.lastSeq,
        rows,
        trigger,
        nameOf: (message) => this.#nameOf(message),
        filesOf: (message) => lines.get(message.id) ?? [],
      }),
      images,
    };
  }

  /** Put the files where the conversation's sessions can open them; a machine out of reach fails them all. */
  async #place(
    files: readonly AttachmentRecord[],
    conversation: ConversationRecord,
    machine: MachineRecord,
  ) {
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

  /** Whether the session's model accepts images; when that cannot be told, no images are sent. */
  async #takesImages(handle: SessionHandle): Promise<boolean> {
    try {
      const id = await handle.model();
      if (id === undefined) return false;
      const { provider, modelId } = parseModelId(id);
      const model = this.#models?.()?.getModel(provider, modelId);
      return model?.input?.includes("image") === true;
    } catch {
      return false;
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

  #stewardOf(conversation: ConversationRecord): string | null {
    return effectiveSteward(this.#projects, conversation);
  }
}

/** One participant, which is one session. */
function keyOf(conversationId: string, agentId: string): string {
  return `${conversationId}:${agentId}`;
}

/** What a session's prompt and persona were read from; equal means it need not be reopened. */
function stampOf(agent: AgentRecord): string {
  return JSON.stringify([agent.name, agent.instructions, agent.persona]);
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
function agentPromptOf(agent: AgentRecord, task = false): string {
  const parts = [
    task
      ? `In this task you are ${agent.name}. You work on it alone, in a session of your own: nobody else is in it, and what you report on the task is what the user reads.`
      : `In this conversation you are ${agent.name}. The other members, and the user, address you by that name.`,
  ];
  if (agent.instructions.trim() !== "") parts.push(agent.instructions);
  return parts.join("\n\n");
}
