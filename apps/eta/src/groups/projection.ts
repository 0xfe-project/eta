import type { EventHub } from "../http/events";
/**
 * The timeline projection (REFACTOR.md §9, P2.3).
 *
 * What happened in a session becomes a row in the group's timeline, and a product event. The two
 * are one write and one publish, and the order matters: the row is the durable truth, the event is
 * how a browser hears about it. A browser that was not connected reads the rows; one that was
 * connected applies events by id and revision.
 *
 * Both directions go through here. A reply is projected twice — once when it starts, once when it
 * ends:
 *
 *   start    a row with status `working` takes its place in the timeline (its `seq` is fixed here)
 *   finish   the same row gets its text, its status and a higher `revision`
 *
 * That is what makes "working, then the answer" visible without the client guessing, and what
 * makes applying the same event twice harmless: same id, same revision, nothing changes.
 *
 * The user's own message is projected too, which is not a detail: the browser that sent it adds it
 * locally, but every *other* browser watching the group only learns about it from this event.
 */
import type { InteractionRecord } from "../interactions/store";
import type {
  GroupRecord,
  GroupStore,
  MessageRecord,
  PostedMessage,
} from "./store";

export interface TimelineProjectorOptions {
  groups: GroupStore;
  hub?: EventHub | undefined;
  /**
   * Questions that were still waiting when a reply ended (P2.6).
   *
   * A reply ending is the one moment that settles it: a run that is over cannot be waiting for an
   * answer, so a card left pending belongs to a question nobody will ever read.
   */
  interactions?:
    | { expireForReply: (messageId: string) => InteractionRecord[] }
    | undefined;
}

export interface ProjectedReply {
  message: MessageRecord;
  group: GroupRecord & { seq: number };
}

export class TimelineProjector {
  readonly #groups: GroupStore;
  readonly #hub: EventHub | undefined;
  readonly #interactions:
    | { expireForReply: (messageId: string) => InteractionRecord[] }
    | undefined;

  constructor(options: TimelineProjectorOptions) {
    this.#groups = options.groups;
    this.#hub = options.hub;
    this.#interactions = options.interactions;
  }

  /** The user speaks: a row in the timeline, and every watcher hears about it. */
  userMessage(input: {
    groupId: string;
    text: string;
    mentions?: readonly string[] | undefined;
    /** The caller's own id, when it has one: posting the same id twice is one message. */
    id?: string | undefined;
  }): PostedMessage & { group: GroupRecord & { seq: number } } {
    const posted = this.#groups.postUserMessage(input.groupId, input);
    if (posted === undefined)
      throw new Error(`group ${input.groupId} vanished while posting`);
    const group = this.#summary(input.groupId);
    this.#hub?.publish("message.updated", {
      group_id: input.groupId,
      message: posted.message,
    });
    this.#hub?.publish("group.updated", { group });
    return { ...posted, group };
  }

  /**
   * A message that is not a reply: a task card, a draft, a notice (P3.1).
   *
   * The write already happened; this is the half that tells the clients. A card that only grew its
   * data does not move the seq, so the group is announced only when the timeline did.
   */
  notice(input: { groupId: string; message: MessageRecord }): void {
    this.#hub?.publish("message.updated", {
      group_id: input.groupId,
      message: input.message,
    });
    const group = this.#summary(input.groupId);
    // A card that only grew its data did not move the timeline, and a sidebar told otherwise would
    // reorder itself for nothing.
    if (input.message.seq >= group.seq) {
      this.#hub?.publish("group.updated", { group });
    }
  }

  /** The group itself changed — created, renamed, a member joined or left. */
  groupChanged(groupId: string): GroupRecord & { seq: number } {
    const group = this.#summary(groupId);
    this.#hub?.publish("group.updated", { group });
    return group;
  }

  /**
   * An agent is going to answer: take a place in the timeline and say so.
   *
   * `queued` is the product's send path (P2.6): the row is written before the run starts so the
   * send can answer with it, and the run turns it into a working one when it actually begins.
   */
  replyStarted(input: {
    groupId: string;
    agentId: string;
    replyToMessageId: string;
    status?: "queued" | "working" | undefined;
  }): ProjectedReply {
    const message = this.#groups.startReply(
      input.groupId,
      input.agentId,
      input.replyToMessageId,
      input.status ?? "working",
    );
    const group = this.#summary(input.groupId);
    // The seq moved, so the sidebar hears about it as well as the conversation.
    this.#hub?.publish("message.updated", { group_id: input.groupId, message });
    this.#hub?.publish("group.updated", { group });
    return { message, group };
  }

  /**
   * A stop was asked for: the row says so while the run winds down (P2.6).
   *
   * The run ends a moment later and writes the same row as `stopped`. This phase exists because a
   * client should be able to show that the stop was heard, and because an abort takes as long as
   * the effect it interrupts.
   */
  replyStopping(input: {
    groupId: string;
    messageId: string;
  }): MessageRecord | undefined {
    const message = this.#groups.markStopping(input.messageId);
    if (message === undefined) return undefined;
    this.#hub?.publish("message.updated", { group_id: input.groupId, message });
    return message;
  }

  /**
   * The agent asked and is parked until it is answered (P2.6).
   *
   * The row says `waiting_for_input`, which is the product's own word for it: the reply did not
   * end, it stopped to listen.
   */
  replyWaiting(input: {
    groupId: string;
    messageId: string;
  }): MessageRecord | undefined {
    const message = this.#groups.markWaiting(input.messageId);
    if (message === undefined) return undefined;
    this.#hub?.publish("message.updated", { group_id: input.groupId, message });
    return message;
  }

  /** The run behind a queued reply has begun: `queued` becomes `working`. */
  replyWorking(input: {
    groupId: string;
    messageId: string;
  }): MessageRecord | undefined {
    const message = this.#groups.markWorking(input.messageId);
    if (message === undefined) return undefined;
    this.#hub?.publish("message.updated", { group_id: input.groupId, message });
    return message;
  }

  /** The answer is written (or could not be, or was stopped): update the row and publish it. */
  replyFinished(
    messageId: string,
    input: {
      groupId: string;
      text: string;
      status: "done" | "failed" | "stopped";
    },
  ): ProjectedReply | undefined {
    const message = this.#groups.finishReply(messageId, {
      text: input.text,
      status: input.status,
    });
    if (message === undefined) return undefined;
    const group = this.#summary(input.groupId);
    // No `group.updated`: the seq did not move, and a sidebar has nothing new to say.
    this.#hub?.publish("message.updated", { group_id: input.groupId, message });
    for (const expired of this.#interactions?.expireForReply(messageId) ?? []) {
      this.#hub?.publish("interaction.updated", { interaction: expired });
    }
    return { message, group };
  }

  #summary(groupId: string): GroupRecord & { seq: number } {
    const summary = this.#groups.summary(groupId);
    if (summary === undefined)
      throw new Error(`group ${groupId} vanished while projecting`);
    return summary;
  }
}
