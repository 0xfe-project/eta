/**
 * A private chat made while the host is up has its `conversations.<id>` target published, or a
 * client that learns of it from the list cannot open it. `openDirect` publishes only through the
 * `created` it is handed, so each place that opens one is checked here: the agent dialog's
 * "message" (`agents.direct`), Captain's own conversation, and an email handed to an agent.
 */
import type { ConversationSummary } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { EmailStore } from "../src/email/store";
import { world } from "./support/world";

type World = Awaited<ReturnType<typeof world>>;

const published = (w: World, conversationId: string): boolean =>
  w.host.server.wire
    .targets()
    .some((target) => target.name === `conversations.${conversationId}`);

/** The agent's private chats, in any project. */
const directs = (w: World, agentId: string, projectId?: string): string[] =>
  w.host.db
    .query<{ id: string }, [string, string | null, string | null]>(
      `SELECT c.id FROM conversation c
       JOIN participant p ON p.conversation_id = c.id
       WHERE c.kind = 'direct' AND p.agent_id = ? AND (? IS NULL OR c.project_id = ?)`,
    )
    .all(agentId, projectId ?? null, projectId ?? null)
    .map((row) => row.id);

describe("a private chat made while the host is up", () => {
  it("is published when the agent dialog opens it (agents.direct)", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    // Made with the agent? Then it is not new here: start from none.
    for (const id of directs(w, ada.id))
      w.host.db.query("DELETE FROM conversation WHERE id = ?").run(id);
    const { conversation } = (await w.client.call("agents", "direct", {
      agentId: ada.id,
    })) as { conversation: ConversationSummary };
    expect(published(w, conversation.id)).toBe(true);
  });

  it("is published when Captain makes its own again (captain.direct)", async () => {
    const w = await world({ captain: true, tasks: { runs: false } });
    const captain = w.host.product.captain.identity()!;
    // The host made it at start; one gone since is made again the next time Captain is asked for.
    for (const id of directs(w, captain.agentId))
      w.host.db.query("DELETE FROM conversation WHERE id = ?").run(id);
    const { conversationId } = (await w.client.call(
      "captain",
      "direct",
      {},
    )) as {
      conversationId: string;
    };
    expect(directs(w, captain.agentId)).toEqual([conversationId]);
    expect(published(w, conversationId)).toBe(true);
  });

  it("is published when an email is handed to an agent (email.assign)", async () => {
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
      subject: "Please handle this",
      rootMessageId: "<mail@eta.test>",
      latestMessageId: "<mail@eta.test>",
    });
    const agent = await w.agent("Mailer");
    // Another project than the agent's home, so its private chat there is new.
    const project = await w.project({ stewardId: agent.id });
    expect(directs(w, agent.id, project.id)).toEqual([]);
    const { conversationId } = (await w.client.call("email", "assign", {
      threadIds: [thread.id],
      agentId: agent.id,
      projectId: project.id,
    })) as { conversationId: string };
    expect(published(w, conversationId)).toBe(true);
  });
});
