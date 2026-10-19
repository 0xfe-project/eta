/**
 * What a woken agent is told.
 *
 * An agent sees the conversation through its own session, and its session only heard what was
 * said *to* it. Everything else, the user's other messages and what the other agents answered,
 * arrives with the next wake: the rows after the agent's `lastSeq`, with who said them, and then
 * the message that woke it. Pure, so the rule about what counts as seen is read in one place.
 */
import type { MessageView } from "@eta/client-contracts";

/** The most earlier rows a briefing carries; a long backlog is cut to its newest part. */
const MAX_EARLIER = 100;
/** The most of one row's text a briefing carries. */
const MAX_TEXT = 2_000;

const IN_FLIGHT = new Set([
  "queued",
  "working",
  "waiting_for_input",
  "stopping",
]);

export interface Briefing {
  text: string;
  /** How far the agent has now been shown: the member's new `lastSeq`. */
  seen: number;
}

export function briefing(input: {
  conversation: string;
  /** The agent being told. */
  me: string;
  /** What it has been shown so far. */
  lastSeq: number;
  /** Every row past `lastSeq`, oldest first (the trigger among them, normally). */
  rows: readonly MessageView[];
  /** The row that woke it. */
  trigger: MessageView;
  nameOf: (message: MessageView) => string;
  /** Lines naming the files a row came with, where the agent can open them. */
  filesOf?: (message: MessageView) => readonly string[];
}): Briefing {
  const filesOf = input.filesOf ?? (() => []);
  const earlier: string[] = [];
  let seen = input.lastSeq;
  // A reply still being written is not readable yet, and the mark must not move past it, or its
  // text would never be shown once it lands. Everything after it is shown now and shown again.
  let blocked = false;
  for (const row of input.rows) {
    const mine = row.author === "agent" && row.agentId === input.me;
    if (row.id === input.trigger.id || mine) {
      if (!blocked) seen = Math.max(seen, row.seq);
      continue;
    }
    if (IN_FLIGHT.has(row.status)) {
      blocked = true;
      continue;
    }
    if (!blocked) seen = Math.max(seen, row.seq);
    // A reply that ended with nothing to say (stopped before it began) is not news.
    const files = filesOf(row);
    if (row.text.trim() === "" && files.length === 0) continue;
    earlier.push(
      [`- ${input.nameOf(row)}: ${clip(row.text)}`, ...files].join("\n"),
    );
  }

  const omitted = Math.max(0, earlier.length - MAX_EARLIER);
  const lines = omitted > 0 ? earlier.slice(omitted) : earlier;
  const parts = [`[conversation: ${input.conversation}]`];
  if (lines.length > 0) {
    parts.push(
      "Since you last looked:",
      ...(omitted > 0 ? [`(${omitted} earlier messages left out)`] : []),
      ...lines,
      "",
    );
  }
  parts.push(
    `${input.nameOf(input.trigger)} says:`,
    input.trigger.text,
    ...filesOf(input.trigger),
  );
  return { text: parts.join("\n"), seen };
}

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}...`;
}
