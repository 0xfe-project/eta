/**
 * What the composer's one menu offers, and why.
 *
 * There is a single menu because there is a single thing to be completed — "who or what am I
 * referring to". Two keys open it: `/` for commands (the whole draft has to be `/name`, which is
 * what makes a slash at the start of a sentence not a command) and `@` for references, which can
 * mix two kinds:
 *
 * - members of this group, first, because in a group "who" is the question the message answers.
 *   eta-old had only files here; a group needs people, and putting them below a file list would
 *   bury the more likely answer.
 * - project files, scored by the same fuzzy rule eta-old used: a run of matching characters
 *   counts more than scattered ones, and a match at a word boundary counts more than one in the
 *   middle.
 *
 * Pure functions, all of it: the menu is the part of the composer that has rules, so it is the
 * part that can be tested without a browser.
 */

export interface MenuMember {
  id: string;
  name: string;
  /** Answering right now; the row says so instead of pretending it is free. */
  busy: boolean;
}

export type MenuItem =
  | {
      kind: "member";
      value: string;
      label: string;
      hint: string;
      memberId: string;
    }
  | { kind: "file"; value: string; label: string }
  | { kind: "command"; value: string; label: string; description: string };

export interface MenuState {
  kind: "slash" | "at";
  query: string;
  /** Where the query starts in the draft, so a pick can replace exactly that. */
  start: number;
  items: MenuItem[];
}

/** How many rows each source may contribute: enough to choose from, short enough to read. */
const MAX_MEMBERS = 8;
const MAX_FILES = 8;
const MAX_COMMANDS = 8;

/**
 * eta-old's scoring, kept as it was: consecutive hits and word boundaries are what make one
 * candidate obviously right, and a candidate that misses any character scores -1.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] === q[qi]) {
      streak += 1;
      qi += 1;
      const boundary = i === 0 || /[/.\-_\\]/.test(t[i - 1] ?? "/");
      score += 1 + streak * 2 + (boundary ? 3 : 0);
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

/**
 * The `@` being typed, if the caret is in one.
 *
 * `\s` or a CJK punctuation mark before the `@` — Chinese has no spaces, so `，@` is a mention too,
 * and a rule that only knows about spaces would make the feature English-only.
 */
export function mentionAt(
  text: string,
): { query: string; start: number } | null {
  const match = /(?:^|[\s，。！？、；：,.!?;:])@([^\s@]*)$/.exec(text);
  if (match === null) return null;
  const query = match[1] ?? "";
  return { query, start: text.length - query.length - 1 };
}

/** `/name` — the whole draft, no spaces: a slash inside a sentence is a slash. */
export function slashAt(text: string): { query: string; start: number } | null {
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  if (/\s/.test(text)) return null;
  return { query: text.slice(1).toLowerCase(), start: 0 };
}

export function buildMenu(input: {
  text: string;
  members: readonly MenuMember[];
  files: readonly string[];
  commands: readonly { name: string; description: string }[];
  dismissed: boolean;
}): MenuState | null {
  if (input.dismissed) return null;

  const mention = mentionAt(input.text);
  if (mention !== null) {
    const query = mention.query.toLowerCase();
    // Members first: in a group, "who am I talking to" is the question the composer answers, and
    // a file list above the people would bury it.
    const members: MenuItem[] = input.members
      .filter((member) => member.name.toLowerCase().includes(query))
      .sort((a, b) => fuzzyScore(query, b.name) - fuzzyScore(query, a.name))
      .slice(0, MAX_MEMBERS)
      .map((member) => ({
        kind: "member" as const,
        value: `@${member.name} `,
        label: member.name,
        hint: member.busy ? "busy" : "",
        memberId: member.id,
      }));
    const files: MenuItem[] = input.files
      .map((file) => ({ file, score: fuzzyScore(query, file) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_FILES)
      .map((entry) => ({
        kind: "file" as const,
        value: `@${entry.file} `,
        label: entry.file,
      }));
    const items = [...members, ...files];
    return items.length === 0
      ? null
      : { kind: "at", query: mention.query, start: mention.start, items };
  }

  const slash = slashAt(input.text);
  if (slash === null) return null;
  const items: MenuItem[] = input.commands
    .filter((command) => command.name.slice(1).startsWith(slash.query))
    .slice(0, MAX_COMMANDS)
    .map((command) => ({
      kind: "command" as const,
      value: command.name,
      label: command.name,
      description: command.description,
    }));
  return items.length === 0
    ? null
    : { kind: "slash", query: slash.query, start: slash.start, items };
}

/** Replace the completed range with the pick. Commands take the whole draft; mentions do not. */
export function applyItem(
  text: string,
  menu: MenuState,
  item: MenuItem,
): { text: string; command?: { name: string; args: string } } {
  if (item.kind === "command")
    return { text: "", command: { name: item.value, args: "" } };
  return { text: `${text.slice(0, menu.start)}${item.value}` };
}

/**
 * A command line split into the verb and its arguments: `/goal ship it` is the `goal` command
 * with `ship it`. eta-old did this so a command could carry a payload; without it every command
 * is a button and nothing else.
 */
export function splitCommand(
  line: string,
): { name: string; args: string } | null {
  if (!line.startsWith("/") || line.startsWith("//")) return null;
  const [head, ...rest] = line.slice(1).split(/\s+/);
  if (head === undefined || head.length === 0) return null;
  return { name: `/${head.toLowerCase()}`, args: rest.join(" ").trim() };
}
