import type {
  CaptainAssignmentStatus,
  CaptainAssignmentTargetView,
  CaptainAssignmentView,
  CaptainMemoryPauseView,
  CaptainNotificationView,
  CaptainOperationStatus,
  CaptainOperationView,
  CaptainPromptKind,
  CaptainPromptVersionView,
  CaptainSettingsView,
  CaptainSettingView,
} from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../agents/store";

const jsonObject = (raw: string | null): Record<string, unknown> => {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const JSON_NULLABLE = (raw: string | null): Record<string, unknown> | null =>
  raw === null ? null : jsonObject(raw);

interface AssignmentRow {
  id: string;
  conversation_id: string;
  message_id: string;
  root_message_id: string | null;
  captain_agent_id: string;
  round: number;
  status: CaptainAssignmentStatus;
  created_at: number;
  updated_at: number;
}

interface TargetRow {
  id: string;
  assignment_id: string;
  agent_id: string;
  reply_id: string | null;
  status: CaptainAssignmentStatus;
  task_count: number;
}

interface OperationRow {
  id: string;
  kind: string;
  actor_agent: string | null;
  requires_approval: number;
  status: CaptainOperationStatus;
  payload: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface NotificationRow {
  id: string;
  kind: string;
  body: string;
  data: string;
  read_at: number | null;
  created_at: number;
}

interface PauseRow {
  scope_type: "conversation" | "task";
  scope_id: string;
  paused: number;
  updated_by: string | null;
  updated_at: number;
}

interface PromptRow {
  id: string;
  subject_id: string;
  kind: CaptainPromptKind;
  version: number;
  content: string;
  actor_agent: string | null;
  created_at: number;
}

interface SettingRow {
  key: string;
  version: number;
  value: string | null;
  actor_agent: string | null;
  created_at: number;
}

const targetOf = (row: TargetRow): CaptainAssignmentTargetView => ({
  id: row.id,
  agentId: row.agent_id,
  replyId: row.reply_id,
  status: row.status,
  taskCount: row.task_count,
});

const assignmentOf = (
  row: AssignmentRow,
  targets: readonly TargetRow[],
): CaptainAssignmentView => ({
  id: row.id,
  conversationId: row.conversation_id,
  messageId: row.message_id,
  rootMessageId: row.root_message_id,
  captainAgentId: row.captain_agent_id,
  round: row.round,
  status: row.status,
  targets: targets.map(targetOf),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const operationOf = (row: OperationRow): CaptainOperationView => ({
  id: row.id,
  kind: row.kind,
  actorAgentId: row.actor_agent,
  requiresApproval: row.requires_approval === 1,
  status: row.status,
  payload: jsonObject(row.payload),
  result: JSON_NULLABLE(row.result),
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const notificationOf = (row: NotificationRow): CaptainNotificationView => ({
  id: row.id,
  kind: row.kind,
  body: row.body,
  data: jsonObject(row.data),
  readAt: row.read_at,
  createdAt: row.created_at,
});

const pauseOf = (row: PauseRow): CaptainMemoryPauseView => ({
  scopeType: row.scope_type,
  scopeId: row.scope_id,
  paused: row.paused === 1,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
});

const promptOf = (row: PromptRow): CaptainPromptVersionView => ({
  id: row.id,
  subjectId: row.subject_id,
  kind: row.kind,
  version: row.version,
  content: row.content,
  actorAgentId: row.actor_agent,
  createdAt: row.created_at,
});

const settingValue = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const CAPTAIN_SETTING_DEFAULTS: CaptainSettingsView = {
  supervisorEnabled: true,
  patrolMinutes: 30,
  inboxMinutes: 5,
  stuckMinutes: 30,
  retryLimit: 5,
  loopRounds: 5,
};

const CAPTAIN_SETTING_KEYS: Readonly<
  Record<keyof CaptainSettingsView, string>
> = {
  supervisorEnabled: "captain.supervisor.enabled",
  patrolMinutes: "captain.supervisor.patrolMinutes",
  inboxMinutes: "captain.supervisor.inboxMinutes",
  stuckMinutes: "captain.supervisor.stuckMinutes",
  retryLimit: "captain.supervisor.retryLimit",
  loopRounds: "captain.supervisor.loopRounds",
};

function validSetting<K extends keyof CaptainSettingsView>(
  key: K,
  value: unknown,
): value is CaptainSettingsView[K] {
  const fallback = CAPTAIN_SETTING_DEFAULTS[key];
  if (typeof fallback === "boolean") return typeof value === "boolean";
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 1440
  );
}

export class CaptainStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  captainAgent(): AgentRecord | undefined {
    const row = this.#db
      .query<
        {
          id: string;
          name: string;
          instructions: string;
          persona: string;
          runtime: string;
          model: string | null;
          thinking_level: string | null;
          bundles: string;
          machine_id: string | null;
          system_role: string | null;
          created_at: number;
          updated_at: number;
        },
        []
      >("SELECT * FROM agent WHERE system_role = 'captain'")
      .get();
    if (row === null) return undefined;
    let bundles: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.bundles);
      if (Array.isArray(parsed))
        bundles = parsed.filter(
          (item): item is string => typeof item === "string",
        );
    } catch {
      bundles = [];
    }
    return {
      id: row.id,
      name: row.name,
      instructions: row.instructions,
      persona: row.persona,
      runtime: row.runtime as AgentRecord["runtime"],
      model: row.model,
      thinkingLevel: row.thinking_level as AgentRecord["thinkingLevel"],
      bundles,
      machineId: row.machine_id,
      systemRole: "captain",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  assignment(id: string): CaptainAssignmentView | undefined {
    const row = this.#db
      .query<AssignmentRow, [string]>(
        "SELECT * FROM captain_assignment WHERE id = ?",
      )
      .get(id);
    if (row === null) return undefined;
    const targets = this.#db
      .query<TargetRow, [string]>(
        "SELECT * FROM captain_assignment_target WHERE assignment_id = ? ORDER BY rowid",
      )
      .all(id);
    return assignmentOf(row, targets);
  }

  assignments(limit = 100): CaptainAssignmentView[] {
    const rows = this.#db
      .query<AssignmentRow, [number]>(
        "SELECT * FROM captain_assignment ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit);
    return rows.map((row) => this.assignment(row.id)!);
  }

  createAssignment(input: {
    conversationId: string;
    messageId: string;
    rootMessageId: string | null;
    captainAgentId: string;
    round: number;
    targets: readonly { agentId: string; replyId: string | null }[];
  }): CaptainAssignmentView {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO captain_assignment
             (id, conversation_id, message_id, root_message_id, captain_agent_id, round, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          input.messageId,
          input.rootMessageId,
          input.captainAgentId,
          input.round,
          now,
          now,
        );
      for (const target of input.targets) {
        this.#db
          .query(
            `INSERT INTO captain_assignment_target
               (id, assignment_id, agent_id, reply_id, status, task_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'dispatched', 0, ?, ?)`,
          )
          .run(
            crypto.randomUUID(),
            id,
            target.agentId,
            target.replyId,
            now,
            now,
          );
      }
    })();
    return this.assignment(id)!;
  }

  assignmentRound(rootMessageId: string | null): number {
    if (rootMessageId === null) return 1;
    const row = this.#db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM captain_assignment WHERE root_message_id = ?",
      )
      .get(rootMessageId);
    return (row?.n ?? 0) + 1;
  }

  openAssignmentFor(
    conversationId: string,
    agentId: string,
  ):
    | {
        assignmentId: string;
        messageId: string;
        targetId: string;
      }
    | undefined {
    const row = this.#db
      .query<
        { assignment_id: string; message_id: string; target_id: string },
        [string, string]
      >(
        `SELECT a.id AS assignment_id, a.message_id, t.id AS target_id
           FROM captain_assignment_target t
           JOIN captain_assignment a ON a.id = t.assignment_id
          WHERE a.conversation_id = ? AND t.agent_id = ?
            AND t.status IN ('dispatched', 'working')
          ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
      )
      .get(conversationId, agentId);
    return row === null
      ? undefined
      : {
          assignmentId: row.assignment_id,
          messageId: row.message_id,
          targetId: row.target_id,
        };
  }

  linkTask(input: {
    taskId: string;
    assignmentId: string;
    messageId: string;
    agentId: string;
  }): void {
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db
        .query(
          `UPDATE task SET captain_assignment_id = ?, captain_message_id = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.assignmentId, input.messageId, now, input.taskId);
      this.#db
        .query(
          `UPDATE captain_assignment_target
              SET task_count = (
                    SELECT COUNT(*) FROM task
                     WHERE captain_assignment_id = ? AND created_by_agent = ?
                  ),
                  status = 'working', updated_at = ?
            WHERE assignment_id = ? AND agent_id = ?`,
        )
        .run(
          input.assignmentId,
          input.agentId,
          now,
          input.assignmentId,
          input.agentId,
        );
      this.#db
        .query(
          "UPDATE captain_assignment SET status = 'working', updated_at = ? WHERE id = ?",
        )
        .run(now, input.assignmentId);
    })();
  }

  setAssignmentTargetStatus(
    assignmentId: string,
    agentId: string,
    status: CaptainAssignmentStatus,
  ): void {
    const now = Date.now();
    this.#db
      .query(
        `UPDATE captain_assignment_target SET status = ?, updated_at = ?
          WHERE assignment_id = ? AND agent_id = ?`,
      )
      .run(status, now, assignmentId, agentId);
    this.refreshAssignment(assignmentId, now);
  }

  refreshAssignments(): void {
    this.#db
      .query(
        `UPDATE captain_assignment_target AS t
            SET task_count = (
              SELECT COUNT(*) FROM task
               WHERE captain_assignment_id = t.assignment_id
                 AND created_by_agent = t.agent_id
            ),
            status = CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM task
                 WHERE captain_assignment_id = t.assignment_id
                   AND created_by_agent = t.agent_id
              ) THEN CASE
                WHEN t.status = 'working' THEN 'cancelled'
                ELSE t.status
              END
              WHEN EXISTS (
                SELECT 1 FROM task
                 WHERE captain_assignment_id = t.assignment_id
                   AND created_by_agent = t.agent_id
                   AND status = 'blocked'
              ) THEN 'blocked'
              WHEN NOT EXISTS (
                SELECT 1 FROM task
                 WHERE captain_assignment_id = t.assignment_id
                   AND created_by_agent = t.agent_id
                   AND status NOT IN ('done', 'in_review', 'cancelled')
              ) THEN CASE
                WHEN EXISTS (
                  SELECT 1 FROM task
                   WHERE captain_assignment_id = t.assignment_id
                     AND created_by_agent = t.agent_id
                     AND status = 'cancelled'
                ) THEN 'cancelled'
                ELSE 'completed'
              END
              WHEN EXISTS (
                SELECT 1 FROM task
                 WHERE captain_assignment_id = t.assignment_id
                   AND created_by_agent = t.agent_id
              ) THEN 'working'
              ELSE t.status
            END`,
      )
      .run();
    for (const { id } of this.#db
      .query<{ id: string }, []>(
        "SELECT id FROM captain_assignment WHERE status IN ('dispatched', 'working')",
      )
      .all())
      this.refreshAssignment(id);
  }

  private refreshAssignment(id: string, now = Date.now()): void {
    const rows = this.#db
      .query<{ status: CaptainAssignmentStatus }, [string]>(
        "SELECT status FROM captain_assignment_target WHERE assignment_id = ?",
      )
      .all(id);
    if (rows.length === 0) return;
    const rank: Record<CaptainAssignmentStatus, number> = {
      dispatched: 0,
      working: 1,
      blocked: 2,
      failed: 3,
      completed: 4,
      cancelled: 5,
    };
    const allDone = rows.every(
      (row) => row.status === "completed" || row.status === "cancelled",
    );
    const status = allDone
      ? rows.every((row) => row.status === "cancelled")
        ? "cancelled"
        : "completed"
      : rows.reduce(
          (worst, row) => (rank[row.status] > rank[worst] ? row.status : worst),
          "dispatched" as CaptainAssignmentStatus,
        );
    this.#db
      .query(
        "UPDATE captain_assignment SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, now, id);
  }

  createOperation(input: {
    kind: string;
    actorAgentId?: string | null;
    requiresApproval: boolean;
    payload?: Record<string, unknown>;
    now?: number;
  }): CaptainOperationView {
    const id = crypto.randomUUID();
    const now = input.now ?? Date.now();
    this.#db
      .query(
        `INSERT INTO captain_operation
           (id, kind, actor_agent, requires_approval, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.actorAgentId ?? null,
        input.requiresApproval ? 1 : 0,
        input.requiresApproval ? "pending" : "approved",
        JSON.stringify(input.payload ?? {}),
        now,
        now,
      );
    return this.operation(id)!;
  }

  operation(id: string): CaptainOperationView | undefined {
    const row = this.#db
      .query<OperationRow, [string]>(
        "SELECT * FROM captain_operation WHERE id = ?",
      )
      .get(id);
    return row === null ? undefined : operationOf(row);
  }

  operations(limit = 100): CaptainOperationView[] {
    return this.#db
      .query<OperationRow, [number]>(
        "SELECT * FROM captain_operation ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit)
      .map(operationOf);
  }

  setOperation(
    id: string,
    status: CaptainOperationStatus,
    result?: Record<string, unknown> | null,
    error?: string | null,
  ): CaptainOperationView | undefined {
    this.#db
      .query(
        `UPDATE captain_operation
            SET status = ?, result = ?, error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        status,
        result === undefined || result === null ? null : JSON.stringify(result),
        error ?? null,
        Date.now(),
        id,
      );
    return this.operation(id);
  }

  addNotification(input: {
    kind: string;
    body: string;
    data?: Record<string, unknown>;
    now?: number;
  }): CaptainNotificationView {
    const id = crypto.randomUUID();
    const now = input.now ?? Date.now();
    this.#db
      .query(
        `INSERT INTO captain_notification
           (id, kind, body, data, read_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, input.kind, input.body, JSON.stringify(input.data ?? {}), now);
    return this.notification(id)!;
  }

  /** A notification with a stable identity, so a repeated scan does not duplicate it. */
  addNotificationOnce(input: {
    key: string;
    kind: string;
    body: string;
    data?: Record<string, unknown>;
    now?: number;
  }): CaptainNotificationView {
    const id = `captain:${input.key}`;
    const now = input.now ?? Date.now();
    this.#db
      .query(
        `INSERT INTO captain_notification
           (id, kind, body, data, read_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, input.kind, input.body, JSON.stringify(input.data ?? {}), now);
    return this.notification(id)!;
  }

  notification(id: string): CaptainNotificationView | undefined {
    const row = this.#db
      .query<NotificationRow, [string]>(
        "SELECT * FROM captain_notification WHERE id = ?",
      )
      .get(id);
    return row === null ? undefined : notificationOf(row);
  }

  notifications(limit = 100): CaptainNotificationView[] {
    return this.#db
      .query<NotificationRow, [number]>(
        "SELECT * FROM captain_notification ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit)
      .map(notificationOf);
  }

  markNotificationRead(id: string): boolean {
    return (
      this.#db
        .query(
          "UPDATE captain_notification SET read_at = COALESCE(read_at, ?) WHERE id = ?",
        )
        .run(Date.now(), id).changes > 0
    );
  }

  setMemoryPaused(input: {
    scopeType: "conversation" | "task";
    scopeId: string;
    paused: boolean;
    updatedBy?: string | null;
  }): CaptainMemoryPauseView {
    const now = Date.now();
    this.#db
      .query(
        `INSERT INTO captain_memory_pause
           (scope_type, scope_id, paused, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_type, scope_id) DO UPDATE SET
           paused = excluded.paused,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.scopeType,
        input.scopeId,
        input.paused ? 1 : 0,
        input.updatedBy ?? null,
        now,
      );
    return this.memoryPause(input.scopeType, input.scopeId)!;
  }

  memoryPause(
    scopeType: "conversation" | "task",
    scopeId: string,
  ): CaptainMemoryPauseView | undefined {
    const row = this.#db
      .query<PauseRow, [string, string]>(
        "SELECT * FROM captain_memory_pause WHERE scope_type = ? AND scope_id = ?",
      )
      .get(scopeType, scopeId);
    return row === null ? undefined : pauseOf(row);
  }

  memoryPauses(): CaptainMemoryPauseView[] {
    return this.#db
      .query<PauseRow, []>(
        "SELECT * FROM captain_memory_pause ORDER BY updated_at DESC",
      )
      .all()
      .map(pauseOf);
  }

  isMemoryPaused(scopeType: "conversation" | "task", scopeId: string): boolean {
    return this.memoryPause(scopeType, scopeId)?.paused === true;
  }

  appendPromptVersion(input: {
    subjectId: string;
    kind: CaptainPromptKind;
    content: string;
    actorAgentId?: string | null;
  }): CaptainPromptVersionView {
    const latest = this.#db
      .query<PromptRow, [string, CaptainPromptKind]>(
        `SELECT * FROM captain_prompt_version
          WHERE subject_id = ? AND kind = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(input.subjectId, input.kind);
    if (latest?.content === input.content) return promptOf(latest);
    const id = crypto.randomUUID();
    const version = (latest?.version ?? 0) + 1;
    this.#db
      .query(
        `INSERT INTO captain_prompt_version
           (id, subject_id, kind, version, content, actor_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.subjectId,
        input.kind,
        version,
        input.content,
        input.actorAgentId ?? null,
        Date.now(),
      );
    return promptOf(
      this.#db
        .query<PromptRow, [string]>(
          "SELECT * FROM captain_prompt_version WHERE id = ?",
        )
        .get(id)!,
    );
  }

  promptHistory(input: {
    subjectId?: string;
    kind?: CaptainPromptKind;
    limit?: number;
  }): CaptainPromptVersionView[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (input.subjectId !== undefined) {
      where.push("subject_id = ?");
      params.push(input.subjectId);
    }
    if (input.kind !== undefined) {
      where.push("kind = ?");
      params.push(input.kind);
    }
    params.push(Math.max(1, Math.min(input.limit ?? 100, 500)));
    return this.#db
      .query<PromptRow, (string | number)[]>(
        `SELECT * FROM captain_prompt_version
          ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params)
      .map(promptOf);
  }

  promptVersion(
    subjectId: string,
    kind: CaptainPromptKind,
    version: number,
  ): CaptainPromptVersionView | undefined {
    const row = this.#db
      .query<PromptRow, [string, CaptainPromptKind, number]>(
        `SELECT * FROM captain_prompt_version
          WHERE subject_id = ? AND kind = ? AND version = ?`,
      )
      .get(subjectId, kind, version);
    return row === null ? undefined : promptOf(row);
  }

  latestPrompt(
    subjectId: string,
    kind: CaptainPromptKind,
  ): CaptainPromptVersionView | undefined {
    const row = this.#db
      .query<PromptRow, [string, CaptainPromptKind]>(
        `SELECT * FROM captain_prompt_version
          WHERE subject_id = ? AND kind = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(subjectId, kind);
    return row === null ? undefined : promptOf(row);
  }

  settings(): CaptainSettingsView {
    const values = { ...CAPTAIN_SETTING_DEFAULTS };
    for (const key of Object.keys(
      CAPTAIN_SETTING_DEFAULTS,
    ) as (keyof CaptainSettingsView)[]) {
      const row = this.#db
        .query<{ value: string | null }, [string]>(
          "SELECT value FROM setting WHERE key = ?",
        )
        .get(CAPTAIN_SETTING_KEYS[key]);
      if (row === null) continue;
      const value = settingValue(row.value);
      if (validSetting(key, value))
        (values as Record<string, unknown>)[key] = value;
    }
    return values;
  }

  setting(key: keyof CaptainSettingsView): CaptainSettingView {
    const latest = this.#db
      .query<SettingRow, [string]>(
        `SELECT * FROM captain_setting_version WHERE key = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(CAPTAIN_SETTING_KEYS[key]);
    return {
      key,
      value: this.settings()[key],
      version: latest?.version ?? 0,
      updatedAt: latest?.created_at ?? 0,
    };
  }

  settingHistory(
    key: keyof CaptainSettingsView,
    limit = 100,
  ): CaptainSettingView[] {
    return this.#db
      .query<SettingRow, [string, number]>(
        `SELECT * FROM captain_setting_version WHERE key = ?
          ORDER BY version DESC LIMIT ?`,
      )
      .all(CAPTAIN_SETTING_KEYS[key], Math.max(1, Math.min(limit, 500)))
      .map((row) => ({
        key,
        value: settingValue(row.value),
        version: row.version,
        updatedAt: row.created_at,
      }));
  }

  setSetting<K extends keyof CaptainSettingsView>(
    key: K,
    value: unknown,
    actorAgentId?: string | null,
  ): CaptainSettingView {
    if (!Object.hasOwn(CAPTAIN_SETTING_DEFAULTS, key))
      throw new Error(`unknown captain setting: ${String(key)}`);
    if (!validSetting(key, value))
      throw new Error(`invalid value for captain setting ${key}`);
    const previous = this.#db
      .query<SettingRow, [string]>(
        `SELECT * FROM captain_setting_version WHERE key = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(CAPTAIN_SETTING_KEYS[key]);
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(CAPTAIN_SETTING_KEYS[key], JSON.stringify(value), now);
      this.#db
        .query(
          `INSERT INTO captain_setting_version
             (id, key, version, value, actor_agent, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          CAPTAIN_SETTING_KEYS[key],
          (previous?.version ?? 0) + 1,
          JSON.stringify(value),
          actorAgentId ?? null,
          now,
        );
    })();
    return this.setting(key);
  }

  retryState(taskId: string): {
    attempts: number;
    lastRunId: string | null;
    stoppedAt: number | null;
  } {
    const row = this.#db
      .query<
        {
          attempts: number;
          last_run_id: string | null;
          stopped_at: number | null;
        },
        [string]
      >("SELECT * FROM captain_retry WHERE task_id = ?")
      .get(taskId);
    return {
      attempts: row?.attempts ?? 0,
      lastRunId: row?.last_run_id ?? null,
      stoppedAt: row?.stopped_at ?? null,
    };
  }

  recordRetry(
    taskId: string,
    runId: string,
    attempts: number,
    stopped: boolean,
  ): void {
    this.#db
      .query(
        `INSERT INTO captain_retry
           (task_id, attempts, last_run_id, stopped_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           attempts = excluded.attempts,
           last_run_id = excluded.last_run_id,
           stopped_at = excluded.stopped_at,
           updated_at = excluded.updated_at`,
      )
      .run(taskId, attempts, runId, stopped ? Date.now() : null, Date.now());
  }
}
