/**
 * Interactions: the questions waiting for a human (REFACTOR.md §9, P2.6 — 审批 = ask).
 *
 * The row is the durable half of an ask. The session that asked is parked on a promise inside the
 * harness's ask registry; this table is what a client reads to know a question exists, and what a
 * restart reads to re-surface one that was never answered. The two halves share an id — the model's
 * tool call id — which is what makes "the card you are looking at" and "the question that run is
 * waiting on" the same thing.
 *
 * `revision` grows on every change, for the same reason the timeline rows have one: a client tells
 * "the same card, newer" from "a second card" by it, and applying the same revision twice is
 * harmless.
 */
import type { Database } from "bun:sqlite";

interface InteractionOption {
  value: string;
  label: string;
}

/** Where an interaction is in its life. `pending` is the only state that wants an answer. */
type InteractionStatus = "pending" | "resolved" | "expired";

export interface InteractionRecord {
  id: string;
  groupId: string;
  agentId: string;
  /** The reply row this question came out of, when the ask happened inside a group's run. */
  messageId: string;
  sessionId: string;
  kind: "choice";
  prompt: string;
  options: InteractionOption[];
  status: InteractionStatus;
  /** What the user chose; `undefined` while it is still pending. */
  answer?: string | undefined;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpenInteractionInput {
  id: string;
  sessionId: string;
  prompt: string;
  options?: readonly string[] | undefined;
  groupId?: string | undefined;
  agentId?: string | undefined;
  messageId?: string | undefined;
}

interface Row {
  id: string;
  group_id: string;
  agent_id: string;
  message_id: string;
  session_id: string;
  kind: string;
  prompt: string;
  options: string;
  status: string;
  answer: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

const statusOf = (value: string): InteractionStatus =>
  value === "resolved"
    ? "resolved"
    : value === "expired"
      ? "expired"
      : "pending";

const optionOf = (value: unknown): InteractionOption => {
  const candidate = (value ?? {}) as { value?: unknown; label?: unknown };
  const text = typeof candidate.value === "string" ? candidate.value : "";
  return {
    value: text,
    // A question asked with bare option titles has the title as both: there is only one word for
    // it, and inventing a second would be inventing information.
    label: typeof candidate.label === "string" ? candidate.label : text,
  };
};

const toRecord = (row: Row): InteractionRecord => ({
  id: row.id,
  groupId: row.group_id,
  agentId: row.agent_id,
  messageId: row.message_id,
  sessionId: row.session_id,
  kind: "choice",
  prompt: row.prompt,
  options: (JSON.parse(row.options) as unknown[]).map(optionOf),
  status: statusOf(row.status),
  ...(row.answer === null ? {} : { answer: row.answer }),
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class InteractionStore {
  readonly #handle: Database;

  constructor(handle: Database) {
    this.#handle = handle;
  }

  /**
   * The question is recorded before anyone waits on it.
   *
   * The id is the ask's own, so asking the same question twice — a replayed session re-driving the
   * same tool call — finds its row rather than writing a second card.
   */
  open(input: OpenInteractionInput): InteractionRecord {
    const now = new Date().toISOString();
    const options = (input.options ?? []).map((title) => ({
      value: title,
      label: title,
    }));
    this.#handle
      .query(
        `INSERT OR IGNORE INTO interaction
           (id, group_id, agent_id, message_id, session_id, kind, prompt, options, status, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'choice', ?, ?, 'pending', 1, ?, ?)`,
      )
      .run(
        input.id,
        input.groupId ?? "",
        input.agentId ?? "",
        input.messageId ?? "",
        input.sessionId,
        input.prompt,
        JSON.stringify(options),
        now,
        now,
      );
    return this.get(input.id)!;
  }

  /**
   * The human answered. Only a pending card changes: an answer that arrives after the run gave up
   * has nothing to resolve, and saying so is better than a revision that lies.
   */
  resolve(id: string, answer: string): InteractionRecord | undefined {
    const changed = this.#handle
      .query(
        `UPDATE interaction
            SET status = 'resolved', answer = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(answer, new Date().toISOString(), id);
    return changed.changes === 0 ? undefined : this.get(id);
  }

  /** Nobody is waiting any more — the caller canceled, or the deadline passed. */
  expire(id: string): InteractionRecord | undefined {
    const changed = this.#handle
      .query(
        `UPDATE interaction SET status = 'expired', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), id);
    return changed.changes === 0 ? undefined : this.get(id);
  }

  /** The run this question belonged to ended: nobody is waiting any more, and the card is over. */
  expireForReply(messageId: string): InteractionRecord[] {
    if (messageId.length === 0) return [];
    const rows = this.#handle
      .query(
        "SELECT id FROM interaction WHERE message_id = ? AND status = 'pending'",
      )
      .all(messageId) as { id: string }[];
    const expired: InteractionRecord[] = [];
    for (const row of rows) {
      const changed = this.#handle
        .query(
          `UPDATE interaction SET status = 'expired', revision = revision + 1, updated_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(new Date().toISOString(), row.id);
      if (changed.changes === 0) continue;
      const record = this.get(row.id);
      if (record !== undefined) expired.push(record);
    }
    return expired;
  }

  get(id: string): InteractionRecord | undefined {
    const row = this.#handle
      .query("SELECT * FROM interaction WHERE id = ?")
      .get(id) as Row | null;
    return row === null ? undefined : toRecord(row);
  }

  /** The ones still waiting, newest first: what a snapshot shows and a "pending" page lists. */
  pending(): InteractionRecord[] {
    return (
      this.#handle
        .query(
          "SELECT * FROM interaction WHERE status = 'pending' ORDER BY created_at DESC",
        )
        .all() as Row[]
    ).map(toRecord);
  }

  /** The cards of one session — what the panel counts beside the tools a run was stopped on. */
  ofSession(sessionId: string): InteractionRecord[] {
    return (
      this.#handle
        .query(
          "SELECT * FROM interaction WHERE session_id = ? ORDER BY created_at DESC",
        )
        .all(sessionId) as Row[]
    ).map(toRecord);
  }

  /** Every card there has been, newest first, whatever became of it. */
  list(limit: number): InteractionRecord[] {
    return (
      this.#handle
        .query("SELECT * FROM interaction ORDER BY created_at DESC LIMIT ?")
        .all(limit) as Row[]
    ).map(toRecord);
  }
}
