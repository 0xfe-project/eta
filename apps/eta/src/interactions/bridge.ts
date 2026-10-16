/**
 * The ask bridge (REFACTOR.md §9, P2.6 — 审批 = ask).
 *
 * A session's question and the product's confirmation card are the same event, seen from two
 * sides. The session is parked on a promise inside the harness's ask registry; this is what turns
 * that moment into a row and a `interaction.updated` frame, and what takes the user's answer back
 * into the registry so the run continues.
 *
 * Both halves are recorded, because both are needed after a restart: the question before anybody
 * waits on it (so a card exists even if the process dies first), and the answer before the run is
 * let go (so a replayed session never asks the same thing twice).
 */
import type { AskPayload } from "@eta/core/session";
import type { AskObserver, AskResponse } from "@eta/harness";
import type { SessionManager, SessionMeta } from "@eta/server";
import type { TimelineProjector } from "../groups/projection";
import type { GroupStore } from "../groups/store";
import type { EventHub } from "../http/events";
import type { InteractionRecord, InteractionStore } from "./store";

/** What the ask channel reports. Spelled out here because it is an argument, not a callback. */
type AskAction = Parameters<AskObserver>[0];

export interface AskBridgeOptions {
  interactions: InteractionStore;
  groups: GroupStore;
  sessions: SessionManager;
  projector: TimelineProjector;
  hub: EventHub;
}

export class AskBridge {
  readonly #interactions: InteractionStore;
  readonly #groups: GroupStore;
  readonly #sessions: SessionManager;
  readonly #projector: TimelineProjector;
  readonly #hub: EventHub;

  constructor(options: AskBridgeOptions) {
    this.#interactions = options.interactions;
    this.#groups = options.groups;
    this.#sessions = options.sessions;
    this.#projector = options.projector;
    this.#hub = options.hub;
  }

  /**
   * One session's ask channel, reported as it happens.
   *
   * Whose question it is comes from the session's own metadata (P2.2 put the agent and the group
   * there), and which reply it belongs to comes from the timeline: an agent has one reply open in
   * a group, and a question asked inside that run is that reply's question.
   */
  observe(meta: SessionMeta, action: AskAction, payload: AskPayload): void {
    if (action === "asked") {
      this.#opened(meta, payload);
      return;
    }
    if (action === "answered") {
      // The answer's *value* comes from whoever answered — the route below, or a headless
      // caller in a test — so all this does is make sure a card answered elsewhere stops
      // waiting for a user who will never see it.
      const record = this.#interactions.get(payload.questionId);
      if (record?.status !== "pending") return;
      const resolved = this.#interactions.resolve(record.id, "");
      if (resolved !== undefined) this.#publish(resolved);
      return;
    }
    // `canceled` and `expired`: nobody is waiting any more, and the card says so.
    const settled = this.#interactions.expire(payload.questionId);
    if (settled !== undefined) this.#publish(settled);
  }

  /**
   * The user's answer, on its way to the run that is waiting for it.
   *
   * Idempotent like stopping a reply: answering a card that is already settled changes nothing
   * and says so, rather than counting as a second answer.
   */
  async answer(
    interactionId: string,
    value: string,
  ): Promise<InteractionRecord | undefined> {
    const record = this.#interactions.get(interactionId);
    if (record === undefined) return undefined;
    if (record.status !== "pending") return record;

    const managed = await this.#sessions.session(record.sessionId);
    const resolution: AskResponse = { kind: "selection", selections: [value] };
    const resolved = this.#interactions.resolve(interactionId, value);
    if (resolved !== undefined) this.#publish(resolved);

    // The run continues on the same reply: it was parked, not finished.
    if (record.messageId.length > 0) {
      this.#projector.replyWorking({
        groupId: record.groupId,
        messageId: record.messageId,
      });
    }
    // Nobody waiting (the process restarted, the run gave up) is not a failure: the card is
    // answered, which is what the client asked for.
    managed?.session.ask?.answer(record.id, resolution);
    return resolved ?? record;
  }

  #opened(meta: SessionMeta, payload: AskPayload): void {
    const groupId = typeof meta.groupId === "string" ? meta.groupId : "";
    const agentId = typeof meta.agentId === "string" ? meta.agentId : "";
    const reply =
      groupId.length === 0 || agentId.length === 0
        ? undefined
        : this.#groups.openReply(groupId, agentId);
    const record = this.#interactions.open({
      id: payload.questionId,
      sessionId: meta.id,
      prompt: payload.question,
      ...(payload.options === undefined ? {} : { options: payload.options }),
      ...(groupId.length === 0 ? {} : { groupId }),
      ...(agentId.length === 0 ? {} : { agentId }),
      ...(reply === undefined ? {} : { messageId: reply.id }),
    });
    if (reply !== undefined) {
      this.#projector.replyWaiting({ groupId, messageId: reply.id });
    }
    this.#publish(record);
  }

  #publish(record: InteractionRecord): void {
    this.#hub.publish("interaction.updated", { interaction: record });
  }
}
