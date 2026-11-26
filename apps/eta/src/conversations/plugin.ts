/**
 * The `conversations` plugin: the timelines, and what saying something in one does.
 *
 * The list is eager (a client draws its sidebar from `hello`), and each conversation is a target
 * of its own. Everything that happens to a conversation is one of the actions below; the work of
 * answering a message is the engine's (`engine.ts`), this file is the surface in front of it:
 * arguments read, rules that belong to the conversation checked, state pushed.
 */
import type { ConversationSummary } from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { AttachmentStore } from "./attachments";
import type { Engine } from "./engine";
import type { ConversationPolicies } from "./policy";
import type { ConversationRecord, ConversationStore } from "./store";
import type { ConversationTargets } from "./targets";
import type { Timeline } from "./timeline";
import { checkExternalAgentProject } from "../agents/bounds";
import { Args, productPlugin, publish } from "../wire";
import { createGroup, groupNamed } from "./groups";
import { announceSteward } from "./steward";
import { summaryOf } from "./views";

export interface ConversationsDeps {
  agents: AgentStore;
  machines: MachineStore;
  projects: ProjectStore;
  conversations: ConversationStore;
  policies: ConversationPolicies;
  timeline: Timeline;
  engine: Engine;
  attachments: AttachmentStore;
  targets: ConversationTargets;
  changed: (conversations?: readonly string[] | "all") => void;
  created: (conversationId: string) => void;
}

/** The rows `history` returns when a client does not say how many. */
const PAGE = 50;
const MAX_PAGE = 200;

export function conversationsPlugin(
  deps: ConversationsDeps,
  applied: () => void,
) {
  const { agents, conversations, timeline, engine } = deps;
  const views = { conversations, timeline };

  const existing = (id: string): ConversationRecord => {
    const conversation = conversations.get(id);
    if (conversation === undefined)
      throw new Error(`no such conversation: ${id}`);
    return conversation;
  };

  const policyOf = (conversation: ConversationRecord) =>
    deps.policies.of(conversation.kind);

  /** Who is in it is the conversation's to say: some kinds have their members fixed. */
  const changeable = (conversation: ConversationRecord): ConversationRecord => {
    const policy = policyOf(conversation);
    if (!policy.canChangeMembers(conversation))
      throw new Error(
        policy.membersFixed ?? "who is in this conversation cannot be changed",
      );
    return conversation;
  };

  const summary = (conversation: ConversationRecord): ConversationSummary =>
    summaryOf(views, conversation);

  const agent = (id: string): string => {
    if (agents.get(id) === undefined) throw new Error(`no such agent: ${id}`);
    return id;
  };

  return productPlugin(
    "conversations",
    (ctx) => {
      const { wire } = ctx;
      engine.attach(ctx.sessions);
      deps.targets.attach(wire);
      const offs = [
        publish(
          wire,
          "conversations",
          {
            list: () =>
              conversations
                .list()
                .filter((conversation) => deps.policies.listed(conversation))
                .map(summary),
          },
          { eager: true },
        ),

        wire.handle("conversations", "create", (call) => {
          const args = new Args(call);
          const conversation = createGroup(deps, {
            projectId: args.string("projectId"),
            agentIds: args.strings("agentIds"),
            stewardId: args.nullableString("stewardId"),
            name: args.optionalString("name"),
          });
          deps.created(conversation.id);
          deps.changed([conversation.id]);
          return { result: { conversation: summary(conversation) } };
        }),

        wire.handle("conversations", "recall", (call) => {
          const args = new Args(call);
          const id = args.string("conversationId");
          existing(id);
          const recalled = engine.recall(id, args.string("messageId"));
          deps.changed([id]);
          return { result: { conversationId: id, recalled } };
        }),

        wire.handle("conversations", "steerHeld", async (call) => {
          const args = new Args(call);
          const id = args.string("conversationId");
          existing(id);
          return {
            result: await engine.steerHeld(id, args.string("messageId")),
          };
        }),

        wire.handle("conversations", "update", (call) => {
          const args = new Args(call);
          const id = args.string("conversationId");
          const current = existing(id);
          const name = args.optionalString("name")?.trim();
          if (name === "") throw new Error("a conversation needs a name");
          // Two live groups of a project with one name are two rows nobody can tell apart: the
          // same rule Captain's proposals keep. Archived groups and other projects' do not count.
          if (name !== undefined && current.kind === "group") {
            const clash = groupNamed(conversations, current.projectId, name);
            if (clash !== undefined && clash.id !== id)
              throw new Error(
                `a group named "${name}" already exists in this project`,
              );
          }
          const archived = args.optionalBoolean("archived");
          const refused = policyOf(current).updateRefusal(current, {
            archived,
          });
          if (refused !== undefined) throw new Error(refused);
          const conversation = conversations.update(id, {
            name,
            goal: args.optionalString("goal"),
            decided: args.optionalString("decided"),
            archived,
          })!;
          deps.changed([id]);
          return { result: { conversation: summary(conversation) } };
        }),

        wire.handle("conversations", "invite", (call) => {
          const args = new Args(call);
          const conversation = changeable(
            existing(args.string("conversationId")),
          );
          // One agent (`agentId`) or a group of them (`agentIds`), never both. A group goes in
          // as one: every agent is checked first and the rows land in one transaction, so a
          // missing one leaves the conversation as it was. One already a member is no change,
          // the same as inviting it alone twice.
          const single = args.optionalString("agentId");
          const many = args.optionalStrings("agentIds");
          if (single !== undefined && many !== undefined)
            throw new Error(
              "conversations.invite takes agentId or agentIds, not both",
            );
          const agentIds = many ?? [args.string("agentId")];
          if (agentIds.length === 0)
            throw new Error("conversations.invite needs agentIds");
          // Which one is missing is the error: `no such agent: <id>`.
          const project = deps.projects.get(conversation.projectId);
          for (const id of agentIds) {
            agent(id);
            if (project !== undefined)
              checkExternalAgentProject(
                agents.get(id)!,
                project,
                deps.machines,
              );
          }
          conversations.addParticipants(conversation.id, agentIds);
          deps.changed([conversation.id]);
          return { result: { conversation: summary(conversation) } };
        }),

        wire.handle("conversations", "remove", (call) => {
          const args = new Args(call);
          const conversation = changeable(
            existing(args.string("conversationId")),
          );
          const agentId = args.string("agentId");
          // What the member was answering stops with it; its session stays, as a record.
          engine.stopMember(conversation.id, agentId);
          // A steward that leaves takes the role with it: the group has none until someone is
          // made one, and nobody is pulled back in for a message that names nobody.
          if (
            conversations.removeParticipant(conversation.id, agentId) &&
            conversation.stewardId === agentId
          )
            announceSteward(
              { agents, timeline },
              conversation.id,
              agentId,
              null,
              "left",
            );
          deps.changed([conversation.id]);
          return {
            result: { conversation: summary(existing(conversation.id)) },
          };
        }),

        wire.handle("conversations", "setSteward", (call) => {
          const args = new Args(call);
          const conversation = existing(args.string("conversationId"));
          const agentId = args.nullableString("agentId");
          if (agentId === undefined)
            throw new Error("conversations.setSteward needs agentId (or null)");
          // A steward is one of the members, or there is none: nobody is added for it.
          if (
            agentId !== null &&
            !conversations
              .participants(conversation.id)
              .some((member) => member.agentId === agent(agentId))
          )
            throw new Error(`${agentId} is not a member of this conversation`);
          const changed = conversations.setSteward(conversation.id, agentId)!;
          announceSteward(
            { agents, timeline },
            conversation.id,
            conversation.stewardId,
            changed.stewardId,
          );
          deps.changed([conversation.id]);
          return { result: { conversation: summary(changed) } };
        }),

        wire.handle("conversations", "send", async (call) => {
          const args = new Args(call);
          const mode = args.optionalString("mode") ?? "queue";
          if (mode !== "queue" && mode !== "steer")
            throw new Error("conversations.send: mode must be queue or steer");
          const result = await engine.send({
            conversationId: args.string("conversationId"),
            text: args.optionalString("text") ?? "",
            blocks: args.integerPairs("blocks"),
            mentions: args.strings("mentions"),
            mode,
            into: args.optionalString("into"),
            clientId: args.optionalString("clientId"),
            attachments: args.strings("attachments"),
          });
          return { result };
        }),

        wire.handle("conversations", "attach", async (call) => {
          const args = new Args(call);
          const id = args.string("conversationId");
          existing(id);
          const attachment = await deps.attachments.receive({
            owner: { conversationId: id },
            uploadId: args.string("uploadId"),
            name: args.string("name"),
            contentType:
              args.optionalString("contentType") || "application/octet-stream",
            index: args.integer("index"),
            last: args.optionalBoolean("last") ?? false,
            data: args.optionalString("data") ?? "",
          });
          return { result: { attachment } };
        }),

        wire.handle("conversations", "unattach", async (call) => {
          const args = new Args(call);
          const id = args.string("conversationId");
          existing(id);
          return {
            result: {
              removed: await deps.attachments.remove(
                { conversationId: id },
                args.string("attachmentId"),
              ),
            },
          };
        }),

        wire.handle("conversations", "attachment", async (call) => {
          const args = new Args(call);
          const id = args.string("conversationId");
          existing(id);
          return {
            result: await deps.attachments.picture(
              { conversationId: id },
              args.string("attachmentId"),
            ),
          };
        }),

        wire.handle("conversations", "resetContext", (call) => {
          const id = new Args(call).string("conversationId");
          existing(id);
          return { result: { cleared: engine.resetContext(id) } };
        }),

        wire.handle("conversations", "stop", (call) => {
          const args = new Args(call);
          const stopped = engine.stop(
            args.string("conversationId"),
            args.optionalString("messageId"),
          );
          return { result: { stopped } };
        }),

        wire.handle("conversations", "read", (call) => {
          const args = new Args(call);
          const conversation = conversations.markRead(
            args.string("conversationId"),
            args.integer("seq"),
          );
          if (conversation === undefined)
            throw new Error("no such conversation");
          deps.changed([conversation.id]);
          return { result: { conversation: summary(conversation) } };
        }),

        wire.handle("conversations", "history", (call) => {
          const args = new Args(call);
          const id = args.string("conversationId");
          existing(id);
          const limit = Math.max(
            1,
            Math.min(MAX_PAGE, args.optionalInteger("limit") ?? PAGE),
          );
          const page = timeline.page(
            id,
            args.optionalInteger("beforeSeq"),
            limit,
          );
          return { result: { conversationId: id, ...page } };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
        deps.targets.dispose();
        // The plugin is going: what is running is told to stop, and the dispose waits for it.
        return engine.detach();
      };
    },
    applied,
  );
}
