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
import type { ProjectStore } from "../projects/store";
import type { AttachmentStore } from "./attachments";
import type { Engine } from "./engine";
import type { ConversationRecord, ConversationStore } from "./store";
import type { ConversationTargets } from "./targets";
import type { Timeline } from "./timeline";
import { Args, productPlugin, publish } from "../wire";
import { announceSteward } from "./steward";
import { effectiveSteward, summaryOf } from "./views";

export interface ConversationsDeps {
  agents: AgentStore;
  projects: ProjectStore;
  conversations: ConversationStore;
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
  const { agents, projects, conversations, timeline, engine } = deps;
  const views = { conversations, projects, timeline };

  const existing = (id: string): ConversationRecord => {
    const conversation = conversations.get(id);
    if (conversation === undefined)
      throw new Error(`no such conversation: ${id}`);
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
          { list: () => conversations.list().map(summary) },
          { eager: true },
        ),

        wire.handle("conversations", "create", (call) => {
          const args = new Args(call);
          const project = projects.get(args.string("projectId"));
          if (project === undefined) throw new Error("no such project");
          let members = [...new Set(args.strings("agentIds").map(agent))];
          // A conversation nobody is in would be an empty room: the project's steward is there.
          if (members.length === 0 && project.stewardId !== null)
            members = [project.stewardId];
          const given = args.optionalString("name")?.trim();
          const name =
            given === undefined || given === ""
              ? members
                  .map((id) => agents.get(id)?.name)
                  .filter((n) => n !== undefined)
                  .join(", ") || project.name
              : given;
          const conversation = conversations.create({
            projectId: project.id,
            kind: "group",
            name,
            agentIds: members,
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

        wire.handle("conversations", "update", (call) => {
          const args = new Args(call);
          const id = args.string("conversationId");
          existing(id);
          const name = args.optionalString("name")?.trim();
          if (name === "") throw new Error("a conversation needs a name");
          const conversation = conversations.update(id, {
            name,
            goal: args.optionalString("goal"),
            decided: args.optionalString("decided"),
            archived: args.optionalBoolean("archived"),
          })!;
          deps.changed([id]);
          return { result: { conversation: summary(conversation) } };
        }),

        wire.handle("conversations", "invite", (call) => {
          const args = new Args(call);
          const conversation = existing(args.string("conversationId"));
          if (conversation.kind === "direct")
            throw new Error("a private chat is the agent and the user");
          conversations.addParticipant(
            conversation.id,
            agent(args.string("agentId")),
          );
          deps.changed([conversation.id]);
          return { result: { conversation: summary(conversation) } };
        }),

        wire.handle("conversations", "remove", (call) => {
          const args = new Args(call);
          const conversation = existing(args.string("conversationId"));
          const agentId = args.string("agentId");
          if (conversation.kind === "direct")
            throw new Error("a private chat is the agent and the user");
          // What the member was answering stops with it; its session stays, as a record.
          engine.stopMember(conversation.id, agentId);
          conversations.removeParticipant(conversation.id, agentId);
          // A steward of this conversation's own that leaves it stops being one.
          if (conversation.stewardId === agentId)
            conversations.setSteward(conversation.id, null);
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
          if (agentId !== null) agent(agentId);
          const before = effectiveSteward(projects, conversation);
          const changed = conversations.setSteward(conversation.id, agentId)!;
          announceSteward(
            { agents, timeline },
            conversation.id,
            before,
            effectiveSteward(projects, changed),
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
            conversationId: id,
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
                id,
                args.string("attachmentId"),
              ),
            },
          };
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
