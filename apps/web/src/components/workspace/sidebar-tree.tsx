import type { Group } from "@/queries/chat";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { folderSections, matchesQuery } from "@/lib/folder-sections";
import { groupCwd } from "@/lib/group-cwd";
import { cn } from "@/lib/utils";
import { chatQueryOptions } from "@/queries/chat";
import { useGroupActions } from "@/queries/groups";
import { AgentAvatar } from "./agent-identity";
import { useGroups, useOpenGroup } from "./use-groups";
import { useWorkspaceStore } from "./workspace-store";

/** "3m" / "5h" / "1d": the age of a conversation, at a glance. */
function humanizeAge(at: string | null): string {
  if (at === null) return "";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(at).getTime()) / 60_000),
  );
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

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
  const navigate = useNavigate();
  const setFocusedAgent = useWorkspaceStore((state) => state.setFocusedAgent);
  const focusedAgentId = useWorkspaceStore((state) => state.focusedAgentId);
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
          {/* The folder's own row: its name, and the one action that belongs to a folder rather
              than to a conversation in it — starting another one there. */}
          <div className="flex h-6 items-center gap-1 px-2">
            <h3
              className="min-w-0 flex-1 truncate font-mono text-[10px] tracking-[0.12em] text-faint uppercase"
              title={
                section.path || translateText("chat:groups.header.cwdUnbound")
              }
            >
              {section.unbound
                ? translateText("chat:groups.header.cwdUnbound")
                : section.label}
            </h3>
            <button
              type="button"
              aria-label={translateText("chat:new.title")}
              title={translateText("chat:new.title")}
              onClick={() =>
                void navigate({ to: "/new", search: { cwd: section.path } })
              }
              className="shrink-0 px-1 text-xs leading-none text-faint hover:text-foreground"
            >
              +
            </button>
          </div>
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
                // A member listed under a group is a member *of that group*: pressing it narrows
                // the conversation to it, the same action as its card in the panel. Opening a
                // separate private chat is what the agent library is for.
                // Press to focus, press again to let go — the same toggle as the panel's card.
                onOpenAgent={(agentId) => {
                  setFocusedAgent(focusedAgentId === agentId ? null : agentId);
                  open(group.id);
                }}
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
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { update, remove } = useGroupActions();
  const [draft, setDraft] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const cwd = groupCwd(group);
  const commitRename = () => {
    const next = (draft ?? "").trim();
    setDraft(null);
    if (next.length === 0 || next === group.name) return;
    update.mutate({ id: group.id, name: next });
  };
  const members: Participant[] = group.participants.filter(
    (participant: Participant) => participant.member,
  );
  const expandable = group.kind === "group" && members.length > 0;
  const busy = (working?.size ?? 0) > 0;

  return (
    <li>
      {/*
       * eta-old's session row: the title on top with its age at the right and a `⋯` beside it, the
       * id under it, the folder under that. Three lines because they answer three questions in the
       * order you ask them — what is this, which one is it, where does it work — and the border
       * appears only for the row you are in.
       */}
      <div
        className={cn(
          "group mb-1 border p-2",
          active
            ? "border-border-strong bg-sidebar-accent"
            : "border-transparent hover:bg-sidebar-accent",
        )}
      >
        <div className="flex items-center gap-1">
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
              className="shrink-0 text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <CaretRightIcon
                aria-hidden="true"
                className={cn("size-3", expanded && "rotate-90")}
              />
            </button>
          ) : null}
          <MemberStack members={members} />
          {draft === null ? (
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 flex-1 truncate text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              title={group.name}
            >
              {group.name}
            </button>
          ) : (
            <RenameField
              value={draft}
              onChange={setDraft}
              onCommit={commitRename}
              onCancel={() => setDraft(null)}
            />
          )}
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
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            {humanizeAge(group.last_message_at ?? group.updated_at)}
          </span>
          <RowMenu
            onRename={() => setDraft(group.name)}
            archived={group.archived === true}
            onArchive={() =>
              update.mutate({ id: group.id, archived: !group.archived })
            }
            onDelete={() => setDeleting(true)}
          />
        </div>
        <p className="truncate font-mono text-[10px] text-muted-foreground">
          {group.id.slice(0, 11)}
        </p>
        {cwd.length === 0 ? null : (
          <p className="truncate font-mono text-[10px] text-faint" title={cwd}>
            {cwd}
          </p>
        )}
      </div>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translateText("chat:groups.delete.title")}
            </DialogTitle>
            <DialogDescription>
              {translateText("chat:groups.delete.description", {
                name: group.name,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(false)}>
              {translateText("common:actions.cancel")}
            </Button>
            <Button
              className="text-state-error"
              onClick={() => {
                setDeleting(false);
                remove.mutate(group.id);
              }}
            >
              {translateText("common:actions.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

/**
 * Renaming in place: the title becomes a field, Enter or losing focus commits, Escape gives up.
 *
 * In place because a dialog for three words is a dialog you stop using; losing focus commits
 * because that is what "clicked away" means when the thing you were editing is a name.
 */
function RenameField({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const cancelled = useRef(false);
  return (
    <Input
      autoFocus
      value={value}
      maxLength={100}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => {
        if (cancelled.current) return;
        onCommit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
      className="h-6 min-w-0 flex-1 px-1 py-0 text-sm"
    />
  );
}

/** The row's `⋯`: rename, archive (or bring back), delete. Delete is the one in red. */
function RowMenu({
  onRename,
  archived,
  onArchive,
  onDelete,
}: {
  onRename: () => void;
  archived: boolean;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={translateText("chat:groups.accessibility.actions")}
          className="shrink-0 border border-transparent px-1 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
        >
          ⋯
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuItem onSelect={onRename}>
          {translateText("chat:groups.actions.rename")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onArchive}>
          {archived
            ? translateText("chat:groups.actions.unarchive")
            : translateText("chat:groups.actions.archive")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onDelete}
          className="text-state-error focus:text-state-error"
        >
          {translateText("common:actions.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Who is in this conversation, as a stack.
 *
 * Three avatars and a count: enough to recognise the room at a glance, and `+2` is the honest way
 * to say there are more rather than a fourth face that is not really the fourth. A one-member
 * conversation gets its single avatar, which is the same thing with nothing to overlap.
 */
function MemberStack({ members }: { members: Participant[] }) {
  const shown = members.slice(0, 3);
  const rest = members.length - shown.length;
  if (members.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      <span className="flex -space-x-1.5">
        {shown.map((member) => (
          <span
            key={member.agent_id}
            className="size-5 overflow-hidden border border-background bg-background"
          >
            <AgentAvatar
              agent={{ id: member.agent_id }}
              className="size-full"
            />
          </span>
        ))}
      </span>
      {rest > 0 ? (
        <span className="ml-1 shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
