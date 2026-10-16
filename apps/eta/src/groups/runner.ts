import type { AgentMessage, Kernel } from "@eta/core";
import type { ManagedSession, SessionManager } from "@eta/server";
import type { AgentStore } from "../agents/store";
import type { EventHub } from "../http/events";
import type { TimelineProjector } from "./projection";
import type {
  GroupRecord,
  GroupStore,
  MessageRecord,
  PostedMessage,
  WakeRecord,
} from "./store";
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
 *
 * A run can also be stopped (P2.6), and that takes two writes: the row says `stopping` as soon as
 * the stop is heard, and `stopped` when the run actually gives up. `stop` below is the whole of
 * it — find the row, mark it, abort the session it belongs to, and let the run finish the job.
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
  /**
   * How the reply ended, in the timeline's words rather than the kernel's: a run the kernel
   * reports as `aborted` is a row that is `stopped`, and one it reports as `completed` is `done`.
   * Translating here is what keeps one vocabulary from the row outward.
   */
  status: "done" | "failed" | "stopped";
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
  /** Background deliveries, chained so a group's answers keep the order they were woken in. */
  #pending: Promise<unknown> = Promise.resolve();

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
    const replies: DeliveredReply[] = [];
    for (const wake of this.#queuedWakes(groupId, messageId)) {
      const reply = await this.#deliverOne(
        groupId,
        wake.agentId,
        wake.messageId,
      );
      if (reply !== undefined) replies.push(reply);
    }
    return replies;
  }

  /**
   * Deliver a message's wakes without waiting for the answers (P2.6).
   *
   * The product's send answers with the reply rows it started and the web follows the rest over the
   * stream, so the rows exist by the time this returns and the runs happen after it. Runs are
   * chained rather than started side by side: a group's timeline should read in the order its
   * agents were woken.
   */
  async start(groupId: string, messageId?: string): Promise<MessageRecord[]> {
    const group = this.#groups.get(groupId);
    if (group === undefined) return [];
    const started: MessageRecord[] = [];
    for (const wake of this.#queuedWakes(groupId, messageId)) {
      const message = this.#groups.message(wake.messageId);
      if (message === undefined) continue;
      let prepared: {
        managed: ManagedSession;
        replyMessageId: string | undefined;
      };
      try {
        prepared = await this.#prepare(
          group.group,
          groupId,
          wake.agentId,
          message,
          "queued",
        );
      } catch (error) {
        // The same answer the blocking path gives a delivery that cannot start: the failure is
        // this agent's reply, said out loud rather than a 500 on the whole send.
        const reason = error instanceof Error ? error.message : String(error);
        this.#warn(
          `[eta] agent ${wake.agentId} could not answer in group ${groupId}: ${reason}`,
        );
        this.#hub?.publish("group.reply", {
          groupId,
          agentId: wake.agentId,
          messageId: wake.messageId,
          status: "failed",
          text: reason,
        });
        continue;
      }
      const row =
        prepared.replyMessageId === undefined
          ? undefined
          : this.#groups.message(prepared.replyMessageId);
      if (row !== undefined) started.push(row);
      this.#chain(() =>
        this.#execute(group.group, groupId, wake.agentId, message, prepared),
      );
    }
    return started;
  }

  /**
   * The product's send (P2.6): a message, and what the agents it names should do with it.
   *
   * `mode` is how it joins a conversation that is already running — `steer` changes the turn in
   * flight, `queue` waits for it to end. Both are the kernel's inbox: a steer lands at the next
   * boundary, a follow-up when the run would otherwise stop. An agent that is not answering has
   * nothing to join, so either mode is just "answer this next".
   *
   * A message that joins a running turn cancels the wake it recorded: the words are already in
   * that run, and a second run would answer them twice.
   */
  async send(input: {
    groupId: string;
    text: string;
    mentions: readonly string[];
    mode: "queue" | "steer";
    id?: string | undefined;
  }): Promise<
    | (PostedMessage & {
        group: GroupRecord & { seq: number };
        replies: MessageRecord[];
        joined: string[];
      })
    | undefined
  > {
    // A send to a group that is not there is a 404, not a thrown error: checked here because the
    // projector would have to throw to say the same thing.
    if (this.#groups.get(input.groupId) === undefined) return undefined;
    const posted =
      this.#projector === undefined
        ? this.#groups.postUserMessage(input.groupId, {
            text: input.text,
            mentions: input.mentions,
            ...(input.id === undefined ? {} : { id: input.id }),
          })
        : this.#projector.userMessage({
            groupId: input.groupId,
            text: input.text,
            mentions: input.mentions,
            ...(input.id === undefined ? {} : { id: input.id }),
          });
    if (posted === undefined) return undefined;

    const joined: string[] = [];
    for (const agentId of posted.woke) {
      const kernel = await this.#answeringKernel(input.groupId, agentId);
      if (kernel === undefined) continue;
      const words = {
        role: "user" as const,
        timestamp: Date.now(),
        content: [{ type: "text" as const, text: input.text }],
      };
      if (input.mode === "steer") kernel.steer(words);
      else kernel.followUp(words);
      this.#groups.markWake(
        input.groupId,
        agentId,
        posted.message.id,
        "cancelled",
      );
      joined.push(agentId);
    }

    const replies = await this.start(input.groupId, posted.message.id);
    const group = this.#groups.summary(input.groupId);
    if (group === undefined) return undefined;
    return { ...posted, group, replies, joined };
  }

  /** The kernel of the session that is answering for this agent, if one is. */
  async #answeringKernel(
    groupId: string,
    agentId: string,
  ): Promise<Kernel | undefined> {
    const sessionId = this.#groups
      .participantsOf(groupId)
      .find((participant) => participant.agentId === agentId)?.sessionId;
    if (sessionId === undefined) return undefined;
    const managed = await this.#sessions.session(sessionId);
    if (managed === undefined || !managed.session.runner.running)
      return undefined;
    return managed.session.kernel;
  }

  #chain(job: () => Promise<unknown>): void {
    this.#pending = this.#pending.then(job).catch((error: unknown) => {
      this.#warn(
        `[eta] a background delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  #queuedWakes(groupId: string, messageId?: string): WakeRecord[] {
    return this.#groups
      .wakes(groupId)
      .filter((wake) => wake.state === "queued")
      .filter(
        (wake) => messageId === undefined || wake.messageId === messageId,
      );
  }

  /**
   * Stop the run behind a reply row (P2.6).
   *
   * Returns the row as a client should now read it: `stopping` when there was a run to stop, and
   * the row unchanged when there was not — a reply that already ended, or one this host never
   * projected. Stopping is idempotent on purpose: a client may click twice, and the second click
   * must not look like a second change.
   */
  async stop(replyMessageId: string): Promise<MessageRecord | undefined> {
    const reply = this.#groups.message(replyMessageId);
    if (reply === undefined) return undefined;
    if (reply.status !== "working") return reply;

    const stopping = this.#projector?.replyStopping({
      groupId: reply.groupId,
      messageId: replyMessageId,
    });
    // The session is the one the participant row points at, which is the same mapping a delivery
    // uses — so a stop can only ever reach the conversation this reply came out of.
    const sessionId =
      reply.authorAgentId === undefined
        ? undefined
        : this.#groups
            .participantsOf(reply.groupId)
            .find((participant) => participant.agentId === reply.authorAgentId)
            ?.sessionId;
    if (sessionId !== undefined) {
      const managed = await this.#sessions.session(sessionId);
      managed?.session.runner.abort();
    }
    return stopping ?? this.#groups.message(replyMessageId) ?? reply;
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
    const prepared = await this.#prepare(
      group,
      groupId,
      agentId,
      message,
      "working",
    );
    return await this.#execute(group, groupId, agentId, message, prepared);
  }

  /**
   * Everything that has to be true before a run starts: the session exists, the wake is taken, and
   * the reply has its place in the timeline.
   *
   * Split from the run itself because the product's send answers with the reply rows *before* the
   * runs happen (P2.6): those rows are written here, as `queued`, and each run turns its own row
   * into a working one when it actually begins.
   */
  async #prepare(
    group: GroupRecord,
    groupId: string,
    agentId: string,
    message: MessageRecord,
    status: "queued" | "working",
  ): Promise<{ managed: ManagedSession; replyMessageId: string | undefined }> {
    // The session first: a delivery that cannot even open one leaves no half-written reply in
    // the timeline for a reader to wonder about.
    const managed = await this.#ensureSession(group, groupId, agentId);
    // Taken before the run, not after: a crash mid-turn must not deliver the same wake twice.
    this.#groups.markWake(groupId, agentId, message.id, "taken");
    const projected = this.#projector?.replyStarted({
      groupId,
      agentId,
      replyToMessageId: message.id,
      status,
    });
    return { managed, replyMessageId: projected?.message.id };
  }

  async #execute(
    group: GroupRecord,
    groupId: string,
    agentId: string,
    message: MessageRecord,
    prepared: { managed: ManagedSession; replyMessageId: string | undefined },
  ): Promise<DeliveredReply> {
    const messageId = message.id;
    const { managed, replyMessageId } = prepared;
    if (replyMessageId !== undefined) {
      this.#projector?.replyWorking({ groupId, messageId: replyMessageId });
    }

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
      // An aborted run is a stopped reply: not a failure, and not a finished one either. The text
      // is whatever the transcript holds — for a turn that was stopped mid-generation that is
      // usually empty, because the kernel does not journal a partial (a partial is not history).
      const ended: "done" | "stopped" =
        result.status === "aborted" ? "stopped" : "done";
      if (replyMessageId !== undefined) {
        this.#projector?.replyFinished(replyMessageId, {
          groupId,
          text,
          status: ended,
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
        status: ended,
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
