/**
 * Searching across sessions.
 *
 * Two questions a sidebar's search box asks, and they are answered differently:
 *
 * - **What is in one session's history?** Paging through a transcript is `history`, and it is
 *   answered from the session's *journal* — the whole conversation, not the windowed view a client
 *   happens to hold. A client that scrolled past what it has asks for what came before a sequence
 *   number and gets it.
 * - **Which session mentions this?** That is a grep across every journal. It reads entries rather
 *   than the views, because the view is a window and a match outside the window is exactly the one
 *   worth finding.
 *
 * Both walk the *branch* (the current tip's ancestry), not the file: an entry the branch does not
 * include is history the user rewound past, and showing it in a search result would be showing
 * something the session does not say any more. The branch is what a session's own `SessionLog`
 * already holds, so both take entries rather than reaching for storage.
 */
import type { AgentMessage } from "@eta/core";
import type { Entry } from "@eta/core/session";
import { systemRowOf, type ViewSystemRow } from "@eta/harness";

/** One row of a transcript page. */
export interface HistoryRow {
  entryId: string;
  seq: number;
  at: number;
  message: AgentMessage;
}

/** One search hit: which session, and the text around the match. */
export interface SearchHit {
  session: string;
  entryId: string;
  seq: number;
  /** The readable text of the message the match was in, around the match. */
  snippet: string;
}

/** How much of the message a snippet shows, either side of the match. */
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 120;

/**
 * The readable text of a message.
 *
 * Only text blocks: an image is not searchable, and a tool call's arguments are JSON that would
 * match every query about anything the model ever asked for.
 */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: { type?: string; text?: unknown }) =>
      block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join(" ")
    .trim();
}

/**
 * A page of a session's transcript, oldest-first, ending just before `beforeSeq`.
 *
 * `beforeSeq` is exclusive, and a page is asked for by sequence rather than by offset: the journal
 * only grows, so a sequence is a stable cursor while an offset would shift under the reader every
 * time a new turn landed. `beforeSeq: undefined` means "the newest page".
 *
 * The page is taken from the branch's *messages*, so a page boundary can fall between two messages
 * even when something else (a goal entry, a task edit) sits between them — which is what a
 * transcript view means by history.
 */
export function historyOf(
  entries: readonly Entry[],
  options: { beforeSeq?: number | undefined; limit: number },
): HistoryRow[] {
  const messages = branchMessages(entries);
  const before = options.beforeSeq;
  // The cursor is exclusive: everything older than it is what this page may draw from.
  const end =
    before === undefined
      ? messages.length
      : messages.filter((row) => row.seq < before).length;
  const start = Math.max(0, end - Math.max(0, options.limit));
  return messages.slice(start, end);
}

/** A history page: its messages, and the system rows (a failed run, a goal…) that sit among them. */
export interface HistoryPage {
  rows: HistoryRow[];
  systems: ViewSystemRow[];
}

/**
 * A page of a session's history, cut by `historyOf`, plus the system rows in the same span.
 *
 * The span is the page's own: from its oldest message (or the start of the branch, when the
 * page reaches it) to just before `beforeSeq`. Paging back by the oldest row's seq then hands
 * every system row out exactly once — which is how a client that never saw a run fail live
 * still finds the record of it.
 */
export function historyPageOf(
  entries: readonly Entry[],
  options: { beforeSeq?: number | undefined; limit: number },
): HistoryPage {
  const rows = historyOf(entries, options);
  const firstMessage = branchMessages(entries)[0];
  const oldest = rows[0];
  const from =
    oldest === undefined || oldest.entryId === firstMessage?.entryId
      ? -Infinity
      : oldest.seq;
  const before = options.beforeSeq ?? Infinity;
  const systems: ViewSystemRow[] = [];
  for (const entry of entries) {
    if (entry.seq < from || entry.seq >= before) continue;
    const row = systemRowOf(entry);
    if (row !== undefined) systems.push(row);
  }
  return { rows, systems };
}

/** Every message on a branch, oldest first — what a search walks. */
export function branchMessages(entries: readonly Entry[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    rows.push({
      entryId: entry.id,
      seq: entry.seq,
      at: entry.timestamp,
      message: entry.message,
    });
  }
  return rows;
}

/** Where `needle` first appears in `text`, case-insensitively. */
function indexOfIgnoreCase(text: string, needle: string): number {
  return text.toLowerCase().indexOf(needle.toLowerCase());
}

/**
 * The first match in one session's branch, as a snippet — or `undefined` when there is none.
 *
 * One hit per session is deliberate: the search box's answer is "this session has it, and here is
 * roughly where", and a list of twenty matches inside one long conversation is not more useful than
 * the conversation itself.
 */
export function firstHit(
  session: string,
  entries: readonly Entry[],
  query: string,
): SearchHit | undefined {
  const needle = query.trim();
  if (needle.length === 0) return undefined;
  for (const row of branchMessages(entries)) {
    const text = messageText(row.message);
    if (text.length === 0) continue;
    const index = indexOfIgnoreCase(text, needle);
    if (index < 0) continue;
    return {
      session,
      entryId: row.entryId,
      seq: row.seq,
      snippet: text.slice(
        Math.max(0, index - SNIPPET_BEFORE),
        index + SNIPPET_AFTER,
      ),
    };
  }
  return undefined;
}
