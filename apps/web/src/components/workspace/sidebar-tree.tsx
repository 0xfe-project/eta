import type { Group } from "@/queries/chat";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { folderSections, matchesQuery } from "@/lib/folder-sections";
import { cn } from "@/lib/utils";
import { chatQueryOptions } from "@/queries/chat";
import { AgentAvatar } from "./agent-identity";
import { useOpenAgent } from "./use-agents";
import { useGroups, useOpenGroup } from "./use-groups";

/**
 * The sidebar tree: folders, the conversations in them, and who is in each one.
 *
 * Three levels, each one a fact rather than a container: the folder is where the work happens,
 * the conversation is what is being discussed, the member is a person you can talk to alone.
 * A member row opens that agent's own chat — the same row means the same thing everywhere, and
 * the agent's private conversation is created the first time it is asked for.
 *
 * A conversation with one member (a direct chat) has no members to expand: its name *is* the
 * agent, and a second row underneath saying the same thing would be a row that says nothing.
 */

/** The parts of a group this tree reads. The web's `Group` type is still the old control plane's,
 * which is missing entirely today; naming what we use keeps the cast in one place. */
interface Participant {
  agent_id: string;
  name: string;
  member: boolean;
}

const row =
  "group flex min-h-8 w-full min-w-0 items-center gap-1.5 px-2 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function FolderTree({ query = "" }: { query?: string }) {
  const { t: translateText } = useTranslation(["chat", "navigation"] as const);
  const { groups, current } = useGroups();
  const open = useOpenGroup();
  const openAgent = useOpenAgent();
  const { data } = useQuery(chatQueryOptions());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Who is answering right now, by conversation: the sidebar says so without opening anything.
  const working = useMemo(() => {
    const byGroup = new Map<string, Set<string>>();
    for (const reply of data?.active_replies ?? []) {
      if (
        !["responding", "waiting_for_input", "stopping"].includes(reply.status)
      )
        continue;
      const agents = byGroup.get(reply.group_id) ?? new Set<string>();
      if (reply.agent_id !== null) agents.add(reply.agent_id);
      byGroup.set(reply.group_id, agents);
    }
    return byGroup;
  }, [data]);

  const sections = folderSections(
    groups.filter((group) => !group.archived && matchesQuery(group, query)),
  );

  if (sections.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {query.trim().length > 0
          ? translateText("chat:groups.search.empty")
          : translateText("chat:groups.empty.title")}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-1 pb-2">
      {sections.map((section) => (
        <section key={section.path || "unbound"} aria-label={section.label}>
          <h3
            className="flex h-6 items-center gap-1 px-2 font-mono text-[10px] tracking-[0.12em] text-faint uppercase"
            title={
              section.path || translateText("chat:groups.header.cwdUnbound")
            }
          >
            <span className="min-w-0 truncate">
              {section.unbound
                ? translateText("chat:groups.header.cwdUnbound")
                : section.label}
            </span>
          </h3>
          <ul>
            {section.groups.map((group) => (
              <GroupRow
                key={group.id}
                group={group}
                active={current?.id === group.id}
                working={working.get(group.id)}
                expanded={expanded[group.id] === true}
                onToggle={() =>
                  setExpanded((state) => ({
                    ...state,
                    [group.id]: !state[group.id],
                  }))
                }
                onOpen={() => open(group.id)}
                onOpenAgent={(agentId) => openAgent(agentId, section.path)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function GroupRow({
  group,
  active,
  working,
  expanded,
  onToggle,
  onOpen,
  onOpenAgent,
}: {
  group: Group;
  active: boolean;
  working: Set<string> | undefined;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const members: Participant[] = group.participants.filter(
    (participant: Participant) => participant.member,
  );
  const expandable = group.kind === "group" && members.length > 0;
  const busy = (working?.size ?? 0) > 0;

  return (
    <li>
      <div
        className={cn(
          "flex items-stretch",
          active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent",
        )}
      >
        {expandable ? (
          <button
            type="button"
            aria-label={
              expanded
                ? translateText("chat:groups.members.collapse")
                : translateText("chat:groups.members.expand")
            }
            aria-expanded={expanded}
            onClick={onToggle}
            className="flex w-5 shrink-0 items-center justify-center text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <CaretRightIcon
              aria-hidden="true"
              className={cn("size-3", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={onOpen}
          className={cn(row, "min-w-0 flex-1 px-0 pr-2")}
          title={group.name}
        >
          {group.kind === "direct" ? (
            <AgentAvatar
              agent={{ id: members[0]?.agent_id ?? group.id }}
              className="size-4 shrink-0"
            />
          ) : null}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              active && "font-medium text-foreground",
            )}
          >
            {group.name}
          </span>
          {/* Who is talking, and how much is unread: two different facts, two different marks. */}
          {busy ? (
            <span
              className="shrink-0 font-mono text-[10px] text-state-success"
              title={[...(working ?? [])]
                .map(
                  (id) =>
                    members.find((member) => member.agent_id === id)?.name ??
                    id,
                )
                .join("、")}
            >
              ●
            </span>
          ) : null}
          {group.unread > 0 ? (
            <span className="shrink-0 font-mono text-[10px] text-foreground tabular-nums">
              {group.unread}
            </span>
          ) : null}
        </button>
      </div>
      {expandable && expanded ? (
        <ul className="mb-0.5 ml-5 border-l border-border">
          {members.map((member: Participant) => (
            <li key={member.agent_id}>
              <button
                type="button"
                onClick={() => onOpenAgent(member.agent_id)}
                title={translateText("chat:groups.members.talkAlone", {
                  name: member.name,
                })}
                className={cn(
                  row,
                  "text-muted-foreground hover:text-foreground",
                )}
              >
                <AgentAvatar
                  agent={{ id: member.agent_id }}
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                {working?.has(member.agent_id) ? (
                  <span className="shrink-0 font-mono text-[10px] text-state-success">
                    ●
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export type { Group };
