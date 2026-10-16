/**
 * Groups: who is in them, what was said, and which message wakes whom (REFACTOR.md §9, P2.1).
 *
 * The routing rule, in one paragraph. A message names the agents it wakes; an agent that is not
 * named is still a reader — the message is context for it, not work, and nothing is queued for it.
 * A group with a single participant wakes that one without being named (a private chat is the
 * same shape). And when an *agent* names another agent, that costs one of five wakes under the
 * user message the branch descends from: agents may hand work to each other, but a group cannot
 * wake itself forever. The fifth such message still lands, and a reminder goes with it.
 *
 * What a wake *is*: a row. This module decides and records; turning a row into a run is P2.2's
 * (the session that belongs to that agent in that group), and showing the result is P2.3's.
 */
import type { Database } from "bun:sqlite";

/** How many agent-to-agent wakes one user message may start, across every branch. */
export const WAKE_BUDGET = 5;

export interface GroupRecord {
  id: string;
  name: string;
  goal: string;
  decided: string;
  private: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantRecord {
  groupId: string;
  agentId: string;
  /** Where this agent's conversation in this group lives; P2.2 fills it. */
  sessionId?: string | undefined;
  /** How far this agent has been shown. */
  lastSeq: number;
  invitedAt: string;
}

export interface GroupWithParticipants {
  group: GroupRecord;
  participants: ParticipantRecord[];
}

export interface MessageRecord {
  id: string;
  groupId: string;
  seq: number;
  kind: string;
  authorKind: "user" | "agent" | "system";
  authorAgentId?: string | undefined;
  text: string;
  /** `working` while an agent is answering, `done` once it is written, `failed` when it could not. */
  status: "working" | "done" | "failed";
  /** Grows when the same message changes, so a client can tell "newer" from "a second one". */
  revision: number;
  /** The agents this message wakes. */
  mentions: string[];
  rootMessageId?: string | undefined;
  createdAt: string;
}

export interface WakeRecord {
  groupId: string;
  agentId: string;
  messageId: string;
  seq: number;
  state: "queued" | "taken" | "cancelled";
}

export interface PostedMessage {
  message: MessageRecord;
  /** The agents this message woke, in the order they were named. */
  woke: string[];
  /** True when the five-wake budget was already spent: the message is context, not work. */
  capped: boolean;
  /** The reminder written alongside the fifth wake, when this message was that one. */
  reminder?: MessageRecord | undefined;
}

export interface CreateGroupInput {
  name: string;
  goal?: string | undefined;
  agentIds?: readonly string[] | undefined;
  private?: boolean | undefined;
}

export interface PostMessageInput {
  text: string;
  agentId?: string | undefined;
  mentions?: readonly string[] | undefined;
  /** The user message this branch descends from; required for an agent's message. */
  rootMessageId?: string | undefined;
}

interface GroupRow {
  id: string;
  name: string;
  goal: string;
  decided: string;
  private: number;
  created_at: string;
  updated_at: string;
}

interface ParticipantRow {
  group_id: string;
  agent_id: string;
  session_id: string | null;
  last_seq: number;
  invited_at: string;
}
interface MessageRow {
  id: string;
  group_id: string;
  seq: number;
  kind: string;
  author_kind: string;
  author_agent_id: string | null;
  text: string;
  status: string;
  revision: number;
  mentions: string;
  root_message_id: string | null;
  created_at: string;
}

const groupOf = (row: GroupRow): GroupRecord => ({
  id: row.id,
  name: row.name,
  goal: row.goal,
  decided: row.decided,
  private: row.private === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const participantOf = (row: ParticipantRow): ParticipantRecord => ({
  groupId: row.group_id,
  agentId: row.agent_id,
  ...(row.session_id === null ? {} : { sessionId: row.session_id }),
  lastSeq: row.last_seq,
  invitedAt: row.invited_at,
});

/** A column that holds JSON can hold anything; a bad one degrades to "nobody". */
function mentionsOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

const messageOf = (row: MessageRow): MessageRecord => ({
  id: row.id,
  groupId: row.group_id,
  seq: row.seq,
  kind: row.kind,
  authorKind:
    row.author_kind === "agent"
      ? "agent"
      : row.author_kind === "system"
        ? "system"
        : "user",
  ...(row.author_agent_id === null
    ? {}
    : { authorAgentId: row.author_agent_id }),
  text: row.text,
  status:
    row.status === "working"
      ? "working"
      : row.status === "failed"
        ? "failed"
        : "done",
  revision: row.revision,
  mentions: mentionsOf(row.mentions),
  ...(row.root_message_id === null
    ? {}
    : { rootMessageId: row.root_message_id }),
  createdAt: row.created_at,
});

export class GroupStore {
  readonly #handle: Database;

  constructor(handle: Database) {
    this.#handle = handle;
  }

  create(input: CreateGroupInput): GroupWithParticipants {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.#handle.transaction(() => {
      this.#handle
        .query(
          `INSERT INTO chat_group (id, name, goal, decided, private, created_at, updated_at)
					 VALUES (?, ?, ?, '', ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.goal ?? "",
          input.private === true ? 1 : 0,
          now,
          now,
        );
      for (const agentId of input.agentIds ?? []) {
        this.#handle
          .query(
            `INSERT OR IGNORE INTO group_participant (group_id, agent_id, session_id, last_seq, invited_at)
						 VALUES (?, ?, NULL, 0, ?)`,
          )
          .run(id, agentId, now);
      }
    })();
    const created = this.get(id);
    if (created === undefined)
      throw new Error(`group ${id} vanished right after it was created`);
    return created;
  }

  /**
   * The private group an agent gets for itself. Idempotent: an agent has one, and asking twice
   * is how the code says "make sure it exists" rather than "make another".
   */
  ensurePrivateGroup(agentId: string, name: string): GroupWithParticipants {
    const existing = this.#handle
      .query(
        `SELECT g.* FROM chat_group g
				   JOIN group_participant p ON p.group_id = g.id
				  WHERE g.private = 1 AND p.agent_id = ?`,
      )
      .get(agentId) as GroupRow | null;
    if (existing !== null) {
      const found = this.get(existing.id);
      if (found !== undefined) return found;
    }
    return this.create({ name, agentIds: [agentId], private: true });
  }

  /** Forget an agent's private group — what deleting the agent means for it. */
  removePrivateGroupsOf(agentId: string): number {
    const result = this.#handle
      .query(
        `DELETE FROM chat_group WHERE private = 1 AND id IN
				   (SELECT group_id FROM group_participant WHERE agent_id = ?)`,
      )
      .run(agentId);
    return result.changes;
  }

  list(): GroupWithParticipants[] {
    const rows = this.#handle
      .query("SELECT * FROM chat_group ORDER BY private, created_at")
      .all() as GroupRow[];
    return rows.map((row) => ({
      group: groupOf(row),
      participants: this.participantsOf(row.id),
    }));
  }

  get(id: string): GroupWithParticipants | undefined {
    const row = this.#handle
      .query("SELECT * FROM chat_group WHERE id = ?")
      .get(id) as GroupRow | null;
    return row === null
      ? undefined
      : { group: groupOf(row), participants: this.participantsOf(id) };
  }

  participantsOf(groupId: string): ParticipantRecord[] {
    // Ordered by insertion, not by `invited_at`: two invitations in the same millisecond
    // share a timestamp, and a list that reorders itself is a list nobody can test.
    const rows = this.#handle
      .query(
        "SELECT * FROM group_participant WHERE group_id = ? ORDER BY rowid",
      )
      .all(groupId) as ParticipantRow[];
    return rows.map(participantOf);
  }

  update(
    id: string,
    patch: { name?: string; goal?: string; decided?: string },
  ): GroupWithParticipants | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    this.#handle
      .query(
        "UPDATE chat_group SET name = ?, goal = ?, decided = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.name ?? current.group.name,
        patch.goal ?? current.group.goal,
        patch.decided ?? current.group.decided,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  /** Invite an agent. A private group is not a group you add people to. */
  addParticipant(
    id: string,
    agentId: string,
  ): "ok" | "no-group" | "no-agent" | "private" | "member" {
    const group = this.get(id);
    if (group === undefined) return "no-group";
    if (group.group.private) return "private";
    if (this.#agentExists(agentId) === false) return "no-agent";
    if (
      group.participants.some((participant) => participant.agentId === agentId)
    )
      return "member";
    this.#handle
      .query(
        `INSERT INTO group_participant (group_id, agent_id, session_id, last_seq, invited_at)
				 VALUES (?, ?, NULL, 0, ?)`,
      )
      .run(id, agentId, new Date().toISOString());
    return "ok";
  }

  removeParticipant(
    id: string,
    agentId: string,
  ): "ok" | "no-group" | "private" | "absent" {
    const group = this.get(id);
    if (group === undefined) return "no-group";
    if (group.group.private) return "private";
    const result = this.#handle
      .query(
        "DELETE FROM group_participant WHERE group_id = ? AND agent_id = ?",
      )
      .run(id, agentId);
    return result.changes > 0 ? "ok" : "absent";
  }

  /** Point an agent's participation at the session that holds its side of the conversation (P2.2). */
  setSession(id: string, agentId: string, sessionId: string): boolean {
    const result = this.#handle
      .query(
        "UPDATE group_participant SET session_id = ? WHERE group_id = ? AND agent_id = ?",
      )
      .run(sessionId, id, agentId);
    return result.changes > 0;
  }

  /** A message from the user: with no mentions it wakes nobody, and that is the rule, not a bug. */
  postUserMessage(
    id: string,
    input: { text: string; mentions?: readonly string[] },
  ): PostedMessage | undefined {
    return this.#post(id, {
      text: input.text,
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
    });
  }

  /**
   * A message from an agent. When it names another agent it is a `mention` message, and those
   * are what the five-wake budget counts under `rootMessageId`.
   */
  postAgentMessage(
    id: string,
    input: PostMessageInput & { agentId: string },
  ): PostedMessage | undefined {
    return this.#post(id, input);
  }

  messages(groupId: string, sinceSeq = 0): MessageRecord[] {
    const rows = this.#handle
      .query(
        "SELECT * FROM group_message WHERE group_id = ? AND seq > ? ORDER BY seq",
      )
      .all(groupId, sinceSeq) as MessageRow[];
    return rows.map(messageOf);
  }

  /**
   * A reply that has started: the row exists while the run is in flight, so a reader sees where
   * the answer will be. The place in the timeline is fixed now, which is why the row is written
   * at the start and updated at the end rather than inserted once.
   */
  startReply(
    groupId: string,
    agentId: string,
    replyToMessageId: string,
  ): MessageRecord {
    const parent = this.messages(groupId).find(
      (message) => message.id === replyToMessageId,
    );
    const seq = this.#nextSeq(groupId);
    const id = crypto.randomUUID();
    this.#handle
      .query(
        `INSERT INTO group_message
           (id, group_id, seq, kind, author_kind, author_agent_id, text, status, revision, mentions, root_message_id, created_at)
         VALUES (?, ?, ?, 'assistant', 'agent', ?, '', 'working', 1, '[]', ?, ?)`,
      )
      .run(
        id,
        groupId,
        seq,
        agentId,
        parent?.rootMessageId ?? parent?.id ?? null,
        new Date().toISOString(),
      );
    const created = this.messages(groupId, seq - 1)[0];
    if (created === undefined)
      throw new Error(`reply ${id} vanished right after it was started`);
    return created;
  }

  /** The reply is written: text in, status set, revision up. The seq does not move. */
  finishReply(
    messageId: string,
    input: { text: string; status: "done" | "failed" },
  ): MessageRecord | undefined {
    const result = this.#handle
      .query(
        "UPDATE group_message SET text = ?, status = ?, revision = revision + 1 WHERE id = ?",
      )
      .run(input.text, input.status, messageId);
    if (result.changes === 0) return undefined;
    const row = this.#handle
      .query("SELECT * FROM group_message WHERE id = ?")
      .get(messageId) as MessageRow | null;
    return row === null ? undefined : messageOf(row);
  }

  /** What a sidebar needs: the group, and the seq a client resumes its timeline from. */
  summary(id: string): (GroupRecord & { seq: number }) | undefined {
    const group = this.get(id);
    if (group === undefined) return undefined;
    const row = this.#handle
      .query(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM group_message WHERE group_id = ?",
      )
      .get(id) as { seq: number };
    return { ...group.group, seq: row.seq };
  }

  /** Mark a wake's state. Taking one is a write before the run, never after (P2.2). */
  markWake(
    groupId: string,
    agentId: string,
    messageId: string,
    state: WakeRecord["state"],
  ): void {
    this.#handle
      .query(
        "UPDATE group_wake SET state = ? WHERE group_id = ? AND agent_id = ? AND message_id = ?",
      )
      .run(state, groupId, agentId, messageId);
  }

  /** What is waiting for an agent (P2.2 takes these). */
  wakes(groupId: string, agentId?: string): WakeRecord[] {
    const rows = (
      agentId === undefined
        ? this.#handle
            .query("SELECT * FROM group_wake WHERE group_id = ? ORDER BY seq")
            .all(groupId)
        : this.#handle
            .query(
              "SELECT * FROM group_wake WHERE group_id = ? AND agent_id = ? ORDER BY seq",
            )
            .all(groupId, agentId)
    ) as {
      group_id: string;
      agent_id: string;
      message_id: string;
      seq: number;
      state: string;
    }[];
    return rows.map((row) => ({
      groupId: row.group_id,
      agentId: row.agent_id,
      messageId: row.message_id,
      seq: row.seq,
      state:
        row.state === "taken"
          ? "taken"
          : row.state === "cancelled"
            ? "cancelled"
            : "queued",
    }));
  }

  #agentExists(agentId: string): boolean {
    return (
      this.#handle
        .query("SELECT 1 AS one FROM agents WHERE id = ?")
        .get(agentId) !== null
    );
  }

  #post(id: string, input: PostMessageInput): PostedMessage | undefined {
    const group = this.get(id);
    if (group === undefined) return undefined;

    const members = group.participants.map(
      (participant) => participant.agentId,
    );
    const named = (input.mentions ?? []).filter((agentId) =>
      members.includes(agentId),
    );
    // A group of one wakes its member without being asked — that is what a private chat is —
    // but only when the *user* is speaking: an agent's own reply must never wake its author, and
    // an agent that names nobody wakes nobody.
    const defaultTargets =
      input.agentId === undefined && members.length === 1 ? [...members] : [];
    const targets = named.length > 0 ? named : defaultTargets;
    const authoredByAgent = input.agentId !== undefined;

    const now = new Date().toISOString();
    const messageId = crypto.randomUUID();
    let message: MessageRecord | undefined;
    let reminder: MessageRecord | undefined;
    let woke: string[] = [];
    let capped = false;

    this.#handle.transaction(() => {
      const seq = this.#nextSeq(id);
      const root =
        input.rootMessageId ?? (authoredByAgent ? undefined : messageId);
      const kind = authoredByAgent
        ? targets.length > 0
          ? "mention"
          : "assistant"
        : "user";
      this.#handle
        .query(
          `INSERT INTO group_message
					   (id, group_id, seq, kind, author_kind, author_agent_id, text, mentions, root_message_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          id,
          seq,
          kind,
          authoredByAgent ? "agent" : "user",
          input.agentId ?? null,
          input.text,
          JSON.stringify(targets),
          root ?? null,
          now,
        );

      // The budget applies to what agents do to each other, and only then.
      const budgetSpent =
        authoredByAgent && targets.length > 0 && root !== undefined
          ? this.#countMentions(id, root)
          : 0;
      if (budgetSpent > WAKE_BUDGET) {
        capped = true;
      } else {
        woke = [...targets];
        for (const agentId of woke) {
          this.#handle
            .query(
              `INSERT OR IGNORE INTO group_wake (group_id, agent_id, message_id, seq, state, created_at)
							 VALUES (?, ?, ?, ?, 'queued', ?)`,
            )
            .run(id, agentId, messageId, seq, now);
        }
        if (authoredByAgent && budgetSpent === WAKE_BUDGET) {
          reminder = this.#writeSystem(
            id,
            `This group has used its ${WAKE_BUDGET} wake-ups under this message; later mentions stay context until someone replies.`,
            now,
          );
        }
      }

      message = this.messages(id, seq - 1)[0];
      void message;
    })();

    if (message === undefined) return undefined;
    return {
      message,
      woke,
      capped,
      ...(reminder === undefined ? {} : { reminder }),
    };
  }

  #writeSystem(groupId: string, text: string, now: string): MessageRecord {
    const id = crypto.randomUUID();
    const seq = this.#nextSeq(groupId);
    this.#handle
      .query(
        `INSERT INTO group_message
				   (id, group_id, seq, kind, author_kind, author_agent_id, text, mentions, root_message_id, created_at)
				 VALUES (?, ?, ?, 'system', 'system', NULL, ?, '[]', NULL, ?)`,
      )
      .run(id, groupId, seq, text, now);
    return this.messages(groupId, seq - 1)[0]!;
  }

  #nextSeq(groupId: string): number {
    const row = this.#handle
      .query(
        "SELECT COALESCE(MAX(seq), 0) AS last FROM group_message WHERE group_id = ?",
      )
      .get(groupId) as { last: number };
    return row.last + 1;
  }

  #countMentions(groupId: string, rootMessageId: string): number {
    const row = this.#handle
      .query(
        "SELECT COUNT(*) AS n FROM group_message WHERE group_id = ? AND root_message_id = ? AND kind = 'mention'",
      )
      .get(groupId, rootMessageId) as { n: number };
    return row.n;
  }
}
