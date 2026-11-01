import type {
  EmailAccountInput,
  EmailAccountView,
  EmailMessageView,
  EmailProposalView,
} from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { ProjectStore } from "../projects/store";
import type { EmailPayloadInput, EtaMailEnvelope } from "./context";
import type { EmailCredentials } from "./credentials";
import type { EmailStore } from "./store";
import { Buffer } from "node:buffer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { resourcePath } from "../resources";
import {
  decodeEmailMeta,
  encodeContextPackets,
  encodePayloadHeaders,
} from "./context";
import { PIXEL_PNG_BASE64, renderMail } from "./template";

const LOGO_PATH = resourcePath(
  "Eta-Logo.png",
  new URL("../../../web/public/Eta-Logo.png", import.meta.url),
);

interface PollResult {
  checked: number;
  received: number;
}

/**
 * How often the background loop looks at the accounts: a minute. It is also the shortest time a
 * broken account stays broken — one round logs in to SMTP and opens the folders, which is a
 * round trip a mail server tolerates once a minute without a backoff of its own.
 */
const TICK_MS = 60_000;

const addresses = (
  value: { text?: string } | { text?: string }[] | undefined,
) =>
  Array.isArray(value)
    ? value.map((entry) => entry.text ?? "").join(", ")
    : (value?.text ?? "");

const replySubject = (subject: string) =>
  /^re\s*:\s*/i.test(subject) ? subject : `Re: ${subject}`;

const etaSubject = (subject: string) =>
  /^\[eta-mp\]/i.test(subject) ? subject : `[eta-mp] ${subject}`;

const messageIdFor = (sessionId: string, address: string) => {
  const domain = address.split("@")[1] || "localhost";
  return `<eta.${crypto.randomUUID()}.${sessionId}@${domain}>`;
};

/**
 * The board task a session key names, when it names one. `tasks/session-key.ts` owns the full
 * mapping; a mail only needs the plain `task:<id>` form, and a legacy `task-run:<runId>` key
 * resolves to no id here rather than to a wrong one.
 */
const taskOfSessionKey = (key: string | null): string | null =>
  key !== null && key.startsWith("task:") ? key.slice("task:".length) : null;

/** The origin of a configured public URL, or nothing when it is not a site. */
const httpOrigin = (text: string | undefined): string | undefined => {
  if (text === undefined || text === "") return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
};

export class EmailService {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<PollResult> | undefined;
  /** A round owns the accounts while it runs, so the next tick waits instead of racing it. */
  #ticking = false;
  readonly #listeners = new Set<() => void>();
  readonly store: EmailStore;
  readonly #credentials: EmailCredentials;
  readonly #agents: AgentStore;
  readonly #projects: ProjectStore;
  readonly #warn: (message: string) => void;
  /** Where this host is reachable as a site, for the link back to the session. */
  readonly #origin: string | undefined;

  constructor(
    store: EmailStore,
    credentials: EmailCredentials,
    agents: AgentStore,
    projects: ProjectStore,
    warn: (message: string) => void,
    options: { publicUrl?: string | undefined } = {},
  ) {
    this.store = store;
    this.#credentials = credentials;
    this.#agents = agents;
    this.#projects = projects;
    this.#warn = warn;
    this.#origin = httpOrigin(options.publicUrl);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () =>
        void this.tick().catch((error) =>
          this.#warn(`[eta] email refresh failed: ${String(error)}`),
        ),
      TICK_MS,
    );
    this.#timer.unref?.();
  }

  /**
   * One round of the background loop: bring back what fell over, then poll what is up.
   *
   * A ready account is polled when its own interval is due. Every other account — error, or never
   * checked — is reconnected instead: `verify` logs in to SMTP and opens the inbox and junk
   * folders, and on success the account is ready again, so the poll below picks it up in the same
   * round. A failed check stays recorded on the account rather than thrown: the loop has no
   * caller to hand it to, and one account that is down must not stop the others from polling.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const account of this.store.accounts()) {
        if (account.status === "ready") continue;
        let reconnected: EmailAccountView;
        try {
          reconnected = await this.verify(account.id);
        } catch (error) {
          // `verify` records a failed check itself; this is only the account that is gone.
          this.#warn(`[eta] email ${account.address}: ${String(error)}`);
          continue;
        }
        if (reconnected.status !== "ready") {
          this.#warn(
            `[eta] email ${account.address}: ${reconnected.lastError ?? "reconnect failed"}`,
          );
        }
      }
      await this.refresh();
    } finally {
      this.#ticking = false;
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #password(accountId: string): Promise<string> {
    const stored = await this.#credentials.get(accountId);
    if (!stored) throw new Error("email account has no stored password");
    return stored;
  }

  async saveAccount(input: EmailAccountInput): Promise<EmailAccountView> {
    const account = this.store.saveAccount(input);
    if (input.password !== undefined && input.password !== "") {
      await this.#credentials.set(account.id, input.password);
    } else {
      await this.#password(account.id);
    }
    this.#changed();
    return this.verify(account.id);
  }

  async removeAccount(accountId: string): Promise<boolean> {
    const removed = this.store.removeAccount(accountId);
    await this.#credentials.delete(accountId);
    this.#changed();
    return removed;
  }

  removeThreads(threadIds: readonly string[]): string[] {
    const removed = this.store.removeThreads(threadIds);
    if (removed.length > 0) this.#changed();
    return removed;
  }

  async verify(accountId: string): Promise<EmailAccountView> {
    const account = this.store.account(accountId);
    if (!account) throw new Error(`no such email account: ${accountId}`);
    try {
      const password = await this.#password(accountId);
      const smtp = nodemailer.createTransport({
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpSecure,
        auth: { user: account.username, pass: password },
        ...(account.smtpHost === "127.0.0.1"
          ? { tls: { rejectUnauthorized: false } }
          : {}),
      });
      try {
        await smtp.verify();
      } finally {
        smtp.close();
      }
      const imap = this.#imap(account, password);
      await imap.connect();
      try {
        const mailboxes = await imap.list();
        const junkPath =
          account.junkFolder ??
          mailboxes.find((mailbox) => mailbox.specialUse === "\\Junk")?.path;
        for (const folder of [account.inboxFolder, junkPath]) {
          if (folder === undefined) continue;
          if (!mailboxes.some((mailbox) => mailbox.path === folder)) {
            throw new Error(`IMAP mailbox not found: ${folder}`);
          }
          const lock = await imap.getMailboxLock(folder, {
            readOnly: true,
            acquireTimeout: 20_000,
          });
          lock.release();
        }
      } finally {
        await imap.logout().catch(() => undefined);
      }
      this.store.setAccountState(accountId, "ready", null, "checked");
      this.#changed();
      return this.store.account(accountId)!;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setAccountState(accountId, "error", message, "checked");
      this.#changed();
      return this.store.account(accountId)!;
    }
  }

  #imap(account: EmailAccountView, password: string): ImapFlow {
    return new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: account.username, pass: password },
      doSTARTTLS: false,
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      maxLiteralSize: 25 * 1024 * 1024,
    });
  }

  refresh(accountId?: string, force = false): Promise<PollResult> {
    if (this.#running) return this.#running;
    this.#running = this.#refresh(accountId, force).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #refresh(accountId?: string, force = false): Promise<PollResult> {
    let checked = 0;
    let received = 0;
    const accounts =
      accountId === undefined
        ? this.store.accounts().filter((account) => account.status === "ready")
        : this.store
            .accounts()
            .filter(
              (account) =>
                account.status === "ready" && account.id === accountId,
            );
    for (const account of accounts) {
      const due =
        account.lastPollAt === null ||
        Date.now() - account.lastPollAt >= account.pollIntervalSeconds * 1000;
      if (!force && accountId === undefined && !due) continue;
      checked += 1;
      try {
        const password = await this.#password(account.id);
        const imap = this.#imap(account, password);
        await imap.connect();
        try {
          const mailboxes = await imap.list();
          const junk = mailboxes.find((box) => box.specialUse === "\\Junk");
          const folders = [
            { key: "inbox", path: account.inboxFolder },
            { key: "junk", path: account.junkFolder ?? junk?.path },
          ].filter(
            (folder): folder is { key: string; path: string } =>
              folder.path !== undefined,
          );
          for (const folder of folders) {
            received += await this.#scanFolder(
              account,
              imap,
              folder.key,
              folder.path,
            );
          }
          this.store.setAccountState(account.id, "ready", null, "polled");
        } finally {
          await imap.logout().catch(() => undefined);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.setAccountState(account.id, "error", message, "polled");
        this.#warn(`[eta] email ${account.address}: ${message}`);
      }
    }
    this.#changed();
    return { checked, received };
  }

  async #scanFolder(
    account: EmailAccountView,
    imap: ImapFlow,
    folderKey: string,
    folderPath: string,
  ): Promise<number> {
    const lock = await imap.getMailboxLock(folderPath, {
      readOnly: true,
      acquireTimeout: 20_000,
    });
    try {
      const mailbox = imap.mailbox;
      if (!mailbox || typeof mailbox === "boolean") return 0;
      const uidValidity = mailbox.uidValidity.toString();
      const previous = this.store.cursor(account.id, folderKey);
      if (!previous) {
        const latest =
          mailbox.exists > 0
            ? await imap.fetchOne(mailbox.exists, { uid: true })
            : false;
        this.store.saveCursor({
          accountId: account.id,
          folder: folderKey,
          uidValidity,
          uid: latest ? latest.uid : 0,
        });
        return 0;
      }
      const last = previous.uidValidity === uidValidity ? previous.uid : 0;
      let high = last;
      let received = 0;
      if (mailbox.exists > 0) {
        for await (const item of imap.fetch(
          `${last + 1}:*`,
          { uid: true, source: true },
          { uid: true },
        )) {
          if (item.uid <= last || !item.source) continue;
          high = Math.max(high, item.uid);
          const parsed = await simpleParser(Buffer.from(item.source));
          const html = typeof parsed.html === "string" ? parsed.html : "";
          const meta = decodeEmailMeta(html, parsed.headers);
          const result = this.store.insertIncoming({
            accountId: account.id,
            remoteKey: `imap:${uidValidity}:${item.uid}`,
            folder: folderKey,
            from: addresses(parsed.from),
            to: addresses(parsed.to),
            subject: parsed.subject ?? "",
            text: parsed.text ?? "",
            html,
            messageId: parsed.messageId ?? null,
            inReplyTo: parsed.inReplyTo ?? null,
            references: Array.isArray(parsed.references)
              ? parsed.references
              : parsed.references
                ? [parsed.references]
                : [],
            eta: meta,
          });
          if (result.created) received += 1;
        }
      }
      this.store.saveCursor({
        accountId: account.id,
        folder: folderKey,
        uidValidity,
        uid: high,
      });
      return received;
    } finally {
      lock.release();
    }
  }

  createProposal(input: {
    sessionId: string;
    agentId: string;
    accountId: string;
    threadId: string | null;
    replyToMessageId: string | null;
    kind: "new" | "reply";
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    markdown: string;
    /**
     * What the send carries besides the body. The tool fills `work`, `ask`, `decided`, `draft` and
     * `origin`; nothing here is guessed at send time except what only the host knows.
     */
    context?: EmailPayloadInput;
  }): EmailProposalView {
    const account = this.store.account(input.accountId);
    if (!account) throw new Error(`no such email account: ${input.accountId}`);
    const thread =
      input.threadId === null ? undefined : this.store.thread(input.threadId);
    if (input.kind === "reply" && !thread) {
      throw new Error("reply needs an email thread linked to this session");
    }
    const linked = this.store
      .assignmentsForSession(input.sessionId)
      .some((row) => row.threadId === thread?.id);
    if (input.kind === "reply" && !linked) {
      throw new Error(
        "this email thread is not assigned to the current session",
      );
    }
    const proposal = this.store.createProposal({
      sessionId: input.sessionId,
      agentId: input.agentId,
      accountId: account.id,
      threadId: thread?.id ?? null,
      replyToMessageId: input.replyToMessageId,
      kind: input.kind,
      from: account.address,
      to: input.to || thread?.peer || "",
      cc: input.cc ?? "",
      bcc: input.bcc ?? "",
      subject:
        input.kind === "reply"
          ? replySubject(input.subject || thread?.subject || "")
          : etaSubject(input.subject),
      markdown: input.markdown,
      context: input.context ?? {},
    });
    this.#changed();
    return proposal;
  }

  async confirmProposal(
    id: string,
    edits: { to?: string; subject?: string; markdown?: string } = {},
  ): Promise<{ proposal: EmailProposalView; message: EmailMessageView }> {
    let proposal = this.store.proposal(id);
    if (!proposal) throw new Error(`no such email proposal: ${id}`);
    if (proposal.status !== "pending" && proposal.status !== "failed") {
      throw new Error(`email proposal is ${proposal.status}`);
    }
    proposal = this.store.updateProposal(id, {
      ...edits,
      status: "sending",
      error: null,
    });
    const account = this.store.account(proposal.accountId);
    const parent =
      proposal.replyToMessageId === null
        ? undefined
        : this.store.message(proposal.replyToMessageId);
    try {
      if (!account) throw new Error("the email account is gone");
      if (!proposal.to.trim()) throw new Error("the email needs a recipient");
      const messageId = messageIdFor(proposal.sessionId, account.address);
      const thread =
        proposal.threadId === null
          ? this.store.createThread({
              accountId: account.id,
              peer: proposal.to,
              subject: proposal.subject,
              rootMessageId: messageId,
              latestMessageId: messageId,
            })
          : this.store.thread(proposal.threadId);
      if (!thread) throw new Error("the email thread is gone");
      if (proposal.threadId === null) {
        proposal = this.store.updateProposal(id, { threadId: thread.id });
      }
      const references =
        parent === undefined
          ? []
          : [
              ...new Set([
                ...parent.references,
                ...(parent.rfcMessageId ? [parent.rfcMessageId] : []),
              ]),
            ];
      const envelope = this.#envelope(proposal, thread.id);
      const packets = encodeContextPackets(envelope);
      const headers = encodePayloadHeaders(envelope);
      const html = renderMail({
        envelope,
        title: proposal.subject.replace(/^(?:re\s*:\s*)?\[eta-mp\]\s*/i, ""),
        status: proposal.kind === "reply" ? "REPLY" : "OUTGOING",
        markdown: proposal.markdown,
        packets,
        messageId,
        ...(this.#link(envelope.payload.from.conversationId) === undefined
          ? {}
          : { ctaUrl: this.#link(envelope.payload.from.conversationId)! }),
      });
      let message = this.store.insertOutgoing({
        accountId: account.id,
        threadId: thread.id,
        from: account.address,
        to: proposal.to,
        subject: proposal.subject,
        text: proposal.markdown,
        html,
        messageId,
        inReplyTo: parent?.rfcMessageId ?? null,
        references,
        // Store what a reader will decode, not what was encoded: an outgoing message then
        // carries the same view as an incoming one, and the round trip is checked on the way out.
        eta: decodeEmailMeta(html, headers),
        status: "sending",
      });
      try {
        await this.#send(
          account,
          proposal,
          messageId,
          parent?.rfcMessageId ?? null,
          references,
          html,
          headers,
        );
      } catch (error) {
        this.store.setMessageStatus(
          message.id,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      message = this.store.setMessageStatus(message.id, "accepted");
      proposal = this.store.updateProposal(id, {
        status: "accepted",
        error: null,
      });
      this.#changed();
      return { proposal, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      proposal = this.store.updateProposal(id, {
        status: "failed",
        error: message,
      });
      this.#changed();
      throw error;
    }
  }

  /**
   * The payload a send carries, rebuilt from what is true now.
   *
   * The body is the human's to edit and the host is the one that knows which session, directory
   * and task this is, so the payload cannot be the copy the model made before review. Rebuilding
   * here is also what keeps the rule honest: what a human typed before pressing send is in the
   * payload, so the peer's agent never has to read the body to find it.
   */
  #envelope(
    proposal: EmailProposalView,
    mailThreadId: string,
  ): EtaMailEnvelope {
    const agent = this.#agents.get(proposal.agentId);
    const context = (this.store.proposalContext(proposal.id) ??
      {}) as EmailPayloadInput;
    const conversationId = context.origin?.conversationId ?? null;
    const draft = typeof context.draft === "string" ? context.draft : null;
    const edited = draft !== null && draft.trim() !== proposal.markdown.trim();
    const createdAt = new Date().toISOString();
    return {
      v: 1,
      protocol: "eta-mp/1",
      createdAt,
      payload: {
        protocol: "eta-mp/1",
        v: 1,
        createdAt,
        from: {
          agentId: proposal.agentId,
          agentName: agent?.name ?? null,
          sessionId: proposal.sessionId,
          conversationId,
          taskId: taskOfSessionKey(conversationId),
          cwd: context.origin?.cwd ?? null,
          mailThreadId,
        },
        work: {
          doing: context.work?.doing ?? null,
          repo: context.work?.repo ?? null,
          branch: context.work?.branch ?? null,
          paths: [...(context.work?.paths ?? [])],
        },
        ask: {
          question: context.ask?.question ?? null,
          needed: context.ask?.needed ?? null,
          by: context.ask?.by ?? null,
        },
        decided: (context.decided ?? []).flatMap((entry) => {
          const value =
            typeof entry?.text === "string" ? entry.text.trim() : "";
          return value === ""
            ? []
            : [{ text: value, source: entry.source ?? null }];
        }),
        human: { note: edited ? proposal.markdown : null, edited },
      },
    };
  }

  /** Where the recipient opens the session that sent this, when this host has an address. */
  #link(conversationId: string | null): string | undefined {
    if (this.#origin === undefined || conversationId === null) return undefined;
    return `${this.#origin}/?group=${encodeURIComponent(conversationId)}`;
  }

  async #send(
    account: EmailAccountView,
    proposal: EmailProposalView,
    messageId: string,
    inReplyTo: string | null,
    references: string[],
    html: string,
    payloadHeaders: Record<string, string>,
  ): Promise<void> {
    const password = await this.#password(account.id);
    const transport = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      auth: { user: account.username, pass: password },
      ...(account.smtpHost === "127.0.0.1"
        ? { tls: { rejectUnauthorized: false } }
        : {}),
    });
    try {
      await transport.sendMail({
        from: account.address,
        to: proposal.to,
        ...(proposal.cc ? { cc: proposal.cc } : {}),
        ...(proposal.bcc ? { bcc: proposal.bcc } : {}),
        subject: proposal.subject,
        messageId,
        ...(inReplyTo ? { inReplyTo } : {}),
        references,
        text: proposal.markdown,
        html,
        headers: {
          "X-ETA-Protocol": "1",
          "X-ETA-Session-ID": proposal.sessionId,
          ...(inReplyTo ? { "X-ETA-Correlation-ID": inReplyTo } : {}),
          ...payloadHeaders,
        },
        attachments: [
          { filename: "eta-logo.png", path: LOGO_PATH, cid: "eta-logo@eta" },
          {
            filename: "eta-data.png",
            content: Buffer.from(PIXEL_PNG_BASE64, "base64"),
            cid: "eta-data@demo",
          },
        ],
      });
    } finally {
      transport.close();
    }
  }

  assignSession(input: {
    threadIds: string[];
    sessionId: string;
    agentId: string;
    projectId: string;
    createdAt?: number;
  }) {
    if (this.#agents.get(input.agentId) === undefined) {
      throw new Error("no such agent");
    }
    if (this.#projects.get(input.projectId) === undefined) {
      throw new Error("no such project");
    }
    if (input.threadIds.length === 0) throw new Error("choose an email first");
    return input.threadIds.map((threadId) => {
      if (!this.store.thread(threadId))
        throw new Error(`no such email: ${threadId}`);
      return this.store.assign({ ...input, threadId });
    });
  }
}
