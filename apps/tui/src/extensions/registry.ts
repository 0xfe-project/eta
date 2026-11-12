import type { Extension, PinnedTab, SlashCommand, TabView } from "./types";

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

/** Everything the features registered, checked once at start. */
export interface Registry {
  readonly extensions: readonly Extension[];
  /** Every slash command, sorted by name. */
  readonly commands: readonly SlashCommand[];
  command: (name: string) => SlashCommand | undefined;
  /** The commands whose English name starts with `prefix` (no slash), sorted by name. */
  complete: (prefix: string) => SlashCommand[];
  view: (kind: string) => TabView | undefined;
  /** In the order of the extensions that registered them. */
  readonly pinnedTabs: readonly PinnedTab[];
}

/** Lists where each name occurs and returns the names that occur more than once. */
function duplicates(entries: { name: string; owner: string }[]): string[] {
  const owners = new Map<string, string[]>();
  for (const { name, owner } of entries)
    owners.set(name, [...(owners.get(name) ?? []), owner]);
  return [...owners]
    .filter(([, list]) => list.length > 1)
    .map(([name, list]) => `"${name}" (extensions ${list.join(", ")})`);
}

/**
 * Builds the registry. Throws one error naming every problem: an extension id, command name, tab
 * kind or pinned tab id used twice, or a command name outside lower-case letters, digits and `-`.
 * Nothing is overridden silently, so a clash stops the program at start.
 */
export function createRegistry(extensions: readonly Extension[]): Registry {
  const commandEntries = extensions.flatMap((ext) =>
    (ext.commands ?? []).map((command) => ({ command, owner: ext.id })),
  );
  const problems = [
    ...duplicates(
      extensions.map((ext) => ({ name: ext.id, owner: ext.id })),
    ).map((d) => `Duplicate extension id ${d}`),
    ...commandEntries
      .filter(({ command }) => !COMMAND_NAME.test(command.name))
      .map(
        ({ command, owner }) =>
          `Invalid command name "${command.name}" in extension ${owner}: use lower-case letters, digits and -, starting with a letter`,
      ),
    ...duplicates(
      commandEntries.map(({ command, owner }) => ({
        name: `/${command.name}`,
        owner,
      })),
    ).map((d) => `Duplicate command ${d}`),
    ...duplicates(
      extensions.flatMap((ext) =>
        (ext.views ?? []).map((v) => ({ name: v.kind, owner: ext.id })),
      ),
    ).map((d) => `Duplicate tab kind ${d}`),
    ...duplicates(
      extensions.flatMap((ext) =>
        (ext.pinnedTabs ?? []).map((p) => ({ name: p.id, owner: ext.id })),
      ),
    ).map((d) => `Duplicate pinned tab id ${d}`),
  ];
  if (problems.length > 0)
    throw new Error(
      `The extensions do not fit together:\n${problems.join("\n")}`,
    );

  const commands = commandEntries
    .map(({ command }) => command)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const byName = new Map(commands.map((c) => [c.name, c]));
  const views = new Map(
    extensions.flatMap((ext) => (ext.views ?? []).map((v) => [v.kind, v])),
  );
  return {
    extensions,
    commands,
    command: (name) => byName.get(name),
    complete: (prefix) => commands.filter((c) => c.name.startsWith(prefix)),
    view: (kind) => views.get(kind),
    pinnedTabs: extensions.flatMap((ext) => ext.pinnedTabs ?? []),
  };
}
