/**
 * The conversations and who takes part in them.
 *
 * A conversation belongs to one project, and its members are agents. Each membership remembers
 * the session that holds the agent's side (made at its first wake) and how far the agent has been
 * shown the timeline. What was said lives in the timeline (`timeline.ts`).
 */
import type { Database } from "bun:sqlite";
import type { SessionSettings } from "./places";

type PendingSettings = Omit<SessionSettings, "model"> & {
  model?: string | null;
};

export interface ConversationRecord {
  id: string;
  projectId: string;
  /** What kind of conversation it is: `group`, or a kind another module registered (`policy.ts`). */
  kind: string;
  name: string;
  goal: string;
  decided: string;
  /** Who takes a user message that names nobody: a member, or null for none. */
  stewardId: string | null;
  archived: boolean;
  readSeq: number;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface ParticipantRecord {
  conversationId: string;
  agentId: string;
  sessionId: string | null;
  /** The machine the session was made on; null for one made before this was kept (the project's). */
  machineId: string | null;
  lastSeq: number;
  invitedAt: number;
}

interface ConversationRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  goal: string;
  decided: string;
  steward_id: string | null;
  archived: number;
  read_seq: number;
  last_seq: number;
  created_at: number;
  updated_at: number;
}

interface ParticipantRow {
  conversation_id: string;
  agent_id: string;
  session_id: string | null;
  machine_id: string | null;
  last_seq: number;
  invited_at: number;
}

const conversationOf = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  name: row.name,
  goal: row.goal,
  decided: row.decided,
  stewardId: row.steward_id,
  archived: row.archived === 1,
  readSeq: row.read_seq,
  lastSeq: row.last_seq,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const participantOf = (row: ParticipantRow): ParticipantRecord => ({
  conversationId: row.conversation_id,
  agentId: row.agent_id,
  sessionId: row.session_id,
  machineId: row.machine_id,
  lastSeq: row.last_seq,
  invitedAt: row.invited_at,
});

export class ConversationStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  list(): ConversationRecord[] {
    return this.#db
      .query<ConversationRow, []>(
        "SELECT * FROM conversation ORDER BY created_at, id",
      )
      .all()
      .map(conversationOf);
  }

  get(id: string): ConversationRecord | undefined {
    const row = this.#db
      .query<ConversationRow, [string]>(
        "SELECT * FROM conversation WHERE id = ?",
      )
      .get(id);
    return row === null ? undefined : conversationOf(row);
  }

  ofProject(projectId: string): ConversationRecord[] {
    return this.#db
      .query<ConversationRow, [string]>(
        "SELECT * FROM conversation WHERE project_id = ? ORDER BY created_at, id",
      )
      .all(projectId)
      .map(conversationOf);
  }

  /** The conversations of a kind, oldest first. */
  ofKind(kind: string): ConversationRecord[] {
    return this.#db
      .query<ConversationRow, [string]>(
        "SELECT * FROM conversation WHERE kind = ? ORDER BY created_at, id",
      )
      .all(kind)
      .map(conversationOf);
  }

  /** Make a conversation with its first members, in one write. */
  create(input: {
    projectId: string;
    kind: string;
    name: string;
    agentIds: readonly string[];
    /** One of `agentIds`, or none. */
    stewardId?: string | null | undefined;
  }): ConversationRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO conversation (id, project_id, kind, name, steward_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.kind,
          input.name,
          input.stewardId ?? null,
          now,
          now,
        );
      for (const agentId of input.agentIds) this.addParticipant(id, agentId);
    })();
    return this.get(id)!;
  }

  update(
    id: string,
    patch: {
      name?: string | undefined;
      goal?: string | undefined;
      decided?: string | undefined;
      archived?: boolean | undefined;
    },
  ): ConversationRecord | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    this.#db
      .query(
        `UPDATE conversation SET name = ?, goal = ?, decided = ?, archived = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.goal ?? current.goal,
        patch.decided ?? current.decided,
        (patch.archived ?? current.archived) ? 1 : 0,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  setSteward(
    id: string,
    agentId: string | null,
  ): ConversationRecord | undefined {
    const changed = this.#db
      .query(
        "UPDATE conversation SET steward_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(agentId, Date.now(), id).changes;
    return changed === 0 ? undefined : this.get(id);
  }

  /**
   * Move the user's read mark forward to `seq`: never back (reopening an old conversation does
   * not make it unread) and never past the newest row (a client that guesses far ahead does not
   * make rows that do not exist yet read).
   */
  markRead(id: string, seq: number): ConversationRecord | undefined {
    const changed = this.#db
      .query(
        "UPDATE conversation SET read_seq = MAX(read_seq, MIN(?, last_seq)) WHERE id = ?",
      )
      .run(seq, id).changes;
    return changed === 0 ? undefined : this.get(id);
  }

  participants(conversationId: string): ParticipantRecord[] {
    return this.#db
      .query<ParticipantRow, [string]>(
        // Insertion order, not invitation time: two invitations in one millisecond share a
        // timestamp, and a list that reorders itself is a list nobody can test.
        "SELECT * FROM participant WHERE conversation_id = ? ORDER BY rowid",
      )
      .all(conversationId)
      .map(participantOf);
  }

  participant(
    conversationId: string,
    agentId: string,
  ): ParticipantRecord | undefined {
    const row = this.#db
      .query<ParticipantRow, [string, string]>(
        "SELECT * FROM participant WHERE conversation_id = ? AND agent_id = ?",
      )
      .get(conversationId, agentId);
    return row === null ? undefined : participantOf(row);
  }

  /** Add a member; false when it already was one. */
  addParticipant(conversationId: string, agentId: string): boolean {
    return (
      this.#db
        .query(
          `INSERT OR IGNORE INTO participant (conversation_id, agent_id, last_seq, invited_at)
           VALUES (?, ?, 0, ?)`,
        )
        .run(conversationId, agentId, Date.now()).changes > 0
    );
  }

  /** Add several members at once, all or none; how many were new. */
  addParticipants(conversationId: string, agentIds: readonly string[]): number {
    let added = 0;
    this.#db.transaction(() => {
      for (const agentId of agentIds)
        if (this.addParticipant(conversationId, agentId)) added += 1;
    })();
    return added;
  }

  /** Take a member out. A steward that leaves stops being one: the conversation then has none. */
  removeParticipant(conversationId: string, agentId: string): boolean {
    return this.#db.transaction(() => {
      const removed =
        this.#db
          .query(
            "DELETE FROM participant WHERE conversation_id = ? AND agent_id = ?",
          )
          .run(conversationId, agentId).changes > 0;
      if (removed)
        this.#db
          .query(
            "UPDATE conversation SET steward_id = NULL, updated_at = ? WHERE id = ? AND steward_id = ?",
          )
          .run(Date.now(), conversationId, agentId);
      return removed;
    })();
  }

  /** The participant's session, and the machine it was made on. */
  setSession(
    conversationId: string,
    agentId: string,
    sessionId: string,
    machineId: string,
  ): void {
    this.#db
      .query(
        "UPDATE participant SET session_id = ?, machine_id = ? WHERE conversation_id = ? AND agent_id = ?",
      )
      .run(sessionId, machineId, conversationId, agentId);
  }

  /**
   * The conversation and agent a session is the side of, and the machine it runs on: the one it was
   * made on, which for a session from before that was kept is the machine of the conversation's
   * project. A session no participant names is not here.
   */
  ofSession(
    sessionId: string,
  ):
    | { conversationId: string; agentId: string; machineId: string }
    | undefined {
    const row = this.#db
      .query<
        { conversation_id: string; agent_id: string; machine_id: string },
        [string]
      >(
        `SELECT p.conversation_id, p.agent_id, COALESCE(p.machine_id, pr.machine_id) AS machine_id
         FROM participant p
         JOIN conversation c ON c.id = p.conversation_id
         JOIN project pr ON pr.id = c.project_id
         WHERE p.session_id = ?`,
      )
      .get(sessionId);
    return row === null
      ? undefined
      : {
          conversationId: row.conversation_id,
          agentId: row.agent_id,
          machineId: row.machine_id,
        };
  }

  /** The sessions an agent has, one for each conversation it was woken in. */
  sessionsOfAgent(agentId: string): string[] {
    return this.#db
      .query<{ session_id: string }, [string]>(
        "SELECT session_id FROM participant WHERE agent_id = ? AND session_id IS NOT NULL",
      )
      .all(agentId)
      .map((row) => row.session_id);
  }

  /** Stack edits to different settings while a session is busy or its machine is away. */
  queueSessionSettings(
    agentId: string,
    settings: PendingSettings | null,
  ): void {
    if (settings === null) {
      this.#db
        .query(
          "UPDATE participant SET pending_settings = NULL WHERE agent_id = ?",
        )
        .run(agentId);
      return;
    }
    const rows = this.#db
      .query<
        { conversation_id: string; pending_settings: string | null },
        [string]
      >(
        "SELECT conversation_id, pending_settings FROM participant WHERE agent_id = ?",
      )
      .all(agentId);
    const update = this.#db.query(
      "UPDATE participant SET pending_settings = ? WHERE conversation_id = ? AND agent_id = ?",
    );
    for (const row of rows) {
      const pending = JSON.parse(
        row.pending_settings ?? "{}",
      ) as PendingSettings;
      update.run(
        JSON.stringify({ ...pending, ...settings }),
        row.conversation_id,
        agentId,
      );
    }
  }

  pendingSessionSettings(
    sessionId: string,
  ): { saved: string; settings: PendingSettings } | undefined {
    const saved = this.#db
      .query<{ pending_settings: string | null }, [string]>(
        "SELECT pending_settings FROM participant WHERE session_id = ?",
      )
      .get(sessionId)?.pending_settings;
    if (saved === null || saved === undefined) return undefined;
    return { saved, settings: JSON.parse(saved) as PendingSettings };
  }

  /** Clear only the settings that were tried. A newer edit may have arrived during the call. */
  finishSessionSettings(
    sessionId: string,
    saved: string,
    remaining: PendingSettings,
  ): void {
    this.#db
      .query(
        "UPDATE participant SET pending_settings = ? WHERE session_id = ? AND pending_settings = ?",
      )
      .run(
        Object.keys(remaining).length === 0 ? null : JSON.stringify(remaining),
        sessionId,
        saved,
      );
  }

  /** The sessions that run on a machine, by the participants that hold them. */
  sessionsOn(machineId: string): string[] {
    return this.#db
      .query<{ session_id: string }, [string]>(
        `SELECT p.session_id
         FROM participant p
         JOIN conversation c ON c.id = p.conversation_id
         JOIN project pr ON pr.id = c.project_id
         WHERE COALESCE(p.machine_id, pr.machine_id) = ? AND p.session_id IS NOT NULL`,
      )
      .all(machineId)
      .map((row) => row.session_id);
  }

  /**
   * Forget every member's session in the conversation, so the next wake of each makes a new one
   * with an empty context. The old sessions' journals stay. Returns the session ids let go.
   */
  clearSessions(conversationId: string): string[] {
    return this.#db.transaction(() => {
      const ids = this.#db
        .query<{ session_id: string }, [string]>(
          "SELECT session_id FROM participant WHERE conversation_id = ? AND session_id IS NOT NULL",
        )
        .all(conversationId)
        .map((row) => row.session_id);
      this.#db
        .query(
          "UPDATE participant SET session_id = NULL, pending_settings = NULL WHERE conversation_id = ?",
        )
        .run(conversationId);
      return ids;
    })();
  }

  /** The member has been shown the timeline up to `seq`. Only ever forward. */
  setSeen(conversationId: string, agentId: string, seq: number): void {
    this.#db
      .query(
        "UPDATE participant SET last_seq = MAX(last_seq, ?) WHERE conversation_id = ? AND agent_id = ?",
      )
      .run(seq, conversationId, agentId);
  }
}
