/**
 * `conversations.<id>`: one target per conversation, with its facts, its members and the newest
 * window of its timeline.
 *
 * Registered for every conversation when the plugin starts and for each new one as it is made, so
 * a client can subscribe to a conversation it learned of from the list. A conversation is never
 * removed, so nothing here takes one back until the plugin goes.
 */
import type { WireService } from "@eta/server";
import type { ViewDeps } from "./views";
import { publish } from "../wire";
import { infoOf, membersOf } from "./views";

/** How many of the newest rows the `timeline` section carries; `history` pages back from there. */
const TIMELINE_WINDOW = 50;

export class ConversationTargets {
  readonly #deps: ViewDeps;
  readonly #offs = new Map<string, () => void>();
  #wire: WireService | undefined;

  constructor(deps: ViewDeps) {
    this.#deps = deps;
  }

  /** Start publishing: every conversation there is, and (via `add`) every one made later. */
  attach(wire: WireService): void {
    this.#wire = wire;
    for (const conversation of this.#deps.conversations.list())
      this.add(conversation.id);
  }

  add(id: string): void {
    const wire = this.#wire;
    if (wire === undefined || this.#offs.has(id)) return;
    const { conversations, timeline } = this.#deps;
    const conversation = () => {
      const found = conversations.get(id);
      if (found === undefined) throw new Error(`no such conversation: ${id}`);
      return found;
    };
    this.#offs.set(
      id,
      publish(wire, `conversations.${id}`, {
        info: () => infoOf(this.#deps, conversation()),
        members: () => membersOf(this.#deps, id),
        timeline: () => timeline.window(id, TIMELINE_WINDOW),
      }),
    );
  }

  dispose(): void {
    this.#wire = undefined;
    for (const off of this.#offs.values()) off();
    this.#offs.clear();
  }
}
