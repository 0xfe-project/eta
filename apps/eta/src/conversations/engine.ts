import type {
  MessageStatus,
  MessageView,
  SendResult,
} from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
import type { AskObserver } from "@eta/harness";
import type { SessionMeta, SessionsService } from "@eta/server";
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
import type { MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { SessionHandle, SessionPlace } from "./places";
import type { ConversationRecord, ConversationStore } from "./store";
import type { Timeline } from "./timeline";
import { LinkError } from "@eta/daemon";
import { DEFAULT_SYSTEM_PROMPT } from "@eta/harness";
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

export interface EngineOptions {
  runHooks?: RunHooks | undefined;
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
  readonly #changed: EngineOptions["changed"];
  readonly #warn: (message: string) => void;
  readonly #hooks: RunHooks;
  readonly #local: LocalPlace;
  readonly #remote: SessionPlace | undefined;

  #closing = false;
  /** Replies waiting their turn on a participant's session, by `conversation:agent`. */
  readonly #chains = new Map<string, Promise<unknown>>();
  /** The reply each participant's session is running right now. */
  readonly #running = new Map<string, Running>();
  /** What each open session was opened with, to know when it has to be opened again. */
  readonly #opened = new Map<string, string>();

  constructor(options: EngineOptions) {
    this.#db = options.db;
    this.#agents = options.agents;
    this.#machines = options.machines;
    this.#projects = options.projects;
    this.#conversations = options.conversations;
    this.#timeline = options.timeline;
    this.#changed = options.changed;
    this.#warn = options.warn;
    this.#hooks = options.runHooks ?? {};
    this.#remote = options.remote;
    this.#local = new LocalPlace({ opened: this.#opened, warn: options.warn });
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
   * The base of an agent's system prompt: the harness's own, then who the agent is in this
   * conversation and what it was told to be. Read when the session opens, so a change to the
   * agent reaches a session the next time it is opened (see `#syncSession`).
   */
  readonly baseSystemPromptFor = (meta: SessionMeta): string | undefined => {
    if (meta.agentId === undefined) return undefined;
    const agent = this.#agents.get(meta.agentId);
    if (agent === undefined) return undefined;
    this.#opened.set(meta.id, stampOf(agent));
    return promptOf(agent);
  };

  /** The tools an agent's session has beyond the harness's: reaching the other members. */
  readonly sessionTools = (input: { meta: SessionMeta }): KernelTool[] => {
    const { agentId, conversationId } = input.meta;
    if (agentId === undefined || conversationId === undefined) return [];
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

  /* ---------------------------------------------------------------- send */

  /**
   * The user says something. The row is written and the wakes are queued before this returns;
   * the runs happen after it. A `steer` joins an agent that is already answering instead of
   * starting a second reply, and a retry with the same `clientId` is the same message.
   */
  async send(input: {
    conversationId: string;
    text: string;
    mentions: readonly string[];
    mode: "queue" | "steer";
    clientId?: string | undefined;
  }): Promise<SendResult> {
    const conversation = this.#requireConversation(input.conversationId);
    const text = input.text.trim();
    if (text === "") throw new Error("a message needs some text");
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
      message = this.#timeline.append({
        id,
        conversationId: conversation.id,
        kind: "message",
        author: "user",
        text,
        mentions: routing.named,
        rootMessageId: id,
        data: {
          woke: planned.filter((p) => !p.join).map((p) => p.agentId),
          joined: planned.filter((p) => p.join).map((p) => p.agentId),
        },
      });
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
    const told = this.#briefingFor(conversation, participant, message);
    await running.handle.steer(told.text);
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
    const machine =
      project === undefined ? undefined : this.#machines.get(project.machineId);
    if (project === undefined || machine === undefined)
      return fail("unavailable", "The conversation's project is gone.");
    const place =
      machine.kind === "primary"
        ? this.#local
        : machine.kind === "daemon"
          ? this.#remote
          : undefined;
    if (place === undefined) {
      return fail("unavailable", `Sessions cannot run on ${machine.name} yet.`);
    }
    const trigger = this.#timeline.get(reply.replyToId ?? "");
    if (trigger === undefined)
      return fail("gone", "The message this reply answers is gone.");

    let handle: SessionHandle;
    try {
      handle = await place.ensure({
        conversation,
        agent,
        machine,
        cwd: project.path,
        existing: participant.sessionId,
        prompt: promptOf(agent),
        stamp: stampOf(agent),
        created: (id) =>
          this.#conversations.setSession(conversation.id, agent.id, id),
      });
    } catch (error) {
      return fail("unavailable", messageOf(error));
    }
    // A stop that arrived while the session was being made.
    if (this.#timeline.get(replyId)?.status !== "queued") return;

    // What it is told is settled before the row says it is working, so one push carries both.
    const told = this.#briefingFor(
      conversation,
      this.#conversations.participant(conversationId, agent.id) ?? participant,
      trigger,
    );
    const info: RunInfo = {
      conversationId,
      agentId: agent.id,
      replyId,
      told: told.text,
      trigger,
    };
    const extra = await this.#beforeRun(info);
    // A stop that arrived while the hook was asking.
    if (this.#timeline.get(replyId)?.status !== "queued") return;
    const prompt = extra === undefined ? told.text : `${extra}\n\n${told.text}`;
    this.#conversations.setSeen(conversationId, agent.id, told.seen);
    const key = keyOf(conversationId, agent.id);
    this.#running.set(key, { replyId, handle });
    this.#timeline.transition(replyId, ["queued"], "working");
    this.#changed([conversationId]);

    try {
      const result = await handle.run(prompt, () => !this.#closing);
      if (this.#closing && result.status === "aborted") {
        this.#timeline.finish(replyId, {
          status: "failed",
          text: result.text || RESTART_TEXT,
          thinking: result.thinking,
          data: { ...reply.data, code: "restart" },
        });
      } else if (result.status === "failed") {
        this.#timeline.finish(replyId, {
          status: "failed",
          text: result.error ?? "The run failed.",
          thinking: result.thinking,
          data: { ...reply.data, code: "run_failed" },
        });
      } else {
        this.#timeline.finish(replyId, {
          status: result.status === "aborted" ? "stopped" : "done",
          text: result.text,
          thinking: result.thinking,
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

  /** What the agent is told for this wake, and how far that brings it. */
  #briefingFor(
    conversation: ConversationRecord,
    participant: { agentId: string; lastSeq: number },
    trigger: MessageView,
  ) {
    return briefing({
      conversation: conversation.name,
      me: participant.agentId,
      lastSeq: participant.lastSeq,
      rows: this.#timeline.after(conversation.id, participant.lastSeq),
      trigger,
      nameOf: (message) => this.#nameOf(message),
    });
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

/** The base of an agent's system prompt: the harness's own, who it is here, what it was told. */
function promptOf(agent: AgentRecord): string {
  const parts = [
    DEFAULT_SYSTEM_PROMPT,
    `In this conversation you are ${agent.name}. The other members, and the user, address you by that name.`,
  ];
  if (agent.instructions.trim() !== "") parts.push(agent.instructions);
  return parts.join("\n\n");
}
