import type { EmailAccountInput } from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import imapkit from "imapkit";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../src/agents/store";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { decodeEmailMeta, encodeContextPackets } from "../src/email/context";
import { EmailCredentials } from "../src/email/credentials";
import { EmailService } from "../src/email/service";
import { EmailStore } from "../src/email/store";
import { renderMail } from "../src/email/template";
import { ProjectStore } from "../src/projects/store";
import { loadSecretKey } from "../src/secret";
import { tempDir } from "./support/host";
import { world } from "./support/world";

const servers: ReturnType<typeof imapkit>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

describe("email context", () => {
  it("round-trips session metadata through the logo and data points", () => {
    const envelope = {
      v: 1 as const,
      protocol: "eta-mp/1" as const,
      agentId: "agent-a",
      agentName: "A",
      sessionId: "session-a",
      logicalSessionId: "thread-1",
      mailThreadId: "thread-1",
      taskId: null,
      createdAt: new Date().toISOString(),
      context: { answer: 42, turns: ["one", "two"] },
    };
    const packets = encodeContextPackets(envelope);
    expect(packets).toHaveLength(7);
    const html = renderMail({
      envelope,
      title: "Mail",
      status: "REQUEST",
      markdown: "Hello",
      packets,
      messageId: "<eta.test@example.com>",
    });
    expect(decodeEmailMeta(html)).toMatchObject({
      protocol: "eta-mp/1",
      agentId: "agent-a",
      sessionId: "session-a",
      mailThreadId: "thread-1",
      packetCount: packets.length,
      decodeError: null,
      context: envelope.context,
    });
  });
});

describe("email wire", () => {
  it("mounts an independent inbox target without creating an agent session", async () => {
    const w = await world();
    const hello = await w.client.hello();
    expect(hello.mounted.map((plugin) => plugin.name)).toContain("email");
    expect(hello.ops.map((op) => op.name)).toEqual(
      expect.arrayContaining([
        "email.saveAccount",
        "email.assign",
        "email.confirmProposal",
      ]),
    );
    expect(hello.state.email?.sections).toMatchObject({
      accounts: [],
      threads: [],
      stats: { unread: 0, pendingProposals: 0 },
    });
    expect(w.client.section<unknown[]>("sessions", "list")).toEqual([]);
  });

  it("hands mail to the selected agent in a real private conversation", async () => {
    const w = await world();
    const store = new EmailStore(w.host.db);
    const account = store.saveAccount({
      name: "Mailbox",
      address: "inbox@eta.test",
      smtpHost: "smtp.eta.test",
      smtpPort: 465,
      smtpSecure: true,
      imapHost: "imap.eta.test",
      imapPort: 993,
      imapSecure: true,
      username: "inbox@eta.test",
    });
    const thread = store.createThread({
      accountId: account.id,
      peer: "sender@eta.test",
      subject: "[eta-mp] Please handle this",
      rootMessageId: "<mail@eta.test>",
      latestMessageId: "<mail@eta.test>",
    });
    store.insertIncoming({
      accountId: account.id,
      remoteKey: "imap:test:1",
      folder: "inbox",
      from: "sender@eta.test",
      to: account.address,
      subject: thread.subject,
      text: "Please handle this email.",
      html: "<p>Please handle this email.</p>",
      messageId: "<mail@eta.test>",
      inReplyTo: null,
      references: [],
      eta: null,
    });
    const agent = await w.agent("Mailer");
    const project = await w.project({ stewardId: agent.id });

    const assigned = (await w.client.call("email", "assign", {
      threadIds: [thread.id],
      agentId: agent.id,
      projectId: project.id,
    })) as {
      sessionId: string;
      conversationId: string;
      agentName: string;
      assignments: { sessionId: string }[];
    };

    expect(assigned).toMatchObject({
      agentName: "Mailer",
      assignments: [{ sessionId: assigned.sessionId }],
    });
    expect(assigned.conversationId.startsWith("mail:")).toBe(false);
    await w.watch(assigned.conversationId);
    expect(
      w
        .rows(assigned.conversationId)
        .some(
          (message) =>
            message.author === "user" &&
            message.text.includes("## Email: [eta-mp] Please handle this"),
        ),
    ).toBe(true);

    const reassigned = (await w.client.call("email", "assign", {
      threadIds: [thread.id],
      agentId: agent.id,
      projectId: project.id,
    })) as {
      sessionId: string;
      assignments: unknown[];
    };
    expect(reassigned.sessionId).toBe(assigned.sessionId);
    expect(reassigned.assignments).toHaveLength(1);

    const deleted = (await w.client.call("email", "deleteThreads", {
      threadIds: [thread.id],
    })) as { threadIds: string[] };
    expect(deleted.threadIds).toEqual([thread.id]);
    expect(store.thread(thread.id)).toBeUndefined();
    expect(store.messages(thread.id)).toEqual([]);
  });
});

describe("iMAP and SMTP bridge", () => {
  it("verifies an account, sends a confirmed proposal and receives it without waking an agent", async () => {
    const server = imapkit({
      users: { "mailbox@eta.test": { password: "secret" } },
      storage: {
        INBOX: { subscribed: true, messages: [] },
        "": { folders: { Junk: { messages: [] } } },
      },
      plugins: ["SPECIAL-USE"],
      smtp: { host: "127.0.0.1", port: 0 },
    });
    servers.push(server);
    const imapPort = await server.start(0, "127.0.0.1");
    server.control.setSpecialUse("Junk", ["\\Junk"]);
    const smtpAddress = server.smtpServer?.server.address();
    if (!smtpAddress || typeof smtpAddress === "string")
      throw new Error("SMTP did not start");
    const dir = await tempDir("eta-email-");
    const db = openDatabase(join(dir, "eta.sqlite"));
    applyMigrations(db, loadMigrations());
    const store = new EmailStore(db);
    const service = new EmailService(
      store,
      new EmailCredentials(db, loadSecretKey(dir)),
      new AgentStore(db),
      new ProjectStore(db),
      () => undefined,
    );
    const input: EmailAccountInput = {
      name: "Mailbox",
      address: "mailbox@eta.test",
      smtpHost: "127.0.0.1",
      smtpPort: smtpAddress.port,
      smtpSecure: false,
      imapHost: "127.0.0.1",
      imapPort,
      imapSecure: false,
      inboxFolder: "INBOX",
      username: "mailbox@eta.test",
      password: "secret",
    };
    const account = await service.saveAccount(input);
    expect(account.status, account.lastError ?? undefined).toBe("ready");
    const edited = await service.saveAccount({
      ...input,
      id: account.id,
      name: "Edited mailbox",
      password: "",
    });
    expect(edited).toMatchObject({
      id: account.id,
      name: "Edited mailbox",
      status: "ready",
    });
    const sealed = db
      .query<{ value: Uint8Array }, []>(
        "SELECT value FROM credential WHERE integration='email'",
      )
      .get()!;
    expect(Buffer.from(sealed.value).includes("secret")).toBe(false);
    await service.refresh(account.id);
    const proposal = service.createProposal({
      sessionId: "session-1",
      agentId: "agent-1",
      accountId: account.id,
      threadId: null,
      replyToMessageId: null,
      kind: "new",
      to: "mailbox@eta.test",
      subject: "Bridge test",
      markdown: "Hello from the ETA mail test.",
      context: { test: true, turns: 3 },
    });
    const sent = await service.confirmProposal(proposal.id);
    expect(sent.proposal.status).toBe("accepted");
    expect(sent.message.rfcMessageId).toContain("session-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refreshed = await service.refresh(account.id);
    expect(refreshed.received).toBeGreaterThanOrEqual(1);
    const received = service.store.threads()[0]!;
    expect(received.incomingCount).toBeGreaterThanOrEqual(1);
    expect(received.outgoingCount).toBeGreaterThanOrEqual(1);
    const incoming = service.store
      .messages(received.id)
      .find((message) => message.direction === "incoming");
    expect(incoming).toBeDefined();
    expect(incoming!.meta?.mailThreadId).toBe(received.id);
    expect(incoming!.meta?.sessionId).toBe("session-1");
    expect(service.store.assignments(received.id)).toHaveLength(0);
    service.stop();
    db.close();
  }, 20_000);
});
