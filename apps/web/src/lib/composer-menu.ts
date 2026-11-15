/**
 * What the composer's one menu offers, and why.
 *
 * There is a single menu because there is a single thing to be completed — "who or what am I
 * referring to". Three keys open it: `/` for commands (the whole draft has to be `/name`, which is
 * what makes a slash at the start of a sentence not a command) and `#` for tasks (`#10` reads as a
 * task number, so `#` offers nothing but the board's tasks), and `@` for references, which can mix
 * two kinds:
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
  | { kind: "command"; value: string; label: string; description: string }
  | {
      kind: "task";
      value: string;
      /** The title: the row shows the number, then this, then the status. */
      label: string;
      number: number;
      /** One of the board's statuses, kept a plain string so this file stays wire-free. */
      status: string;
    };

/** A task the `#` menu can complete to: what a row needs, and nothing else of the board's. */
export interface MenuTask {
  number: number;
  title: string;
  status: string;
  /** The group it is discussed in, which decides whether the row sorts first. */
  conversationId: string | null;
  updatedAt: number;
}

export interface MenuState {
  kind: "slash" | "at" | "hash";
  query: string;
  /** Where the query starts in the draft, so a pick can replace exactly that. */
  start: number;
  items: MenuItem[];
}

/** How many rows each source may contribute: enough to choose from, short enough to read. */
const MAX_MEMBERS = 8;
const MAX_FILES = 8;
const MAX_COMMANDS = 8;
const MAX_TASKS = 8;

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

/**
 * The `#` being typed, if the caret is in one.
 *
 * The same boundary as `@`, and for the same reason: `C#`, `F#` and a `#` that follows a word are
 * prose. The query runs to the next space or `#`, so typing a second hash starts a fresh query
 * instead of joining the first (`##` is nobody's task number, so it opens nothing).
 */
export function hashAt(text: string): { query: string; start: number } | null {
  const match = /(?:^|[\s，。！？、；：,.!?;:])#([^\s#]*)$/.exec(text);
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

/**
 * Whether two tasks differ by "is this the group being written in": 0 when they agree, negative or
 * positive when one of them is. A task with no group is `null` on the wire, so it cannot rank first
 * by accident.
 */
function groupFirst(
  a: MenuTask,
  b: MenuTask,
  groupId: string | undefined,
): number {
  const near = (task: MenuTask) =>
    groupId !== undefined && task.conversationId === groupId ? 0 : 1;
  return near(a) - near(b);
}

export function buildMenu(input: {
  text: string;
  members: readonly MenuMember[];
  files: readonly string[];
  commands: readonly { name: string; description: string }[];
  /** The board, for `#`. */
  tasks: readonly MenuTask[];
  /** The group the composer is writing in: its tasks are the ones in reach, so they come first. */
  groupId?: string;
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

  const hash = hashAt(input.text);
  if (hash !== null) {
    const query = hash.query.toLowerCase();
    const byNumber = /^\d+$/.test(query);
    const items: MenuItem[] = input.tasks
      .filter(
        (task) =>
          // `#1` finishes the numbers that begin with it, and any other query the same fuzzy rule
          // that reads file paths applies to the title.
          (byNumber && String(task.number).startsWith(query)) ||
          fuzzyScore(query, task.title) >= 0,
      )
      // This group's tasks, then everything else, each newest first: the number is what a person
      // types when they already know it, and the title is what they type when they do not.
      .sort(
        (a, b) => groupFirst(a, b, input.groupId) || b.updatedAt - a.updatedAt,
      )
      .slice(0, MAX_TASKS)
      .map((task) => ({
        kind: "task" as const,
        // A trailing space, as with `@name `: the pick is a whole reference, not a prefix.
        value: `#${task.number} `,
        label: task.title,
        number: task.number,
        status: task.status,
      }));
    return items.length === 0
      ? null
      : { kind: "hash", query: hash.query, start: hash.start, items };
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

/** Replace the completed range with the pick. Commands take the whole draft; references do not. */
export function applyItem(
  text: string,
  menu: MenuState,
  item: MenuItem,
): { text: string; command?: { name: string; args: string } } {
  if (item.kind === "command")
    return { text: "", command: { name: item.value, args: "" } };
  return { text: `${text.slice(0, menu.start)}${item.value}` };
}
