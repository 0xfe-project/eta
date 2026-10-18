/**
 * PersonaService — the persona primitive (in-memory only).
 *
 * Card storage and the active-persona switch live here; fs discovery and
 * fs.watch hot-reload are the server's job (REFACTOR.md §2.3.2). Missing
 * cards degrade, they never kill the session: the switch reports them,
 * emits `persona:missing` per id, and carries on with what it has.
 */

import type { Context } from "cordis";
import { Service } from "cordis";
import type { Emit } from "../types/events";
import { kernelEmit } from "../types/events";
import type { PersonaCard } from "../types/persona";

export class PersonaService extends Service {
  static readonly provide = "persona";

  private cards = new Map<string, PersonaCard>();
  private activeNames: string[] = [];
  private readonly emit: Emit;

  constructor(ctx: Context) {
    super(ctx, "persona");
    this.emit = kernelEmit(ctx);
  }

  /** Replace the card registry (the server calls this after discovery). */
  loadCards(cards: PersonaCard[]): void {
    this.cards = new Map(cards.map((c) => [c.id, c]));
    for (const card of cards) this.emit("persona:loaded", { card });
    // Re-resolve the active set: a reload may have fixed or broken a card.
    if (this.activeNames.length > 0) this.setActive(this.activeNames);
  }

  get(id: string): PersonaCard | undefined {
    return this.cards.get(id);
  }

  list(): PersonaCard[] {
    return [...this.cards.values()];
  }

  active(): PersonaCard[] {
    return this.activeNames.flatMap((name) => {
      const card = this.cards.get(name);
      return card === undefined ? [] : [card];
    });
  }

  activeNamesList(): string[] {
    return [...this.activeNames];
  }

  /**
   * Switch the active personas. Missing ids are reported via the event and
   * `persona:missing` per id; the session continues with the found cards.
   */
  setActive(names: string[]): { active: PersonaCard[]; missing: string[] } {
    this.activeNames = [...names];
    const active: PersonaCard[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const card = this.cards.get(name);
      if (card === undefined) missing.push(name);
      else active.push(card);
    }
    for (const id of missing) this.emit("persona:missing", { id });
    this.emit("persona:switched", { active, missing });
    return { active, missing };
  }
}
