import type { EmailAccountInput } from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { Engine } from "../conversations/engine";
import type { ConversationStore } from "../conversations/store";
import type { ProjectStore } from "../projects/store";
import type { EmailService } from "./service";
import { openDirect } from "../conversations/direct";
import { Args, productPlugin, publish } from "../wire";
import { renderAgentPayload } from "./payload";

export interface EmailPluginDeps {
  service: EmailService;
  projects: ProjectStore;
  agents: AgentStore;
  conversations: ConversationStore;
  engine: Engine;
  createdConversation: (conversationId: string) => void;
}

function accountInput(args: Args): EmailAccountInput {
  const input: EmailAccountInput = {
    id: args.optionalString("id"),
    name: args.string("name"),
    address: args.string("address"),
    smtpHost: args.string("smtpHost"),
    smtpPort: args.integer("smtpPort"),
    smtpSecure: args.optionalBoolean("smtpSecure") ?? true,
    imapHost: args.string("imapHost"),
    imapPort: args.integer("imapPort"),
    imapSecure: args.optionalBoolean("imapSecure") ?? true,
    inboxFolder: args.optionalString("inboxFolder") ?? "INBOX",
    junkFolder: args.nullableString("junkFolder") ?? null,
    pollIntervalSeconds: args.optionalInteger("pollIntervalSeconds") ?? 60,
    username: args.string("username"),
    password: args.optionalString("password"),
  };
  return input;
}

function briefing(service: EmailService, threadIds: readonly string[]): string {
  const sections = threadIds.map((threadId) => {
    const thread = service.store.thread(threadId);
    if (!thread) return "";
    const messages = service.store.messages(threadId).slice(-8);
    return [
      `## Email: ${thread.subject}`,
      `Thread: ${thread.id}`,
      `Peer: ${thread.peer}`,
      ...messages.map((message) => {
        const payload = message.meta?.payload ?? null;
        // Same rule as the read tool: a peer agent's payload is what it needs; the body only
        // matters for what the payload cannot hold.
        const body =
          payload === null
            ? message.text.slice(0, 12_000)
            : `${renderAgentPayload(payload, message.meta?.carrier ?? "none")}${
                payload.human.note === null
                  ? ""
                  : `\n\nhuman.note:\n${message.text.slice(0, 12_000)}`
              }`;
        return `### ${message.direction === "incoming" ? "Incoming" : "Outgoing"} · ${new Date(message.createdAt).toISOString()}\n${body}`;
      }),
      "The user explicitly handed this email to you. Use `reply` to prepare a reply widget; it will not send until the user confirms.",
    ].join("\n\n");
  });
  return sections.filter(Boolean).join("\n\n---\n\n");
}

export function emailPlugin(deps: EmailPluginDeps, applied: () => void) {
  const { service, projects, agents, conversations, engine } = deps;
  return productPlugin(
    "email",
    (ctx) => {
      const { wire } = ctx;
      service.start();
      const targets = new Map<string, () => void>();
      const add = (threadId: string) => {
        if (targets.has(threadId)) return;
        targets.set(
          threadId,
          publish(wire, `email.${threadId}`, {
            thread: () => service.store.thread(threadId),
            messages: () => service.store.messages(threadId),
            assignments: () => service.store.assignments(threadId),
            proposals: () => service.store.proposals(threadId),
          }),
        );
      };
      for (const thread of service.store.threads()) add(thread.id);

      const offs = [
        publish(
          wire,
          "email",
          {
            accounts: () => service.store.accounts(),
            threads: () => service.store.threads(),
            proposals: () => service.store.proposals(),
            stats: () => service.store.stats(),
          },
          { eager: true },
        ),

        service.onChange(() => {
          for (const thread of service.store.threads()) add(thread.id);
          wire.pushNow("email");
          for (const threadId of targets.keys())
            wire.pushNow(`email.${threadId}`);
        }),

        wire.handle("email", "saveAccount", async (call) => {
          const account = await service.saveAccount(
            accountInput(new Args(call)),
          );
          return { result: { account } };
        }),

        wire.handle("email", "removeAccount", async (call) => {
          const accountId = new Args(call).string("accountId");
          return {
            result: {
              accountId,
              removed: await service.removeAccount(accountId),
            },
          };
        }),

        wire.handle("email", "verifyAccount", async (call) => {
          const account = await service.verify(
            new Args(call).string("accountId"),
          );
          return { result: { account } };
        }),

        wire.handle("email", "refresh", async (call) => {
          const accountId = new Args(call).optionalString("accountId");
          return { result: await service.refresh(accountId, true) };
        }),

        wire.handle("email", "markRead", (call) => {
          const args = new Args(call);
          return {
            result: {
              thread: service.store.markRead(
                args.string("threadId"),
                args.optionalBoolean("unread") ?? false,
              ),
            },
          };
        }),

        wire.handle("email", "deleteThreads", (call) => {
          const threadIds = [...new Set(new Args(call).strings("threadIds"))];
          const removed = service.removeThreads(threadIds);
          for (const threadId of removed) {
            targets.get(threadId)?.();
            targets.delete(threadId);
          }
          return { result: { threadIds: removed } };
        }),

        wire.handle("email", "assign", async (call) => {
          const args = new Args(call);
          const threadIds = [...new Set(args.strings("threadIds"))];
          if (threadIds.length === 0)
            throw new Error("choose at least one email");
          const agentId = args.string("agentId");
          const agent = agents.get(agentId);
          if (!agent) throw new Error("no such agent");
          const projectId = args.string("projectId");
          const project = projects.get(projectId);
          if (!project) throw new Error("no such project");
          const existing = args.optionalString("sessionId");
          const first = service.store.thread(threadIds[0]!);
          if (!first) throw new Error("no such email thread");
          if (existing) {
            throw new Error(
              "assigning to an existing session is not supported; choose a project",
            );
          }
          // Not told `changed`: the briefing sent next publishes the conversation, as it always did.
          const conversation = openDirect(
            { conversations, created: deps.createdConversation },
            project,
            agent,
          );
          const startedAt = Date.now();
          await engine.send({
            conversationId: conversation.id,
            text: briefing(service, threadIds),
            mentions: [agentId],
            mode: "queue",
          });
          let sessionId: string | undefined;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            sessionId =
              conversations.participant(conversation.id, agentId)?.sessionId ??
              undefined;
            if (sessionId) break;
            await Bun.sleep(25);
          }
          if (!sessionId) throw new Error("the agent session did not start");
          const assignments = service.assignSession({
            threadIds,
            sessionId,
            agentId,
            projectId,
            createdAt: startedAt,
          });
          return {
            result: {
              sessionId,
              conversationId: conversation.id,
              agentName: agent.name,
              assignments,
            },
          };
        }),

        wire.handle("email", "confirmProposal", async (call) => {
          const args = new Args(call);
          const result = await service.confirmProposal(
            args.string("proposalId"),
            {
              ...(args.optionalString("to") === undefined
                ? {}
                : { to: args.optionalString("to") }),
              ...(args.optionalString("subject") === undefined
                ? {}
                : { subject: args.optionalString("subject") }),
              ...(args.optionalString("markdown") === undefined
                ? {}
                : { markdown: args.optionalString("markdown") }),
            },
          );
          return { result };
        }),

        wire.handle("email", "discardProposal", (call) => {
          const proposalId = new Args(call).string("proposalId");
          service.store.updateProposal(proposalId, {
            status: "discarded",
            error: null,
          });
          return { result: { proposalId } };
        }),
      ];

      return () => {
        service.stop();
        for (const off of offs.splice(0)) off();
        for (const off of targets.values()) off();
        targets.clear();
      };
    },
    applied,
  );
}
