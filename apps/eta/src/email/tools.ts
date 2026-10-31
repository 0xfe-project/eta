import type { SessionHooks } from "../session-hooks";
import type { EmailPayloadInput } from "./context";
import type { EmailService } from "./service";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { renderAgentPayload } from "./payload";

/**
 * What a send carries besides the body.
 *
 * The fields are the model's to fill: only the agent knows what it is doing and what the peer
 * needs back. The host adds who and where at send time, so nothing here may claim an identity.
 */
const payloadSchema = Type.Object({
  question: Type.Optional(
    Type.String({
      description: "The human's question, close to their own words.",
    }),
  ),
  needed: Type.Optional(
    Type.String({
      description:
        "What the peer's agent has to do or answer. One sentence, no context.",
    }),
  ),
  by: Type.Optional(
    Type.String({ description: "When it is needed, in the sender's words." }),
  ),
  doing: Type.Optional(
    Type.String({
      description:
        "What this session is doing now, one line, as you would say it.",
    }),
  ),
  repo: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Paths the peer has to look at to follow you.",
    }),
  ),
  decided: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String({ description: "One thing already settled." }),
        source: Type.Optional(
          Type.String({
            description:
              "Where it came from: a message, a task, an artifact, a path.",
          }),
        ),
      }),
      {
        description:
          "What you have settled already, so the peer does not reopen it.",
      },
    ),
  ),
});

interface PayloadArgs {
  question?: string;
  needed?: string;
  by?: string;
  doing?: string;
  repo?: string;
  branch?: string;
  paths?: string[];
  decided?: { text: string; source?: string }[];
}

/** The model's part of a send plus the host's part: identity and place are never the model's. */
function payloadInput(
  args: PayloadArgs | undefined,
  meta: {
    conversationId?: string | undefined;
    cwd: string;
  },
  markdown: string,
): EmailPayloadInput {
  return {
    work: {
      doing: args?.doing ?? null,
      repo: args?.repo ?? null,
      branch: args?.branch ?? null,
      paths: args?.paths ?? [],
    },
    ask: {
      question: args?.question ?? null,
      needed: args?.needed ?? null,
      by: args?.by ?? null,
    },
    decided: (args?.decided ?? []).map((entry) => ({
      text: entry.text,
      source: entry.source ?? null,
    })),
    draft: markdown,
    origin: { conversationId: meta.conversationId ?? null, cwd: meta.cwd },
  };
}

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
        "Read one email thread linked to this session. A mail from another ETA host carries an agent-side payload, rendered here with its carrier and its provenance; a plain mail carries only its text.",
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
          .map((message) => {
            const head = `## ${message.subject}\nFrom: ${message.from}\nTo: ${message.to}\nMessage-ID: ${message.rfcMessageId ?? "(none)"}\nIn-Reply-To: ${message.inReplyTo ?? "(none)"}`;
            const payload = message.meta?.payload ?? null;
            if (payload === null) {
              return `${head}\n\n${message.text.slice(0, 20_000)}`;
            }
            const agent = renderAgentPayload(
              payload,
              message.meta?.carrier ?? "none",
            );
            // The body is short by design and the payload carries it; what the payload cannot
            // carry is a human rewriting it just before send, so only that is repeated here.
            const human =
              payload.human.note === null
                ? "\n\n（人看的正文从略：内容都在上面的载荷里。）"
                : `\n\n人看的正文（发送前由对方的人改过）:\n${message.text.slice(0, 20_000)}`;
            return `${head}\n\n${agent}${human}`;
          })
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
        "Prepare a new email as a widget for the user to review. This never sends immediately. Choose an account explicitly when more than one exists. The body is what a person reads and has to be able to audit in one look — who is asking, what is needed back, how to get to the session. Everything a peer's agent needs goes in `context`.",
      parameters: Type.Object({
        accountId: Type.Optional(Type.String()),
        to: Type.String(),
        cc: Type.Optional(Type.String()),
        bcc: Type.Optional(Type.String()),
        subject: Type.String(),
        markdown: Type.String({
          description:
            "The human-readable body. Short: the ask, and the link back. Depth belongs in `context`.",
        }),
        context: Type.Optional(payloadSchema),
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
          context: payloadInput(args.context, meta, args.markdown),
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
        "Prepare a reply on an email thread already handed to this session. This creates a review widget and never sends immediately. Same rule as `send_email`: a short body for the human, the substance in `context`.",
      parameters: Type.Object({
        threadId: Type.String({
          description: "The linked mail thread to reply to",
        }),
        markdown: Type.String({
          description:
            "The human-readable body. Short: the ask, and the link back. Depth belongs in `context`.",
        }),
        context: Type.Optional(payloadSchema),
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
          context: payloadInput(args.context, meta, args.markdown),
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
