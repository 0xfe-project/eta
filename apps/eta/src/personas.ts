import type { PersonaCard } from "@eta/core";
import { discoverPersonas, summarize } from "@eta/server";

/**
 * Persona cards, as this host finds them.
 *
 * The rules are `@eta/server`'s (`discoverPersonas`): the harness's built-in cards are the floor
 * of one namespace, `~/.eta/persona/<id>.persona.md` applies everywhere, and
 * `<cwd>/.eta/persona/<id>.persona.md` applies in one project — the project's card wins on a name
 * clash, because a project that has an opinion about `Executor` means it.
 *
 * Two readers, one directory set each:
 *
 * - a session's cards are the ones for *its own* directory, which is what the manager loads when
 *   the session opens (`personasFor`);
 * - the picker in the interface is not standing in a session, so it shows the union — every
 *   group's cards plus the home directory's — because the name it writes is resolved again in the
 *   directory of whichever conversation the agent ends up in.
 *
 * Read every time, never cached: dropping a file in is meant to show up without a restart, and a
 * card that cannot be read is simply absent (a session must not fail to open over a malformed file
 * in a directory it never named).
 */
export interface PersonaSourceOptions {
  home: string;
  warn?: ((message: string) => void) | undefined;
}

/** The cards that apply in one directory. */
export async function personaCardsFor(
  cwd: string,
  options: PersonaSourceOptions,
): Promise<Map<string, PersonaCard>> {
  return discoverPersonas({
    cwd,
    home: options.home,
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  });
}

/** The cards the picker lists: the home directory's, with each project's layered on top. */
export async function allPersonaCards(
  cwds: readonly string[],
  options: PersonaSourceOptions,
): Promise<Map<string, PersonaCard>> {
  // The home directory alone is the floor: passing it as both the working directory and the home
  // directory reads its cards once and leaves the built-ins under them.
  const merged = await personaCardsFor(options.home, options);
  const claimed = new Set<string>();
  for (const cwd of [...new Set(cwds)].sort()) {
    if (cwd.length === 0) continue;
    for (const [id, card] of await personaCardsFor(cwd, options)) {
      // Within one directory's map, the cards that came from the floor are the ones whose words
      // are unchanged; whatever differs is this project's own card.
      if (card.content === merged.get(id)?.content) continue;
      // One name, one entry: two projects may both hold `Executor`, and the picker cannot show
      // both. The first in directory order keeps it — deterministic, and the entry is only ever a
      // *name* that each session resolves again in its own directory.
      if (claimed.has(id)) continue;
      claimed.add(id);
      merged.set(id, card);
    }
  }
  return merged;
}

/** What the picker shows, in a shape the wire keeps. */
export function personaList(cards: Map<string, PersonaCard>): {
  id: string;
  name: string;
  description: string;
  custom: boolean;
}[] {
  return summarize(cards);
}
