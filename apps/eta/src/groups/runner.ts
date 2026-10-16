import type { AgentMessage } from "@eta/core";
import type { ManagedSession, SessionManager } from "@eta/server";
import type { AgentStore } from "../agents/store";
import type { EventHub } from "../http/events";
import type { TimelineProjector } from "./projection";
import type { GroupRecord, GroupStore, MessageRecord } from "./store";
/**
 * Turning a wake into a run (REFACTOR.md §9, P2.2 and P2.3).
 *
 * P2.1 decides *that* an agent should look at a group's message and records it as a row. This is
 * what takes that row: it makes sure the agent has a session for this group, says the message in
 * it, runs it, and marks the wake taken.
 *
 * **One session per (agent × group), and the mapping is a row plus a meta field.** The session id
 * lives on the participant (so "who is in this group" answers "where does their conversation
 * live"), and the session's own meta names the agent and the group (so a session knows what it
 * belongs to without being asked). Both are on disk, which is what "the mapping survives a
 * restart" means: a restart is a fresh process reading the same rows.
 *
 * The agent's own model is what its group sessions run on — that is what the model field on an
 * agent is for (P0.8); a session with no agent (a side thread) keeps the config default.
 *
 * The answer is projected into the group's timeline (P2.3) as it happens: a row that says
 * "working" takes its place before the run, and that same row gets the text when the run ends.
 */
import process from "node:process";

export interface WakeRunnerOptions {
  groups: GroupStore;
  sessions: SessionManager;
  agents: AgentStore;
  /** Where the answer goes, and how a browser hears about it. */
  projector?: TimelineProjector | undefined;
  hub?: EventHub | undefined;
  /** Where a group session's tools run. Defaults to this process's directory. */
  cwd?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}

export interface DeliveredReply {
  agentId: string;
  /** Absent when the delivery failed before a session could be opened. */
  sessionId?: string | undefined;
  messageId: string;
  /** The timeline row that holds this answer, when one was projected. */
  replyMessageId?: string | undefined;
  status: "completed" | "failed" | "aborted";
  /** What the agent last said (P2.3 projects it), or why this delivery failed. */
  text: string;
}

const textOf = (message: AgentMessage): string => {
  switch (message.role) {
    case "assistant":
    case "user":
    case "toolResult": {
      const content = message.content;
      if (typeof content === "string") return content;
      return content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
    case "compactionSummary":
    case "branchSummary":
      return message.summary;
    default:
      return "";
  }
};

export class WakeRunner {
  readonly #groups: GroupStore;
  readonly #sessions: SessionManager;
  readonly #agents: AgentStore;
  readonly #projector: TimelineProjector | undefined;
  readonly #hub: EventHub | undefined;
  readonly #cwd: string;
  readonly #warn: (message: string) => void;

  constructor(options: WakeRunnerOptions) {
    this.#groups = options.groups;
    this.#sessions = options.sessions;
    this.#agents = options.agents;
    this.#projector = options.projector;
    this.#hub = options.hub;
    this.#cwd = options.cwd ?? process.cwd();
    this.#warn = options.warn ?? (() => undefined);
  }

  /**
   * Deliver the queued wakes of one message — or of everything a group has queued, when no
   * message is named. Returns what each agent said, in the order they were woken.
   */
  async deliver(
    groupId: string,
    messageId?: string,
  ): Promise<DeliveredReply[]> {
    const queued = this.#groups
      .wakes(groupId)
      .filter((wake) => wake.state === "queued")
      .filter(
        (wake) => messageId === undefined || wake.messageId === messageId,
      );

    const replies: DeliveredReply[] = [];
    for (const wake of queued) {
      const reply = await this.#deliverOne(
        groupId,
        wake.agentId,
        wake.messageId,
      );
      if (reply !== undefined) replies.push(reply);
    }
    return replies;
  }

  async #deliverOne(
    groupId: string,
    agentId: string,
    messageId: string,
  ): Promise<DeliveredReply | undefined> {
    const group = this.#groups.get(groupId);
    if (group === undefined) return undefined;
    const message = this.#groups
      .messages(groupId)
      .find((candidate) => candidate.id === messageId);
    if (message === undefined) return undefined;

    try {
      return await this.#run(group.group, groupId, agentId, message);
    } catch (error) {
      // Nothing could be opened or started — no providers configured, no environment, a
      // session that will not come up. That is this agent's reply failing, not the message's:
      // the message landed in the timeline, which is the durable half, and saying why beats a
      // 500 that hides which agent could not answer.
      const reason = error instanceof Error ? error.message : String(error);
      this.#warn(
        `[eta] agent ${agentId} could not answer in group ${groupId}: ${reason}`,
      );
      this.#hub?.publish("group.reply", {
        groupId,
        agentId,
        messageId,
        status: "failed",
        text: reason,
      });
      return { agentId, messageId, status: "failed", text: reason };
    }
  }

  async #run(
    group: GroupRecord,
    groupId: string,
    agentId: string,
    message: MessageRecord,
  ): Promise<DeliveredReply> {
    const messageId = message.id;
    // The session first: a delivery that cannot even open one leaves no half-written reply in
    // the timeline for a reader to wonder about.
    const managed = await this.#ensureSession(group, groupId, agentId);
    // Taken before the run, not after: a crash mid-turn must not deliver the same wake twice.
    this.#groups.markWake(groupId, agentId, messageId, "taken");

    const projected = this.#projector?.replyStarted({
      groupId,
      agentId,
      replyToMessageId: messageId,
    });
    const replyMessageId = projected?.message.id;

    try {
      managed.session.kernel.inject({
        role: "user",
        timestamp: Date.now(),
        content: [
          { type: "text", text: this.#promptFor(group, groupId, message) },
        ],
      });
      const result = await managed.session.runner.run();
      const text = this.#lastAssistantText(managed);
      if (replyMessageId !== undefined) {
        this.#projector?.replyFinished(replyMessageId, {
          groupId,
          text,
          status: "done",
        });
      }
      this.#hub?.publish("group.reply", {
        groupId,
        agentId,
        sessionId: managed.meta.id,
        messageId,
        replyMessageId,
        status: result.status,
        text,
      });
      return {
        agentId,
        sessionId: managed.meta.id,
        messageId,
        ...(replyMessageId === undefined ? {} : { replyMessageId }),
        status: result.status,
        text,
      };
    } catch (error) {
      // The run itself failed. The reply row is already in the timeline: it becomes the place
      // where the failure is written, rather than a row that says "working" forever.
      const reason = error instanceof Error ? error.message : String(error);
      if (replyMessageId !== undefined) {
        this.#projector?.replyFinished(replyMessageId, {
          groupId,
          text: reason,
          status: "failed",
        });
      }
      this.#hub?.publish("group.reply", {
        groupId,
        agentId,
        sessionId: managed.meta.id,
        messageId,
        replyMessageId,
        status: "failed",
        text: reason,
      });
      return {
        agentId,
        sessionId: managed.meta.id,
        messageId,
        ...(replyMessageId === undefined ? {} : { replyMessageId }),
        status: "failed",
        text: reason,
      };
    }
  }

  #lastAssistantText(managed: ManagedSession): string {
    let last: AgentMessage | undefined;
    for (const entry of managed.session.journaling.transcript()) {
      if (entry.role === "assistant") last = entry;
    }
    return last === undefined ? "" : textOf(last);
  }

  /** What the agent is told: who is speaking, and in which group. */
  #promptFor(
    group: GroupRecord,
    groupId: string,
    message: MessageRecord,
  ): string {
    const author =
      message.authorKind === "user"
        ? "the user"
        : (this.#agents.get(message.authorAgentId ?? "")?.name ??
          "another agent");
    return `[group: ${group.name} (${groupId})] ${author} said:\n${message.text}`;
  }

  /** The agent's session in this group: the one on the participant row, or a new one. */
  async #ensureSession(
    group: GroupRecord,
    groupId: string,
    agentId: string,
  ): Promise<ManagedSession> {
    const participant = this.#groups
      .participantsOf(groupId)
      .find((candidate) => candidate.agentId === agentId);
    if (participant?.sessionId !== undefined) {
      const existing = await this.#sessions.session(participant.sessionId);
      if (existing !== undefined) return existing;
      // The row outlived its journal: say so, then make a new one rather than failing the turn.
      this.#warn(
        `[eta] session ${participant.sessionId} (agent ${agentId} in group ${groupId}) is gone; opening a new one`,
      );
    }

    const agent = this.#agents.get(agentId);
    const created = await this.#sessions.create({
      cwd: this.#cwd,
      title: agent === undefined ? group.name : `${group.name} · ${agent.name}`,
      agentId,
      groupId,
      ...(agent?.model === undefined ? {} : { model: agent.model }),
    });
    this.#groups.setSession(groupId, agentId, created.meta.id);
    return created;
  }
}
