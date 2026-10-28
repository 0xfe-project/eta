import type { EmailAccountInput } from "@eta/client-contracts";
import type { EtaMailEnvelope } from "../src/email/context";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import imapkit from "imapkit";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../src/agents/store";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import {
  decodeEmailMeta,
  encodeContextPackets,
  encodePayloadHeaders,
} from "../src/email/context";
import { EmailCredentials } from "../src/email/credentials";
import { renderAgentPayload } from "../src/email/payload";
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

describe("email payload", () => {
  const envelope = (): EtaMailEnvelope => {
    const createdAt = "2025-01-01T00:00:00.000Z";
    return {
      v: 1,
      protocol: "eta-mp/1",
      createdAt,
      payload: {
        protocol: "eta-mp/1",
        v: 1,
        createdAt,
        from: {
          agentId: "agent-a",
          agentName: "A",
          sessionId: "session-a",
          conversationId: "task:t1",
          taskId: "t1",
          cwd: "/work/repo",
          mailThreadId: "<mail@example.com>",
        },
        work: {
          doing: "重做 mail 载荷",
          repo: "eta",
          branch: "feat/email-payload",
          paths: ["apps/eta/src/email"],
        },
        ask: {
          question: "这个设计好不好",
          needed: "看一眼 schema",
          by: null,
        },
        decided: [{ text: "payload 是正文的超集", source: "message 12" }],
        human: { note: null, edited: false },
      },
    };
  };

  it("round-trips the payload through the image packets", () => {
    const mail = envelope();
    const packets = encodeContextPackets(mail);
    expect(packets).toHaveLength(7);
    const html = renderMail({
      envelope: mail,
      title: "Mail",
      status: "REQUEST",
      markdown: "Hello",
      packets,
      messageId: "<eta.test@example.com>",
    });
    const meta = decodeEmailMeta(html);
    expect(meta.carrier).toBe("alt");
    expect(meta.payload).toEqual(mail.payload);
    expect(meta.taskId).toBe("t1");
    expect(meta.agentName).toBe("A");
    expect(meta.signaturePresent).toBe(false);
    expect(meta.decodeError).toBeNull();
  });

  it("survives a client that rewrites the body, through the headers", () => {
    const mail = envelope();
    const headers = encodePayloadHeaders(mail);
    expect(Object.keys(headers)).toContain("X-ETA-Payload-1");
    const meta = decodeEmailMeta("<p>正文被客户端换成别的东西</p>", headers);
    expect(meta.carrier).toBe("header");
    expect(meta.payload).toEqual(mail.payload);
    expect(meta.decodeError).toBeNull();
  });

  it("says so when a mail carries nothing from an agent", () => {
    const meta = decodeEmailMeta("<p>human mail</p>");
    expect(meta.carrier).toBe("none");
    expect(meta.payload).toBeNull();
  });

  it("renders the agent side as text with its provenance", () => {
    const rendered = renderAgentPayload(envelope().payload, "header");
    expect(rendered).toContain("carrier=header");
    expect(rendered).toContain("未签名");
    expect(rendered).toContain("需要你做: 看一眼 schema");
    expect(rendered).toContain("payload 是正文的超集");
    expect(rendered).toContain("task: t1");
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
      context: {
        work: { doing: "bridge test", repo: "eta", branch: "feat/x" },
        ask: { question: "does it land", needed: "confirm it arrives" },
        decided: [{ text: "the bridge works", source: "this test" }],
        draft: "Hello from the ETA mail test.",
        origin: { conversationId: "task:t9", cwd: "/tmp/eta" },
      },
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
    // The header carrier is what a real SMTP round trip has to keep: the body may be rewritten
    // anywhere along the way, headers are not.
    expect(incoming!.meta?.carrier).toBe("header");
    expect(incoming!.meta?.payload).toMatchObject({
      ask: { needed: "confirm it arrives" },
      work: { doing: "bridge test", branch: "feat/x" },
      from: { taskId: "t9", cwd: "/tmp/eta", sessionId: "session-1" },
      human: { edited: false, note: null },
    });
    expect(incoming!.meta?.payload?.decided).toEqual([
      { text: "the bridge works", source: "this test" },
    ]);
    expect(service.store.assignments(received.id)).toHaveLength(0);
    service.stop();
    db.close();
  }, 20_000);
});
