/**
 * What a woken agent is told.
 *
 * An agent sees the conversation through its own session, and its session only heard what was
 * said *to* it. Everything else, the user's other messages and what the other agents answered,
 * arrives with the next wake: the rows after the agent's `lastSeq`, with who said them, and then
 * the message that woke it. Pure, so the rule about what counts as seen is read in one place.
 *
 * Each earlier row says who it was for and whether they have answered, a reply still being written
 * stands in its place as a line saying so, and the section ends by saying it is background: an
 * agent once took a question the user had put to another agent, who was answering it right then,
 * for one put to itself.
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

const BACKGROUND =
  "(The above is background: handled already, or not for you. Answer only the message below, unless it asks you to take up something above.)";

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
  /** An agent's name, for the agents a row was sent to. */
  agentName: (agentId: string) => string;
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
      // Its text is not final, but that it is being written is news: left out, a question being
      // answered right now reads as one nobody took up. Not for another agent answering the same
      // message as this one: that is not an earlier message.
      if (row.replyToId === input.trigger.id) continue;
      const to = input.rows.find((other) => other.id === row.replyToId);
      earlier.push(
        `- ${input.nameOf(row)} is still writing a reply${
          to === undefined
            ? ""
            : ` to ${possessive(input.nameOf(to))} message above`
        }`,
      );
      continue;
    }
    if (!blocked) seen = Math.max(seen, row.seq);
    // A reply that ended with nothing to say (stopped before it began) is not news.
    const files = filesOf(row);
    if (row.text.trim() === "" && files.length === 0) continue;
    const to = addressee(row, input);
    earlier.push(
      [
        `- ${input.nameOf(row)}: ${clip(row.text)}${to === "" ? "" : ` ${to}`}`,
        ...files,
      ].join("\n"),
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
      BACKGROUND,
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

/**
 * Who a row was sent to and whether they have answered it: `(to Opus; Opus replied)`. The agents
 * it woke (`data.woke`, or the names of an agent's mention) and the ones whose turn it steered
 * (`data.joined`); empty for a row that went to nobody.
 */
function addressee(
  row: MessageView,
  input: {
    me: string;
    rows: readonly MessageView[];
    agentName: (agentId: string) => string;
  },
): string {
  const ids = (key: string): string[] =>
    Array.isArray(row.data[key])
      ? (row.data[key] as unknown[]).filter(
          (id): id is string => typeof id === "string",
        )
      : [];
  const woke = Array.isArray(row.data.woke)
    ? ids("woke")
    : row.kind === "mention"
      ? row.mentions
      : [];
  const targets = [...new Set([...woke, ...ids("joined")])];
  if (targets.length === 0) return "";
  const name = (id: string) => (id === input.me ? "you" : input.agentName(id));
  const to = targets.map((id) =>
    id === input.me ? `${input.agentName(id)} — you` : input.agentName(id),
  );
  const replies = input.rows.filter(
    (reply) =>
      reply.author === "agent" &&
      reply.replyToId === row.id &&
      reply.agentId !== null &&
      targets.includes(reply.agentId),
  );
  // Replied: a reply of theirs that ended with something said. A reply still running is noted
  // too, so a question being answered right now is not taken up twice.
  const replied = targets.filter((id) =>
    replies.some(
      (reply) =>
        reply.agentId === id &&
        !IN_FLIGHT.has(reply.status) &&
        reply.text.trim() !== "",
    ),
  );
  const answering = targets.filter(
    (id) =>
      !replied.includes(id) &&
      replies.some(
        (reply) => reply.agentId === id && IN_FLIGHT.has(reply.status),
      ),
  );
  const notes = [`to ${to.join(", ")}`];
  if (replied.length > 0) notes.push(`${replied.map(name).join(", ")} replied`);
  if (answering.length > 0)
    notes.push(`${answering.map(name).join(", ")} still answering`);
  return `(${notes.join("; ")})`;
}

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}...`;
}
