/**
 * The composer's completion menu: slash commands while the first word is being typed, members,
 * everyone and project files after an `@`.
 */
import type { Locale } from "../../../config/types";
import type { SlashCommand } from "../../../extensions/types";
import type { ComposerState } from "./state";
import { mentionLabel } from "../model/mentions";
import { replaceRange } from "./state";

/** The most entries the `@` menu lists: members, everyone and files together. */
export const MENTION_LIMIT = 8;

/** The names `model/mentions.ts` reads as everyone, by language. */
const EVERYONE_LABELS: Record<Locale, string> = {
  en: "everyone",
  zh: "所有人",
};

/** What is being completed: the text after `/` or `@`, which starts at `start`. */
export type CompletionQuery =
  | { kind: "slash"; query: string; start: number }
  | { kind: "mention"; query: string; start: number };

export type CompletionItem =
  | { kind: "command"; command: SlashCommand }
  | { kind: "member"; id: string; label: string }
  | { kind: "everyone"; label: string }
  | { kind: "file"; path: string };

export interface CompletionSources {
  completeCommand: (prefix: string) => SlashCommand[];
  members: readonly { id: string; name: string }[];
  locale: Locale;
  /** The project's files; undefined while they load or when they could not be loaded. */
  files: readonly string[] | undefined;
}

/** The menu as it shows: what it completes and what it lists. */
export interface OpenMenu {
  query: CompletionQuery;
  items: CompletionItem[];
}

const WORD_BEFORE_CURSOR = /(?:^|\s)(@\S*)$/;

export function completionQuery(
  state: ComposerState,
): CompletionQuery | undefined {
  const before = state.text.slice(0, state.cursor);
  if (before.startsWith("/") && !/\s/.test(before))
    return { kind: "slash", query: before.slice(1), start: 0 };
  const mention = WORD_BEFORE_CURSOR.exec(before)?.[1];
  if (mention === undefined) return undefined;
  return {
    kind: "mention",
    query: mention.slice(1),
    start: before.length - mention.length,
  };
}

export function slashItems(
  query: string,
  completeCommand: CompletionSources["completeCommand"],
): CompletionItem[] {
  return completeCommand(query).map((command) => ({
    kind: "command",
    command,
  }));
}

/**
 * Members whose label contains the query, those starting with it first; then everyone; then files
 * whose path contains it. Case does not matter. At most `MENTION_LIMIT` in all.
 */
export function mentionItems(
  query: string,
  { members, locale, files }: Omit<CompletionSources, "completeCommand">,
): CompletionItem[] {
  const wanted = query.toLowerCase();
  const holds = (text: string) => text.toLowerCase().includes(wanted);
  const labelled = members
    .map((member) => ({ id: member.id, label: mentionLabel(member, members) }))
    .filter((member) => holds(member.label));
  const startsWithQuery = (label: string) =>
    label.toLowerCase().startsWith(wanted);
  const memberItems: CompletionItem[] = [
    ...labelled.filter((member) => startsWithQuery(member.label)),
    ...labelled.filter((member) => !startsWithQuery(member.label)),
  ].map((member) => ({ kind: "member", ...member }));
  const everyone: CompletionItem[] = Object.values(EVERYONE_LABELS).some(holds)
    ? [{ kind: "everyone", label: EVERYONE_LABELS[locale] }]
    : [];
  const fileItems: CompletionItem[] = (files ?? [])
    .filter(holds)
    .map((path) => ({ kind: "file", path }));
  return [...memberItems, ...everyone, ...fileItems].slice(0, MENTION_LIMIT);
}

/** The menu for the state, or undefined when it is closed: nothing to complete, nothing listed, or dismissed. */
export function menuOf(
  state: ComposerState,
  sources: CompletionSources,
): OpenMenu | undefined {
  if (state.menu.dismissed) return undefined;
  const query = completionQuery(state);
  if (query === undefined) return undefined;
  const items =
    query.kind === "slash"
      ? slashItems(query.query, sources.completeCommand)
      : mentionItems(query.query, sources);
  return items.length === 0 ? undefined : { query, items };
}

/** What accepting the item writes in place of what is being completed. */
function completionText(item: CompletionItem): string {
  switch (item.kind) {
    case "command":
      return `/${item.command.name} `;
    case "member":
    case "everyone":
      return `@${item.label} `;
    case "file":
      return `@${item.path} `;
  }
}

/**
 * Accepts an item: a command replaces the first word, a mention replaces `@query`. The cursor
 * goes after the inserted text.
 */
export function acceptCompletion(
  state: ComposerState,
  query: CompletionQuery,
  item: CompletionItem,
): ComposerState {
  const end = query.kind === "slash" ? state.text.search(/\s|$/) : state.cursor;
  return replaceRange(state, query.start, end, completionText(item));
}
