import type {
  MemberStatus,
  MessageKind,
  MessageStatus,
  MessageView,
} from "@eta/client-contracts";
/**
 * The timeline: what was said in a conversation, in the order it is read.
 *
 * A row is written once and then, for a reply, changed in place: it takes its `seq` when the
 * reply is queued and keeps it while the reply works, so the answer appears where the question
 * left room for it, and `revision` is what tells a newer copy from a second one. The statuses a
 * reply moves through are this file's whole state machine; the runner decides *when*, this
 * decides what is allowed.
 */
import type { Database } from "bun:sqlite";

/** Statuses of a reply that has not ended. */
const IN_FLIGHT: readonly MessageStatus[] = [
  "queued",
  "working",
  "waiting_for_input",
  "stopping",
];

const IN_FLIGHT_SQL = IN_FLIGHT.map((status) => `'${status}'`).join(", ");

interface Row {
  id: string;
  conversation_id: string;
  seq: number;
  kind: string;
  author: string;
  agent_id: string | null;
  text: string;
  thinking: string;
  status: string;
  revision: number;
  mentions: string;
  root_message_id: string | null;
  reply_to_id: string | null;
  data: string;
  created_at: number;
  updated_at: number;
}

/** A column that holds JSON can hold anything; a bad one degrades to empty. */
function parse<T>(
  raw: string,
  fallback: T,
  valid: (value: unknown) => boolean,
) {
  try {
    const value: unknown = JSON.parse(raw);
    return valid(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

const viewOf = (row: Row): MessageView => ({
  id: row.id,
  conversationId: row.conversation_id,
  seq: row.seq,
  kind: row.kind as MessageKind,
  author: row.author as MessageView["author"],
  agentId: row.agent_id,
  text: row.text,
  thinking: row.thinking,
  status: row.status as MessageStatus,
  revision: row.revision,
  mentions: parse<string[]>(
    row.mentions,
    [],
    (value) =>
      Array.isArray(value) && value.every((id) => typeof id === "string"),
  ),
  rootMessageId: row.root_message_id,
  replyToId: row.reply_to_id,
  data: parse<Record<string, unknown>>(
    row.data,
    {},
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface NewRow {
  /** The id to write the row under; a retried send finds its row by it. */
  id?: string | undefined;
  conversationId: string;
  kind: MessageKind;
  author: MessageView["author"];
  agentId?: string | null | undefined;
  text?: string | undefined;
  status?: MessageStatus | undefined;
  mentions?: readonly string[] | undefined;
  rootMessageId?: string | null | undefined;
  replyToId?: string | null | undefined;
  data?: Record<string, unknown> | undefined;
}

export class Timeline {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get(id: string): MessageView | undefined {
    const row = this.#db
      .query<Row, [string]>("SELECT * FROM message WHERE id = ?")
      .get(id);
    return row === null ? undefined : viewOf(row);
  }

  /** Write a row at the end of the timeline. The seq is taken in the same statement that bumps the count. */
  append(input: NewRow): MessageView {
    const id = input.id ?? crypto.randomUUID();
    const now = Date.now();
    this.#db.transaction(() => {
      const taken = this.#db
        .query<{ last_seq: number }, [number, string]>(
          "UPDATE conversation SET last_seq = last_seq + 1, updated_at = ? WHERE id = ? RETURNING last_seq",
        )
        .get(now, input.conversationId);
      if (taken === null)
        throw new Error(`no such conversation: ${input.conversationId}`);
      this.#db
        .query(
          `INSERT INTO message
             (id, conversation_id, seq, kind, author, agent_id, text, status, mentions,
              root_message_id, reply_to_id, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          taken.last_seq,
          input.kind,
          input.author,
          input.agentId ?? null,
          input.text ?? "",
          input.status ?? "done",
          JSON.stringify(input.mentions ?? []),
          input.rootMessageId ?? null,
          input.replyToId ?? null,
          JSON.stringify(input.data ?? {}),
          now,
          now,
        );
    })();
    return this.get(id)!;
  }

  /** A system row: something that happened to the conversation, not something said in it. */
  system(
    conversationId: string,
    text: string,
    data: Record<string, unknown>,
  ): MessageView {
    return this.append({
      conversationId,
      kind: "system",
      author: "system",
      text,
      data,
    });
  }

  /**
   * A reply, queued: its place in the timeline is taken now, and its text comes later. It descends
   * from the same user row as the row that woke it, which is what the wake budget counts under.
   */
  queueReply(
    conversationId: string,
    agentId: string,
    to: MessageView,
  ): MessageView {
    return this.append({
      conversationId,
      kind: "message",
      author: "agent",
      agentId,
      status: "queued",
      rootMessageId: to.rootMessageId ?? to.id,
      replyToId: to.id,
    });
  }

  /** Move a reply from one of the statuses in `from` to `to`. Undefined when it was not in one of them. */
  transition(
    id: string,
    from: readonly MessageStatus[],
    to: MessageStatus,
  ): MessageView | undefined {
    const placeholders = from.map(() => "?").join(", ");
    const changed = this.#db
      .query(
        `UPDATE message SET status = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, Date.now(), id, ...from).changes;
    return changed === 0 ? undefined : this.get(id);
  }

  /** The reply ends. Only a reply that has not ended can: the second write of a race is dropped. */
  finish(
    id: string,
    result: {
      status: "done" | "failed" | "stopped";
      text: string;
      thinking?: string | undefined;
      data?: Record<string, unknown> | undefined;
    },
  ): MessageView | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    const changed = this.#db
      .query(
        `UPDATE message SET status = ?, text = ?, thinking = ?, data = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN (${IN_FLIGHT_SQL})`,
      )
      .run(
        result.status,
        result.text,
        result.thinking ?? "",
        JSON.stringify(result.data ?? current.data),
        Date.now(),
        id,
      ).changes;
    return changed === 0 ? undefined : this.get(id);
  }

  setData(id: string, data: Record<string, unknown>): MessageView | undefined {
    const changed = this.#db
      .query(
        "UPDATE message SET data = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(data), Date.now(), id).changes;
    return changed === 0 ? undefined : this.get(id);
  }

  repliesTo(messageId: string): MessageView[] {
    return this.#db
      .query<Row, [string]>(
        "SELECT * FROM message WHERE reply_to_id = ? ORDER BY seq",
      )
      .all(messageId)
      .map(viewOf);
  }

  /** The replies that have not ended: in one conversation, or everywhere. */
  active(conversationId?: string): MessageView[] {
    const rows =
      conversationId === undefined
        ? this.#db
            .query<Row, []>(
              `SELECT * FROM message WHERE status IN (${IN_FLIGHT_SQL}) ORDER BY conversation_id, seq`,
            )
            .all()
        : this.#db
            .query<Row, [string]>(
              `SELECT * FROM message WHERE conversation_id = ? AND status IN (${IN_FLIGHT_SQL}) ORDER BY seq`,
            )
            .all(conversationId);
    return rows.map(viewOf);
  }

  /** The newest `limit` rows, oldest first, and whether older ones exist. */
  window(
    conversationId: string,
    limit: number,
  ): { messages: MessageView[]; hasMore: boolean } {
    return this.page(conversationId, undefined, limit);
  }

  /** The `limit` rows before `beforeSeq` (the newest when omitted), oldest first. */
  page(
    conversationId: string,
    beforeSeq: number | undefined,
    limit: number,
  ): { messages: MessageView[]; hasMore: boolean } {
    const rows = this.#db
      .query<Row, [string, number, number]>(
        `SELECT * FROM message WHERE conversation_id = ? AND seq < ?
          ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1);
    return {
      messages: rows.slice(0, limit).reverse().map(viewOf),
      hasMore: rows.length > limit,
    };
  }

  /** Everything past `seq`, oldest first. */
  after(conversationId: string, seq: number): MessageView[] {
    return this.#db
      .query<Row, [string, number]>(
        "SELECT * FROM message WHERE conversation_id = ? AND seq > ? ORDER BY seq",
      )
      .all(conversationId, seq)
      .map(viewOf);
  }

  /** How many agent-to-agent mentions descend from a user row. */
  countMentions(conversationId: string, rootMessageId: string): number {
    return this.#db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM message
          WHERE conversation_id = ? AND root_message_id = ? AND kind = 'mention'`,
      )
      .get(conversationId, rootMessageId)!.n;
  }

  /** What a conversation list shows about a timeline. */
  digest(
    conversationId: string,
    readSeq: number,
  ): { unread: number; preview: string; lastMessageAt: number | null } {
    const unread = this.#db
      .query<{ n: number }, [string, number]>(
        `SELECT COUNT(*) AS n FROM message
          WHERE conversation_id = ? AND seq > ? AND author = 'agent'
            AND status IN ('done', 'failed', 'stopped')`,
      )
      .get(conversationId, readSeq)!.n;
    const last = this.#db
      .query<{ created_at: number }, [string]>(
        "SELECT created_at FROM message WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(conversationId);
    const spoken = this.#db
      .query<{ text: string }, [string]>(
        `SELECT text FROM message
          WHERE conversation_id = ? AND author <> 'system' AND text <> ''
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(conversationId);
    return {
      unread,
      preview: (spoken?.text ?? "")
        .replaceAll(/\s+/g, " ")
        .trim()
        .slice(0, 140),
      lastMessageAt: last?.created_at ?? null,
    };
  }

  /** Where each agent stands in a conversation, by what it has in flight there. */
  memberStatuses(conversationId: string): Map<string, MemberStatus> {
    const statuses = new Map<string, MemberStatus>();
    for (const row of this.active(conversationId)) {
      if (row.agentId === null) continue;
      const known = statuses.get(row.agentId);
      if (known === undefined || rank(row.status) > rank(known))
        statuses.set(row.agentId, row.status as MemberStatus);
    }
    return statuses;
  }

  /** What each agent is doing anywhere: waiting on the user outranks working. */
  agentStatuses(): Map<string, "working" | "waiting_for_input"> {
    const statuses = new Map<string, "working" | "waiting_for_input">();
    for (const row of this.active()) {
      if (row.agentId === null) continue;
      if (row.status === "waiting_for_input")
        statuses.set(row.agentId, "waiting_for_input");
      else if (row.status === "working" || row.status === "stopping") {
        if (!statuses.has(row.agentId)) statuses.set(row.agentId, "working");
      }
    }
    return statuses;
  }

  /**
   * Replies a dead process left in flight end here: nothing is running them, so they can only be
   * failures, and saying so is better than a row that says `working` forever. Returns the
   * conversations that had one.
   */
  failInterrupted(text: string): string[] {
    const now = Date.now();
    const ids = new Set<string>();
    this.#db.transaction(() => {
      for (const row of this.active()) {
        this.#db
          .query(
            `UPDATE message SET status = 'failed', text = ?, data = ?, revision = revision + 1, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            text,
            JSON.stringify({ ...row.data, code: "restart" }),
            now,
            row.id,
          );
        ids.add(row.conversationId);
      }
    })();
    return [...ids];
  }
}

/** Which of two in-flight statuses a member should be shown as. */
function rank(status: string): number {
  switch (status) {
    case "waiting_for_input":
      return 4;
    case "working":
      return 3;
    case "stopping":
      return 2;
    case "queued":
      return 1;
    default:
      return 0;
  }
}
