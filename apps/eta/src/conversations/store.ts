import type { ConversationKind } from "@eta/client-contracts";
/**
 * The conversations and who takes part in them.
 *
 * A conversation belongs to one project, and its members are agents. Each membership remembers
 * the session that holds the agent's side (made at its first wake) and how far the agent has been
 * shown the timeline. What was said lives in the timeline (`timeline.ts`).
 */
import type { Database } from "bun:sqlite";

export interface ConversationRecord {
  id: string;
  projectId: string;
  kind: ConversationKind;
  name: string;
  goal: string;
  decided: string;
  /** The conversation's own steward; null follows the project's. */
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
  last_seq: number;
  invited_at: number;
}

const conversationOf = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind as ConversationKind,
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

  /** The private chat with an agent in a project, if it has one. */
  directOf(projectId: string, agentId: string): ConversationRecord | undefined {
    const row = this.#db
      .query<ConversationRow, [string, string]>(
        `SELECT c.* FROM conversation c
           JOIN participant p ON p.conversation_id = c.id
          WHERE c.kind = 'direct' AND c.project_id = ? AND p.agent_id = ?
          ORDER BY c.created_at LIMIT 1`,
      )
      .get(projectId, agentId);
    return row === null ? undefined : conversationOf(row);
  }

  /** Make a conversation with its first members, in one write. */
  create(input: {
    projectId: string;
    kind: ConversationKind;
    name: string;
    agentIds: readonly string[];
  }): ConversationRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO conversation (id, project_id, kind, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.projectId, input.kind, input.name, now, now);
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

  /** Private chats the agent is in, put away. Returns the ones that moved. */
  archiveDirectOf(agentId: string): string[] {
    const ids = this.#db
      .query<{ id: string }, [string]>(
        `SELECT c.id FROM conversation c
           JOIN participant p ON p.conversation_id = c.id
          WHERE c.kind = 'direct' AND c.archived = 0 AND p.agent_id = ?`,
      )
      .all(agentId)
      .map((row) => row.id);
    for (const id of ids) this.update(id, { archived: true });
    return ids;
  }

  /** Rename the private chats in a project, which carry their agent's name. */
  renameDirect(projectId: string, name: string): void {
    this.#db
      .query(
        "UPDATE conversation SET name = ?, updated_at = ? WHERE project_id = ? AND kind = 'direct'",
      )
      .run(name, Date.now(), projectId);
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

  removeParticipant(conversationId: string, agentId: string): boolean {
    return (
      this.#db
        .query(
          "DELETE FROM participant WHERE conversation_id = ? AND agent_id = ?",
        )
        .run(conversationId, agentId).changes > 0
    );
  }

  setSession(conversationId: string, agentId: string, sessionId: string): void {
    this.#db
      .query(
        "UPDATE participant SET session_id = ? WHERE conversation_id = ? AND agent_id = ?",
      )
      .run(sessionId, conversationId, agentId);
  }

  /**
   * The conversation and agent a session is the side of, and the machine it runs on (the machine
   * of the conversation's project). A session no participant names is not here.
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
        `SELECT p.conversation_id, p.agent_id, pr.machine_id
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

  /** The sessions that run on a machine, by the participants that hold them. */
  sessionsOn(machineId: string): string[] {
    return this.#db
      .query<{ session_id: string }, [string]>(
        `SELECT p.session_id
         FROM participant p
         JOIN conversation c ON c.id = p.conversation_id
         JOIN project pr ON pr.id = c.project_id
         WHERE pr.machine_id = ? AND p.session_id IS NOT NULL`,
      )
      .all(machineId)
      .map((row) => row.session_id);
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
