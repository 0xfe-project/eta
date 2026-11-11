// 02, 02a, 03p, 03p2: the rows the design draws, and what a long press and Unarchive call.

import type {
  ConversationArgs,
  ConversationInfo,
  ConversationSummary,
} from "@eta/client-contracts";
import type { FakeHost } from "../fake-host";
import { minutesAgo } from "./base";

const member = (
  agentId: string,
  status: ConversationSummary["participants"][number]["status"],
) => ({
  agentId,
  sessionId: `session-${agentId}`,
  lastSeq: 10,
  status,
});

const row = (
  id: string,
  name: string,
  projectId: string,
  kind: ConversationSummary["kind"],
  participants: ConversationSummary["participants"],
  fields: Partial<ConversationSummary>,
): ConversationSummary => ({
  id,
  projectId,
  kind,
  name,
  archived: false,
  stewardId: participants[0]?.agentId ?? null,
  participants,
  lastSeq: 10,
  readSeq: 10,
  unread: 0,
  preview: "",
  lastMessageAt: minutesAgo(3),
  createdAt: minutesAgo(90_000),
  updatedAt: minutesAgo(3),
  ...fields,
});

const EXTRA: ConversationSummary[] = [
  row(
    "dm-ache",
    "Ache",
    "home-agent-ache",
    "direct",
    [member("agent-ache", "working")],
    {
      lastMessageAt: minutesAgo(2),
    },
  ),
  row(
    "dm-mori",
    "Mori",
    "home-agent-mori",
    "direct",
    [member("agent-mori", "idle")],
    {
      preview: "The column-width plan is ready, take a look.",
      lastMessageAt: minutesAgo(1500),
    },
  ),
  row(
    "release",
    "Release process",
    "eta",
    "group",
    [member("agent-ache", "idle")],
    {
      archived: true,
      updatedAt: new Date(new Date().getFullYear(), 9, 2).getTime(),
    },
  ),
  row(
    "landing",
    "Landing page copy",
    "site",
    "group",
    [member("agent-mori", "idle")],
    {
      archived: true,
      updatedAt: new Date(new Date().getFullYear(), 8, 18).getTime(),
    },
  ),
];

/** `●` alone is one unread row: the design's dot without a number. */
const UNREAD: Record<string, number> = { board: 1, redesign: 1 };

export function installConversations(host: FakeHost): void {
  const list = () =>
    host.section<ConversationSummary[]>("conversations", "list");
  if (host.scenario === "empty") host.patch("conversations", "list", []);
  else if (host.scenario !== "uninitialized")
    host.patch("conversations", "list", [
      ...list().map((each) => ({
        ...each,
        unread: UNREAD[each.id] ?? each.unread,
      })),
      ...EXTRA,
    ]);

  host.on("conversations.update", (args: ConversationArgs["update"]) => {
    const found = list().find((each) => each.id === args.conversationId);
    if (found === undefined) throw new Error("no such conversation");
    const name = args.name?.trim();
    if (name === "") throw new Error("a conversation needs a name");
    const conversation: ConversationSummary = {
      ...found,
      name: name ?? found.name,
      archived: args.archived ?? found.archived,
      updatedAt: Date.now(),
    };
    host.patch(
      "conversations",
      "list",
      list().map((each) => (each.id === found.id ? conversation : each)),
    );
    const target = `conversations.${found.id}`;
    const info = host.section<ConversationInfo | undefined>(target, "info");
    if (info !== undefined)
      host.patch(target, "info", {
        ...info,
        name: conversation.name,
        goal: args.goal ?? info.goal,
        decided: args.decided ?? info.decided,
        archived: conversation.archived,
        updatedAt: conversation.updatedAt,
      });
    return { conversation };
  });
}
