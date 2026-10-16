/**
 * The timeline projection (REFACTOR.md §9, P2.3).
 *
 * What happened in a session becomes a row in the group's timeline, and a product event. The two
 * are one write and one publish, and the order matters: the row is the durable truth, the event is
 * how a browser hears about it. A browser that was not connected reads the rows; one that was
 * connected applies events by id and revision.
 *
 * A reply is projected twice — once when it starts, once when it ends:
 *
 *   start    a row with status `working` takes its place in the timeline (its `seq` is fixed here)
 *   finish   the same row gets its text, its status and a higher `revision`
 *
 * That is what makes "working, then the answer" visible without the client guessing, and what
 * makes applying the same event twice harmless: same id, same revision, nothing changes.
 */
import type { EventHub } from "../http/events";
import type { GroupRecord, GroupStore, MessageRecord } from "./store";

export interface TimelineProjectorOptions {
  groups: GroupStore;
  hub?: EventHub | undefined;
}

export interface ProjectedReply {
  message: MessageRecord;
  group: GroupRecord & { seq: number };
}

export class TimelineProjector {
  readonly #groups: GroupStore;
  readonly #hub: EventHub | undefined;

  constructor(options: TimelineProjectorOptions) {
    this.#groups = options.groups;
    this.#hub = options.hub;
  }

  /** An agent started answering: take a place in the timeline and say so. */
  replyStarted(input: {
    groupId: string;
    agentId: string;
    replyToMessageId: string;
  }): ProjectedReply {
    const message = this.#groups.startReply(
      input.groupId,
      input.agentId,
      input.replyToMessageId,
    );
    const group = this.#summary(input.groupId);
    // The seq moved, so the sidebar hears about it as well as the conversation.
    this.#hub?.publish("message.updated", { group_id: input.groupId, message });
    this.#hub?.publish("group.updated", { group });
    return { message, group };
  }

  /** The answer is written (or could not be): update the row in place and publish it. */
  replyFinished(
    messageId: string,
    input: { groupId: string; text: string; status: "done" | "failed" },
  ): ProjectedReply | undefined {
    const message = this.#groups.finishReply(messageId, {
      text: input.text,
      status: input.status,
    });
    if (message === undefined) return undefined;
    const group = this.#summary(input.groupId);
    // No `group.updated`: the seq did not move, and a sidebar has nothing new to say.
    this.#hub?.publish("message.updated", { group_id: input.groupId, message });
    return { message, group };
  }

  #summary(groupId: string): GroupRecord & { seq: number } {
    const summary = this.#groups.summary(groupId);
    if (summary === undefined)
      throw new Error(`group ${groupId} vanished while projecting`);
    return summary;
  }
}
