import type { SessionHooks } from "../session-hooks";
import type { EmailService } from "./service";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";

export function emailSessionTools(
  service: EmailService,
): NonNullable<SessionHooks["sessionTools"]> {
  return ({ meta }) => {
    if (meta.agentId === undefined) return [];
    const linked = () => service.store.assignmentsForSession(meta.id);

    const list = defineTool({
      name: "list_emails",
      description:
        "List the email threads explicitly handed to this session. Emails are never attached to an agent automatically.",
      parameters: Type.Object({}),
      async execute() {
        const assignments = linked();
        if (assignments.length === 0)
          return text("No email threads are linked to this session.");
        const rows = assignments.flatMap((assignment) => {
          const thread = service.store.thread(assignment.threadId);
          return thread
            ? [
                `- ${thread.subject} | ${thread.peer} | thread=${thread.id} | messages=${thread.messageCount}`,
              ]
            : [];
        });
        return text(rows.join("\n"), {
          threads: assignments.map((row) => row.threadId),
        });
      },
    });

    const read = defineTool({
      name: "read_email",
      description:
        "Read one email thread linked to this session, including its human text, RFC 5322 headers and decoded ETA metadata.",
      parameters: Type.Object({
        threadId: Type.String({ description: "The linked mail thread id" }),
        messageId: Type.Optional(Type.String()),
      }),
      async execute(args) {
        if (!linked().some((row) => row.threadId === args.threadId)) {
          return toolError("That email thread is not linked to this session.");
        }
        const thread = service.store.thread(args.threadId);
        if (!thread) return toolError("No such email thread.");
        const messages = service.store.messages(args.threadId);
        const selected =
          args.messageId === undefined
            ? messages
            : messages.filter((message) => message.id === args.messageId);
        if (selected.length === 0)
          return toolError("No such message in the thread.");
        const body = selected
          .map(
            (message) =>
              `## ${message.subject}\nFrom: ${message.from}\nTo: ${message.to}\nMessage-ID: ${message.rfcMessageId ?? "(none)"}\nIn-Reply-To: ${message.inReplyTo ?? "(none)"}\n\n${message.text.slice(0, 20_000)}`,
          )
          .join("\n\n---\n\n");
        return text(body, {
          thread,
          meta: selected.map((message) => message.meta),
        });
      },
    });

    const send = defineTool({
      name: "send_email",
      description:
        "Prepare a new email as a widget for the user to review. This never sends immediately. Choose an account explicitly when more than one exists.",
      parameters: Type.Object({
        accountId: Type.Optional(Type.String()),
        to: Type.String(),
        cc: Type.Optional(Type.String()),
        bcc: Type.Optional(Type.String()),
        subject: Type.String(),
        markdown: Type.String(),
        context: Type.Optional(Type.Unknown()),
      }),
      async execute(args) {
        const accounts = service.store.accounts();
        const account =
          args.accountId === undefined
            ? accounts.length === 1
              ? accounts[0]
              : undefined
            : accounts.find((item) => item.id === args.accountId);
        if (!account) {
          return toolError(
            accounts.length === 0
              ? "No email account is configured."
              : `Choose one account: ${accounts.map((item) => `${item.name}=${item.id}`).join(", ")}`,
          );
        }
        const proposal = service.createProposal({
          sessionId: meta.id,
          agentId: meta.agentId!,
          accountId: account.id,
          threadId: null,
          replyToMessageId: null,
          kind: "new",
          to: args.to,
          ...(args.cc === undefined ? {} : { cc: args.cc }),
          ...(args.bcc === undefined ? {} : { bcc: args.bcc }),
          subject: args.subject,
          markdown: args.markdown,
          context: args.context ?? {},
        });
        return text(
          `Prepared email proposal ${proposal.id}. It has not been sent; the user must confirm it.`,
          { emailProposalId: proposal.id, kind: "new" },
        );
      },
    });

    const reply = defineTool({
      name: "reply",
      description:
        "Prepare a reply on an email thread already handed to this session. This creates a review widget and never sends immediately.",
      parameters: Type.Object({
        threadId: Type.String({
          description: "The linked mail thread to reply to",
        }),
        markdown: Type.String(),
        context: Type.Optional(Type.Unknown()),
      }),
      async execute(args) {
        const thread = service.store.thread(args.threadId);
        if (!thread) return toolError("No such email thread.");
        if (!linked().some((row) => row.threadId === thread.id)) {
          return toolError("That email thread is not linked to this session.");
        }
        const messages = service.store.messages(thread.id);
        const parent = [...messages]
          .reverse()
          .find((message) => message.direction === "incoming");
        const proposal = service.createProposal({
          sessionId: meta.id,
          agentId: meta.agentId!,
          accountId: thread.accountId,
          threadId: thread.id,
          replyToMessageId: parent?.id ?? null,
          kind: "reply",
          to: thread.peer,
          subject: thread.subject,
          markdown: args.markdown,
          context: args.context ?? {},
        });
        return text(
          `Prepared reply proposal ${proposal.id}. It has not been sent; the user must confirm it.`,
          { emailProposalId: proposal.id, kind: "reply", threadId: thread.id },
        );
      },
    });

    return [list, read, send, reply].map((tool) =>
      toKernelTool(tool, () => undefined),
    );
  };
}
