/**
 * The inbox: the questions of every session, in one place.
 *
 * A session's ask channel reports each question as it is asked, answered, canceled or expired
 * (`askObserve`); this turns those into rows. The answer goes the other way: `answer` hands the
 * user's words to the session that asked, and the run waiting on them goes on. Nothing here decides
 * what a question means to a conversation. The engine hears the same events and moves its reply
 * between `working` and `waiting_for_input`.
 */
import type { InboxResponse, InteractionView } from "@eta/client-contracts";
import type { AskObserver } from "@eta/harness";
import type { SessionMeta, SessionsService } from "@eta/server";
import type { Timeline } from "../conversations/timeline";
import type { InteractionStore } from "./store";
import { interactionId } from "./store";

/** How many settled questions the list carries after the pending ones. */
export const HISTORY_LIMIT = 100;

export interface InboxDeps {
  interactions: InteractionStore;
  timeline: Timeline;
  /** Say that the inbox moved, to whoever is looking at it. */
  changed: () => void;
  warn: (message: string) => void;
}

export class Inbox {
  readonly #interactions: InteractionStore;
  readonly #timeline: Timeline;
  readonly #changed: () => void;
  readonly #warn: (message: string) => void;
  /**
   * The answers on their way to a session. The ask channel tells its observer that a question was
   * answered but not with what, so the answer waits here for the moment the observer hears it.
   */
  readonly #answering = new Map<string, InboxResponse>();

  constructor(deps: InboxDeps) {
    this.#interactions = deps.interactions;
    this.#timeline = deps.timeline;
    this.#changed = deps.changed;
    this.#warn = deps.warn;
  }

  /** Every pending question, then the latest settled ones. */
  list(): InteractionView[] {
    return [
      ...this.#interactions.pending(),
      ...this.#interactions.settled(HISTORY_LIMIT),
    ];
  }

  /** One session's questions, recorded as they happen. Never lets a bookkeeping error reach the run. */
  readonly askObserve = (meta: SessionMeta): AskObserver => {
    return (action, payload) => {
      try {
        const id = interactionId(meta.id, payload.questionId);
        let row: InteractionView | undefined;
        if (action === "asked") {
          row = this.#interactions.open({
            sessionId: meta.id,
            questionId: payload.questionId,
            prompt: payload.question,
            options: payload.options ?? [],
            multi: payload.multi === true,
            agentId: meta.agentId ?? null,
            conversationId: meta.conversationId ?? null,
            replyId: this.#replyOf(meta),
          });
        } else if (action === "answered") {
          const response = this.#answering.get(id);
          row = this.#interactions.settle(
            id,
            // "No answer" is a user who declined, and the model is told so.
            response?.kind === "none" ? "canceled" : "answered",
            response ?? null,
          );
        } else {
          row = this.#interactions.settle(id, action);
        }
        if (row !== undefined) this.#changed();
      } catch (error) {
        this.#warn(`[eta] could not record a question: ${String(error)}`);
      }
    };
  };

  /**
   * The user's answer, on its way to the run that is waiting for it. Answering a question that is
   * no longer pending changes nothing and says so. A question whose session is no longer waiting
   * on it (the run gave up first) ends as expired rather than staying a card nobody can act on.
   */
  async answer(
    sessions: SessionsService,
    id: string,
    response: InboxResponse,
  ): Promise<{ interaction: InteractionView; answered: boolean }> {
    const row = this.#interactions.get(id);
    if (row === undefined) throw new Error(`no such question: ${id}`);
    if (row.status !== "pending") return { interaction: row, answered: false };

    this.#answering.set(id, response);
    let delivered: boolean;
    try {
      delivered = await sessions.answer(
        row.sessionId,
        row.questionId,
        response,
      );
    } finally {
      this.#answering.delete(id);
    }
    if (!delivered && this.#interactions.settle(id, "expired") !== undefined)
      this.#changed();
    return { interaction: this.#interactions.get(id)!, answered: delivered };
  }

  /** The reply this session is answering, if it is answering one: where the question came from. */
  #replyOf(meta: SessionMeta): string | null {
    if (meta.agentId === undefined || meta.conversationId === undefined)
      return null;
    const running = this.#timeline
      .active(meta.conversationId)
      .find(
        (row) =>
          row.agentId === meta.agentId &&
          (row.status === "working" ||
            row.status === "waiting_for_input" ||
            row.status === "stopping"),
      );
    return running?.id ?? null;
  }
}
