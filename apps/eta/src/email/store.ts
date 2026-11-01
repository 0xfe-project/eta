import type {
  EmailAccountInput,
  EmailAccountStatus,
  EmailAccountView,
  EmailAssignmentView,
  EmailMessageDirection,
  EmailMessageStatus,
  EmailMessageView,
  EmailProposalKind,
  EmailProposalStatus,
  EmailProposalView,
  EmailThreadStatus,
  EmailThreadView,
} from "@eta/client-contracts";
import type { Database } from "bun:sqlite";

interface AccountRow {
  id: string;
  name: string;
  address: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  inbox_folder: string;
  junk_folder: string | null;
  poll_interval_seconds: number;
  username: string;
  status: EmailAccountStatus;
  last_error: string | null;
  last_checked_at: number | null;
  last_poll_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ThreadRow {
  id: string;
  account_id: string;
  peer: string;
  subject: string;
  status: EmailThreadStatus;
  unread: number;
  root_message_id: string | null;
  latest_message_id: string | null;
  last_message_at: number;
  created_at: number;
  updated_at: number;
  message_count: number;
  incoming_count: number;
  outgoing_count: number;
  last_message: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  account_id: string;
  direction: EmailMessageDirection;
  status: EmailMessageStatus;
  remote_key: string | null;
  folder: string | null;
  from_address: string;
  to_address: string;
  subject: string;
  text_body: string;
  html_body: string;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references_json: string;
  eta_json: string | null;
  error: string | null;
  created_at: number;
}

interface AssignmentRow {
  id: string;
  thread_id: string;
  session_id: string;
  agent_id: string;
  project_id: string;
  created_at: number;
}

interface ProposalRow {
  id: string;
  session_id: string;
  agent_id: string;
  account_id: string;
  thread_id: string | null;
  reply_to_message_id: string | null;
  kind: EmailProposalKind;
  status: EmailProposalStatus;
  from_address: string;
  to_address: string;
  cc_address: string;
  bcc_address: string;
  subject: string;
  markdown: string;
  context_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const json = <T>(value: string | null, fallback: T): T => {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const accountOf = (row: AccountRow): EmailAccountView => ({
  id: row.id,
  name: row.name,
  address: row.address,
  username: row.username,
  smtpHost: row.smtp_host,
  smtpPort: row.smtp_port,
  smtpSecure: row.smtp_secure === 1,
  imapHost: row.imap_host,
  imapPort: row.imap_port,
  imapSecure: row.imap_secure === 1,
  inboxFolder: row.inbox_folder,
  junkFolder: row.junk_folder,
  pollIntervalSeconds: row.poll_interval_seconds,
  status: row.status,
  lastError: row.last_error,
  lastCheckedAt: row.last_checked_at,
  lastPollAt: row.last_poll_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const threadOf = (row: ThreadRow): EmailThreadView => ({
  id: row.id,
  accountId: row.account_id,
  peer: row.peer,
  subject: row.subject,
  status: row.status,
  unread: row.unread === 1,
  messageCount: row.message_count,
  incomingCount: row.incoming_count,
  outgoingCount: row.outgoing_count,
  lastMessageAt: row.last_message_at,
  lastMessage: row.last_message ?? "",
  rootMessageId: row.root_message_id,
  latestMessageId: row.latest_message_id,
});

const messageOf = (row: MessageRow): EmailMessageView => ({
  id: row.id,
  threadId: row.thread_id,
  accountId: row.account_id,
  direction: row.direction,
  status: row.status,
  folder: row.folder,
  from: row.from_address,
  to: row.to_address,
  subject: row.subject,
  text: row.text_body,
  html: row.html_body,
  rfcMessageId: row.rfc_message_id,
  inReplyTo: row.in_reply_to,
  references: json(row.references_json, []),
  meta: json(row.eta_json, null),
  error: row.error,
  createdAt: row.created_at,
});

const assignmentOf = (row: AssignmentRow): EmailAssignmentView => ({
  id: row.id,
  threadId: row.thread_id,
  sessionId: row.session_id,
  agentId: row.agent_id,
  projectId: row.project_id,
  createdAt: row.created_at,
});

const proposalOf = (row: ProposalRow): EmailProposalView => ({
  id: row.id,
  threadId: row.thread_id,
  replyToMessageId: row.reply_to_message_id,
  sessionId: row.session_id,
  agentId: row.agent_id,
  accountId: row.account_id,
  kind: row.kind,
  status: row.status,
  from: row.from_address,
  to: row.to_address,
  cc: row.cc_address,
  bcc: row.bcc_address,
  subject: row.subject,
  markdown: row.markdown,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const THREAD_SELECT = `
  SELECT t.*,
         (SELECT COUNT(*) FROM email_message m WHERE m.thread_id = t.id) AS message_count,
         (SELECT COUNT(*) FROM email_message m
           WHERE m.thread_id = t.id AND m.direction = 'incoming') AS incoming_count,
         (SELECT COUNT(*) FROM email_message m
           WHERE m.thread_id = t.id AND m.direction = 'outgoing') AS outgoing_count,
         (SELECT m.text_body FROM email_message m WHERE m.thread_id = t.id
           ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message
    FROM email_thread t`;

export interface IncomingEmailInput {
  accountId: string;
  remoteKey: string;
  folder: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  eta: unknown;
}

export interface OutgoingEmailInput {
  accountId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  eta: unknown;
  status: EmailMessageStatus;
  error?: string | null;
}

export class EmailStore {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  accounts(): EmailAccountView[] {
    return this.db
      .query<AccountRow, []>(
        "SELECT * FROM email_account ORDER BY created_at, id",
      )
      .all()
      .map(accountOf);
  }

  account(id: string): EmailAccountView | undefined {
    const row = this.db
      .query<AccountRow, [string]>("SELECT * FROM email_account WHERE id = ?")
      .get(id);
    return row === null ? undefined : accountOf(row);
  }

  saveAccount(
    input: EmailAccountInput,
    id = input.id ?? crypto.randomUUID(),
  ): EmailAccountView {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO email_account (
          id, name, address, smtp_host, smtp_port, smtp_secure,
          imap_host, imap_port, imap_secure,
          inbox_folder, junk_folder, poll_interval_seconds, username, status,
          last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, address=excluded.address,
          smtp_host=excluded.smtp_host, smtp_port=excluded.smtp_port, smtp_secure=excluded.smtp_secure,
          imap_host=excluded.imap_host, imap_port=excluded.imap_port, imap_secure=excluded.imap_secure,
          inbox_folder=excluded.inbox_folder, junk_folder=excluded.junk_folder,
          poll_interval_seconds=excluded.poll_interval_seconds, username=excluded.username,
          status='unverified', last_error=NULL, updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.name.trim(),
        input.address.trim().toLowerCase(),
        input.smtpHost.trim(),
        input.smtpPort,
        input.smtpSecure ? 1 : 0,
        input.imapHost.trim(),
        input.imapPort,
        input.imapSecure ? 1 : 0,
        input.inboxFolder?.trim() || "INBOX",
        input.junkFolder?.trim() || null,
        Math.max(30, input.pollIntervalSeconds ?? 60),
        input.username.trim(),
        now,
        now,
      );
    return this.account(id)!;
  }

  setAccountState(
    id: string,
    status: EmailAccountStatus,
    error: string | null = null,
    kind: "checked" | "polled" | null = null,
  ): void {
    const now = Date.now();
    this.db
      .query(
        `UPDATE email_account SET status=?, last_error=?, updated_at=?,
          last_checked_at=CASE WHEN ?='checked' THEN ? ELSE last_checked_at END,
          last_poll_at=CASE WHEN ?='polled' THEN ? ELSE last_poll_at END
         WHERE id=?`,
      )
      .run(status, error, now, kind, now, kind, now, id);
  }

  removeAccount(id: string): boolean {
    return (
      this.db.query("DELETE FROM email_account WHERE id = ?").run(id).changes >
      0
    );
  }

  removeThreads(threadIds: readonly string[]): string[] {
    const ids = [...new Set(threadIds)].filter(
      (id) => this.thread(id) !== undefined,
    );
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.query("DELETE FROM email_proposal WHERE thread_id = ?").run(id);
        this.db.query("DELETE FROM session_email WHERE thread_id = ?").run(id);
        this.db.query("DELETE FROM email_message WHERE thread_id = ?").run(id);
        this.db.query("DELETE FROM email_thread WHERE id = ?").run(id);
      }
    })();
    return ids;
  }

  threads(accountId?: string): EmailThreadView[] {
    const rows =
      accountId === undefined
        ? this.db
            .query<ThreadRow, []>(
              `${THREAD_SELECT} ORDER BY t.last_message_at DESC, t.id`,
            )
            .all()
        : this.db
            .query<ThreadRow, [string]>(
              `${THREAD_SELECT} WHERE t.account_id = ? ORDER BY t.last_message_at DESC, t.id`,
            )
            .all(accountId);
    return rows.map(threadOf);
  }

  thread(id: string): EmailThreadView | undefined {
    const row = this.db
      .query<ThreadRow, [string]>(`${THREAD_SELECT} WHERE t.id = ?`)
      .get(id);
    return row === null ? undefined : threadOf(row);
  }

  messages(threadId: string): EmailMessageView[] {
    return this.db
      .query<MessageRow, [string]>(
        "SELECT * FROM email_message WHERE thread_id = ? ORDER BY created_at, rowid",
      )
      .all(threadId)
      .map(messageOf);
  }

  message(id: string): EmailMessageView | undefined {
    const row = this.db
      .query<MessageRow, [string]>("SELECT * FROM email_message WHERE id = ?")
      .get(id);
    return row === null ? undefined : messageOf(row);
  }

  findMessageByRfcId(
    accountId: string,
    rfcMessageId: string,
  ): EmailMessageView | undefined {
    const row = this.db
      .query<MessageRow, [string, string]>(
        "SELECT * FROM email_message WHERE account_id = ? AND rfc_message_id = ? LIMIT 1",
      )
      .get(accountId, rfcMessageId);
    return row === null ? undefined : messageOf(row);
  }

  findThreadForReply(
    accountId: string,
    inReplyTo: string | null,
    references: readonly string[],
    logicalThreadId?: string | null,
  ): EmailThreadView | undefined {
    if (logicalThreadId) {
      const direct = this.thread(logicalThreadId);
      if (direct?.accountId === accountId) return direct;
    }
    for (const id of [inReplyTo, ...[...references].reverse()]) {
      if (!id) continue;
      const found = this.findMessageByRfcId(accountId, id);
      if (found) return this.thread(found.threadId);
    }
    return undefined;
  }

  insertIncoming(input: IncomingEmailInput): {
    thread: EmailThreadView;
    message: EmailMessageView;
    created: boolean;
  } {
    const existing = this.db
      .query<MessageRow, [string, string]>(
        "SELECT * FROM email_message WHERE account_id=? AND remote_key=?",
      )
      .get(input.accountId, input.remoteKey);
    if (existing) {
      return {
        thread: this.thread(existing.thread_id)!,
        message: messageOf(existing),
        created: false,
      };
    }
    if (input.messageId) {
      const byRfc = this.findMessageByRfcId(input.accountId, input.messageId);
      if (byRfc?.direction === "incoming") {
        return {
          thread: this.thread(byRfc.threadId)!,
          message: byRfc,
          created: false,
        };
      }
    }
    const now = Date.now();
    const logicalThreadId =
      input.eta && typeof input.eta === "object"
        ? String((input.eta as Record<string, unknown>).mailThreadId ?? "")
        : "";
    let thread = this.findThreadForReply(
      input.accountId,
      input.inReplyTo,
      input.references,
      logicalThreadId,
    );
    const remoteThread =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        logicalThreadId,
      )
        ? logicalThreadId
        : undefined;
    const threadId = thread?.id ?? remoteThread ?? crypto.randomUUID();
    const messageId = crypto.randomUUID();
    this.db.transaction(() => {
      if (thread === undefined) {
        this.db
          .query(
            `INSERT INTO email_thread
             (id, account_id, peer, subject, status, unread, root_message_id, latest_message_id,
              last_message_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'new', 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            threadId,
            input.accountId,
            input.from,
            input.subject,
            input.messageId,
            input.messageId,
            now,
            now,
            now,
          );
      } else {
        this.db
          .query(
            `UPDATE email_thread SET subject=?, unread=1, latest_message_id=?,
              last_message_at=?, updated_at=? WHERE id=?`,
          )
          .run(input.subject, input.messageId, now, now, threadId);
      }
      this.db
        .query(
          `INSERT INTO email_message
           (id, thread_id, account_id, direction, status, remote_key, folder, from_address,
            to_address, subject, text_body, html_body, rfc_message_id, in_reply_to,
            references_json, eta_json, created_at)
           VALUES (?, ?, ?, 'incoming', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          threadId,
          input.accountId,
          input.remoteKey,
          input.folder,
          input.from,
          input.to,
          input.subject,
          input.text,
          input.html,
          input.messageId,
          input.inReplyTo,
          JSON.stringify(input.references),
          JSON.stringify(input.eta),
          now,
        );
    })();
    thread = this.thread(threadId);
    return {
      thread: thread!,
      message: this.message(messageId)!,
      created: true,
    };
  }

  insertOutgoing(input: OutgoingEmailInput): EmailMessageView {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO email_message
         (id, thread_id, account_id, direction, status, from_address, to_address, subject,
          text_body, html_body, rfc_message_id, in_reply_to, references_json, eta_json,
          error, created_at)
         VALUES (?, ?, ?, 'outgoing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.threadId,
          input.accountId,
          input.status,
          input.from,
          input.to,
          input.subject,
          input.text,
          input.html,
          input.messageId,
          input.inReplyTo,
          JSON.stringify(input.references),
          JSON.stringify(input.eta),
          input.error ?? null,
          now,
        );
      this.db
        .query(
          "UPDATE email_thread SET latest_message_id=?, last_message_at=?, updated_at=? WHERE id=?",
        )
        .run(input.messageId, now, now, input.threadId);
    })();
    return this.message(id)!;
  }

  setMessageStatus(
    id: string,
    status: EmailMessageStatus,
    error: string | null = null,
  ): EmailMessageView {
    this.db
      .query("UPDATE email_message SET status=?, error=? WHERE id=?")
      .run(status, error, id);
    return this.message(id)!;
  }

  createThread(input: {
    accountId: string;
    peer: string;
    subject: string;
    rootMessageId: string | null;
    latestMessageId: string | null;
  }): EmailThreadView {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO email_thread
         (id, account_id, peer, subject, status, unread, root_message_id, latest_message_id,
          last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'new', 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.accountId,
        input.peer,
        input.subject,
        input.rootMessageId,
        input.latestMessageId,
        now,
        now,
        now,
      );
    return this.thread(id)!;
  }

  markRead(threadId: string, unread: boolean): EmailThreadView {
    this.db
      .query("UPDATE email_thread SET unread=?, updated_at=? WHERE id=?")
      .run(unread ? 1 : 0, Date.now(), threadId);
    return this.thread(threadId)!;
  }

  assignments(threadId: string): EmailAssignmentView[] {
    return this.db
      .query<AssignmentRow, [string]>(
        "SELECT * FROM session_email WHERE thread_id=? ORDER BY created_at, rowid",
      )
      .all(threadId)
      .map(assignmentOf);
  }

  assignmentsForSession(sessionId: string): EmailAssignmentView[] {
    return this.db
      .query<AssignmentRow, [string]>(
        "SELECT * FROM session_email WHERE session_id=? ORDER BY created_at, rowid",
      )
      .all(sessionId)
      .map(assignmentOf);
  }

  assign(input: {
    threadId: string;
    sessionId: string;
    agentId: string;
    projectId: string;
    createdAt?: number;
  }): EmailAssignmentView {
    const id = crypto.randomUUID();
    const now = input.createdAt ?? Date.now();
    this.db.transaction(() => {
      // One current handler per mail thread. Re-assigning replaces the old session binding and
      // leaves the old conversation itself intact as history.
      this.db
        .query("DELETE FROM session_email WHERE thread_id = ?")
        .run(input.threadId);
      this.db
        .query(
          `INSERT OR IGNORE INTO session_email
           (id, session_id, thread_id, agent_id, project_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.threadId,
          input.agentId,
          input.projectId,
          now,
        );
      this.db
        .query(
          "UPDATE email_thread SET status='assigned', updated_at=? WHERE id=?",
        )
        .run(now, input.threadId);
    })();
    return this.assignments(input.threadId).find(
      (row) => row.sessionId === input.sessionId,
    )!;
  }

  proposals(threadId?: string, sessionId?: string): EmailProposalView[] {
    const where: string[] = [];
    const values: string[] = [];
    if (threadId !== undefined) {
      where.push("thread_id = ?");
      values.push(threadId);
    }
    if (sessionId !== undefined) {
      where.push("session_id = ?");
      values.push(sessionId);
    }
    return this.db
      .query<ProposalRow, string[]>(
        `SELECT * FROM email_proposal ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...values)
      .map(proposalOf);
  }

  proposal(id: string): EmailProposalView | undefined {
    const row = this.db
      .query<ProposalRow, [string]>("SELECT * FROM email_proposal WHERE id=?")
      .get(id);
    return row === null ? undefined : proposalOf(row);
  }

  createProposal(
    input: Omit<
      EmailProposalView,
      "id" | "status" | "error" | "createdAt" | "updatedAt"
    > & { context: unknown },
  ): EmailProposalView {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO email_proposal
         (id, session_id, agent_id, account_id, thread_id, reply_to_message_id, kind, status,
          from_address, to_address, cc_address, bcc_address, subject, markdown, context_json,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.agentId,
        input.accountId,
        input.threadId,
        input.replyToMessageId,
        input.kind,
        input.from,
        input.to,
        input.cc,
        input.bcc,
        input.subject,
        input.markdown,
        JSON.stringify(input.context),
        now,
        now,
      );
    return this.proposal(id)!;
  }

  proposalContext(id: string): unknown {
    const row = this.db
      .query<{ context_json: string }, [string]>(
        "SELECT context_json FROM email_proposal WHERE id=?",
      )
      .get(id);
    return row === null ? {} : json(row.context_json, {});
  }

  updateProposal(
    id: string,
    fields: Partial<Pick<EmailProposalView, "to" | "subject" | "markdown">> & {
      status?: EmailProposalStatus;
      error?: string | null;
      threadId?: string | null;
      replyToMessageId?: string | null;
    },
  ): EmailProposalView {
    const current = this.proposal(id);
    if (!current) throw new Error(`no such email proposal: ${id}`);
    this.db
      .query(
        `UPDATE email_proposal SET to_address=?, subject=?, markdown=?, thread_id=?,
          reply_to_message_id=?, status=?, error=?, updated_at=? WHERE id=?`,
      )
      .run(
        fields.to ?? current.to,
        fields.subject ?? current.subject,
        fields.markdown ?? current.markdown,
        fields.threadId === undefined ? current.threadId : fields.threadId,
        fields.replyToMessageId === undefined
          ? current.replyToMessageId
          : fields.replyToMessageId,
        fields.status ?? current.status,
        fields.error === undefined ? current.error : fields.error,
        Date.now(),
        id,
      );
    return this.proposal(id)!;
  }

  cursor(
    accountId: string,
    folder: string,
  ):
    | {
        uidValidity: string | null;
        uid: number;
      }
    | undefined {
    const row = this.db
      .query<
        { uid_validity: string | null; uid: number | null },
        [string, string]
      >(
        "SELECT uid_validity, uid FROM email_cursor WHERE account_id=? AND folder=?",
      )
      .get(accountId, folder);
    return row === null
      ? undefined
      : {
          uidValidity: row.uid_validity,
          uid: row.uid ?? 0,
        };
  }

  saveCursor(input: {
    accountId: string;
    folder: string;
    uidValidity?: string | null;
    uid?: number | null;
  }): void {
    this.db
      .query(
        `INSERT INTO email_cursor (account_id, folder, uid_validity, uid, checked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, folder) DO UPDATE SET
           uid_validity=excluded.uid_validity, uid=excluded.uid,
           checked_at=excluded.checked_at`,
      )
      .run(
        input.accountId,
        input.folder,
        input.uidValidity ?? null,
        input.uid ?? null,
        Date.now(),
      );
  }

  stats(): { unread: number; pendingProposals: number } {
    const unread = this.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM email_thread WHERE unread=1 AND status<>'archived'",
      )
      .get()!.n;
    const pendingProposals = this.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM email_proposal WHERE status='pending'",
      )
      .get()!.n;
    return { unread, pendingProposals };
  }
}
