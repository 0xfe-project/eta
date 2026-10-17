import type { Group } from "@/queries/chat";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { groupCwd } from "@/lib/group-cwd";
import { cn } from "@/lib/utils";
import { useArtifacts } from "@/queries/artifacts";
import { chatQueryOptions, useGoal, useSetGoal } from "@/queries/chat";
import { useGroupActions } from "@/queries/groups";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";
import { ActivityRefCard } from "./activity-ref";
import { AgentAvatar, AgentStatusDot } from "./agent-identity";
import { GroupMembers } from "./groups";
import { when } from "./routine-format";
import { useAgents } from "./use-agents";

/**
 * The right column's contents: the group, then everything the group is made of.
 *
 * One column, no tabs. The old panel put 成员 behind one tab and Artifacts behind another, which
 * meant half the state was always hidden and a person had to remember which half. Here the group's
 * blocks are stacked in the order they are asked about — what this is, who is in it, what is
 * waiting, what runs on a schedule, what it produced — and every member gets its own block at the
 * same time as every other. Nothing is behind a click.
 *
 * The numbers come from the session behind each member (`GET /sessions/{id}/usage|tools`). Where
 * there is no session yet the block says so instead of showing zeros: "nobody has spoken to this
 * agent here" and "it has spent nothing" are different facts.
 */

interface Participant {
  agent_id: string;
  name: string;
  member: boolean;
  status: string;
  session_id?: string | null;
}

const section = "border-t px-3 py-2";
const heading =
  "mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase";

function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function GroupPanel({
  group,
  onFocusMember,
}: {
  group: Group | undefined;
  /** Pressing a member scrolls to its block; the chat narrows to it. */
  onFocusMember?: (agentId: string) => void;
}) {
  const { t: translateText } = useTranslation([
    "chat",
    "common",
    "navigation",
    "tasks",
    "routines",
    "artifacts",
  ] as const);
  const { data: snapshot } = useQuery(chatQueryOptions());
  const { agents } = useAgents();
  const { data: board } = useTasks();
  const { data: routines } = useRoutines();
  const { data: artifacts } = useArtifacts();
  const [editing, setEditing] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const focusMember = (agentId: string) => {
    setFocused((current) => (current === agentId ? null : agentId));
    // The block comes to you; the column does not reorder itself to prove it moved.
    document
      .getElementById(`member-${agentId}`)
      ?.scrollIntoView({ block: "nearest" });
    onFocusMember?.(agentId);
  };
  if (group === undefined) return null;
  const members = (group.participants as Participant[]).filter((p) => p.member);
  const active = new Set(
    (snapshot?.active_replies ?? [])
      .filter((reply: { status: string }) =>
        ["responding", "waiting_for_input", "stopping"].includes(reply.status),
      )
      .map((reply: { agent_id: string | null }) => reply.agent_id),
  );
  const tasks =
    board?.tasks.filter(
      (task: { group_id?: string | null }) => task.group_id === group.id,
    ) ?? [];
  const groupRoutines = (routines ?? []).filter(
    (routine: { group_id?: string | null }) => routine.group_id === group.id,
  );
  const groupArtifacts =
    artifacts?.artifacts.filter(
      (artifact: { group_id?: string | null }) =>
        artifact.group_id === group.id,
    ) ?? [];
  const cwd = groupCwd(group);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* The group itself: the three facts that answer "what am I looking at". */}
      <section className="px-3 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <h2
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={group.name}
          >
            {group.name}
          </h2>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={translateText("chat:groups.accessibility.actions")}
            onClick={() => setEditing(true)}
          >
            <DotsThreeIcon aria-hidden="true" />
          </Button>
        </div>
        <p
          className={cn(
            "mt-0.5 truncate font-mono text-[11px]",
            cwd.length === 0 ? "text-faint" : "text-muted-foreground",
          )}
          title={cwd || translateText("chat:groups.header.cwdUnbound")}
        >
          {cwd || translateText("chat:groups.header.cwdUnbound")}
        </p>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground tabular-nums">
          {translateText("chat:groups.members.count", {
            count: members.length,
          })}
          {group.unread > 0 ? ` · ${group.unread} 未读` : ""}
        </p>
        {group.goal.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{group.goal}</p>
        ) : null}
      </section>

      {/* The group's own management (rename, goal, invite, link a task, archive) stays in the
          component that already did it; the panel is where you *look* at a group, and folding that
          form into every block would make looking expensive. */}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {translateText("chat:groups.actions.editInfo")}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto p-1">
            <GroupMembers />
          </div>
        </DialogContent>
      </Dialog>

      <section
        className={section}
        aria-label={String(translateText("chat:groups.members.title"))}
      >
        <h3 className={heading}>
          {translateText("chat:groups.members.title")}
        </h3>
        <ul className="space-y-1.5">
          {members.map((member) => (
            <MemberBlock
              key={member.agent_id}
              focused={focused === member.agent_id}
              dense={members.length > 6}
              member={member}
              name={
                agents.find(
                  (agent: { id: string; name: string }) =>
                    agent.id === member.agent_id,
                )?.name ?? member.name
              }
              model={
                agents.find(
                  (agent: { id: string; model?: string | null }) =>
                    agent.id === member.agent_id,
                )?.model ?? null
              }
              answering={active.has(member.agent_id)}
              tasks={
                tasks.filter(
                  (task: {
                    created_by?: { agent_id?: string | null } | null;
                  }) => task.created_by?.agent_id === member.agent_id,
                ).length
              }
              removable={group.kind === "group" && members.length > 1}
              groupId={group.id}
              onFocus={() => focusMember(member.agent_id)}
            />
          ))}
        </ul>
      </section>

      <section
        className={section}
        aria-label={String(translateText("navigation:sections.tasks"))}
      >
        <h3 className={heading}>
          {translateText("navigation:sections.tasks")}
          <span className="ml-1 tabular-nums">{tasks.length}</span>
        </h3>
        {tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translateText("tasks:empty.title")}
          </p>
        ) : (
          <ul className="space-y-1">
            {tasks
              .slice(0, 5)
              .map(
                (task: {
                  id: string;
                  number: number;
                  title: string;
                  status: string;
                }) => (
                  <li key={task.id}>
                    <ActivityRefCard
                      value={{
                        kind: "task",
                        id: task.id,
                        number: task.number,
                        title: task.title,
                        status: task.status,
                      }}
                    />
                  </li>
                ),
              )}
          </ul>
        )}
      </section>

      <section
        className={section}
        aria-label={String(translateText("navigation:sections.routines"))}
      >
        <h3 className={heading}>
          {translateText("navigation:sections.routines")}
          <span className="ml-1 tabular-nums">{groupRoutines.length}</span>
        </h3>
        {groupRoutines.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translateText("routines:empty.title")}
          </p>
        ) : (
          <ul className="space-y-1">
            {groupRoutines.map(
              (routine: {
                id: string;
                name: string;
                next_run_at?: string | null;
              }) => (
                <li
                  key={routine.id}
                  className="flex min-w-0 items-baseline gap-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {routine.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-faint">
                    {routine.next_run_at === undefined ||
                    routine.next_run_at === null
                      ? "—"
                      : when(routine.next_run_at)}
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <section
        className={cn(section, "pb-4")}
        aria-label={String(translateText("artifacts:empty.title"))}
      >
        <h3 className={heading}>
          {translateText("artifacts:empty.title")}
          <span className="ml-1 tabular-nums">{groupArtifacts.length}</span>
        </h3>
        {groupArtifacts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translateText("artifacts:empty.title")}
          </p>
        ) : (
          <ul className="space-y-1">
            {groupArtifacts.map(
              (artifact: { id: string; title: string; version: number }) => (
                <li key={artifact.id}>
                  <ActivityRefCard
                    value={{
                      kind: "artifact",
                      id: artifact.id,
                      title: artifact.title,
                      number: artifact.version,
                    }}
                  />
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * One member, in three lines.
 *
 * Model, what it has spent, how full its context is, the goal it is chasing, and how many tools it
 * can call — the numbers the session knows about itself. They are read from the session, so a
 * member that has never been woken says "no conversation yet" rather than drawing zeros.
 */
function MemberBlock({
  member,
  name,
  model,
  answering,
  tasks,
  removable,
  focused,
  dense,
  groupId,
  onFocus,
}: {
  member: Participant;
  name: string;
  model: string | null;
  answering: boolean;
  tasks: number;
  /** A group keeps at least one member, and a direct chat is not a group you edit. */
  removable: boolean;
  /** This is the member the chat is narrowed to. */
  focused: boolean;
  /** More than six members: two lines each, the rest folded into the block. */
  dense: boolean;
  groupId: string;
  onFocus: () => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const sessionId = member.session_id ?? undefined;
  const { data: usage } = useQuery({
    queryKey: ["session-usage", sessionId],
    enabled: sessionId !== undefined,
    staleTime: 10_000,
    queryFn: async () => {
      const response = await fetch(`/sessions/${sessionId}/usage`);
      return response.ok
        ? ((await response.json()) as {
            input: number;
            output: number;
            cache_read: number;
            cache_write: number;
            turns: number;
            model: string | null;
          })
        : null;
    },
  });
  const { data: tools } = useQuery({
    queryKey: ["session-tools", sessionId],
    enabled: sessionId !== undefined,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await fetch(`/sessions/${sessionId}/tools`);
      return response.ok
        ? ((await response.json()) as {
            tools: string[];
            refused: number;
          })
        : null;
    },
  });
  const { data: goal } = useGoal(sessionId);
  const setGoal = useSetGoal();
  const { member: membership } = useGroupActions();

  const [confirming, setConfirming] = useState(false);
  return (
    <li
      id={`member-${member.agent_id}`}
      className={cn(
        "border px-2 py-1.5",
        // Focused is a frame around the block, not a different block: the numbers stay where they
        // were, so comparing two members does not mean re-learning the layout.
        focused ? "border-foreground" : "border-border",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onFocus}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={translateText("chat:groups.members.focus", { name })}
        >
          <AgentAvatar
            agent={{ id: member.agent_id }}
            className="size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {name}
          </span>
          <AgentStatusDot status={(answering ? "working" : "idle") as never} />
        </button>
        {removable ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={translateText("common:accessibility.itemActions", {
                  name,
                })}
                title={name}
              >
                <DotsThreeIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setConfirming(true)}>
                {translateText("chat:groups.members.remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <dl
        className={cn(
          "mt-1 grid grid-cols-2 gap-x-2 font-mono text-[10px] text-muted-foreground tabular-nums",
          dense && "hidden",
        )}
      >
        <div className="col-span-2 flex min-w-0 gap-1">
          <dt className="sr-only">model</dt>
          <dd className="truncate" title={model ?? undefined}>
            {model ?? usage?.model ?? "—"}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>in</dt>
          <dd>
            {usage === undefined || usage === null ? "—" : tokens(usage.input)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>out</dt>
          <dd>
            {usage === undefined || usage === null ? "—" : tokens(usage.output)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>cache</dt>
          <dd>
            {usage === undefined || usage === null
              ? "—"
              : tokens(usage.cache_read + usage.cache_write)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>tools</dt>
          <dd>
            {tools === undefined || tools === null
              ? "—"
              : `${tools.tools.length}${tools.refused > 0 ? ` · ${tools.refused} 被拦` : ""}`}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>tasks</dt>
          <dd>{tasks}</dd>
        </div>
        <div className="flex gap-1">
          <dt>turns</dt>
          <dd>{usage?.turns ?? "—"}</dd>
        </div>
      </dl>
      {dense ? (
        <p className="mt-0.5 flex gap-2 font-mono text-[10px] text-muted-foreground tabular-nums">
          <span className="min-w-0 flex-1 truncate" title={model ?? undefined}>
            {model ?? usage?.model ?? "—"}
          </span>
          <span>
            in{" "}
            {usage === undefined || usage === null ? "—" : tokens(usage.input)}
          </span>
          <span>
            out{" "}
            {usage === undefined || usage === null ? "—" : tokens(usage.output)}
          </span>
        </p>
      ) : null}
      {dense ? (
        <p className="mt-0.5 flex gap-2 font-mono text-[10px] text-muted-foreground tabular-nums">
          <span className="min-w-0 flex-1 truncate" title={model ?? undefined}>
            {model ?? usage?.model ?? "—"}
          </span>
          <span>
            in{" "}
            {usage === undefined || usage === null ? "—" : tokens(usage.input)}
          </span>
          <span>
            out{" "}
            {usage === undefined || usage === null ? "—" : tokens(usage.output)}
          </span>
        </p>
      ) : null}
      {sessionId === undefined ? (
        <p className="mt-1 text-[10px] text-faint">
          {translateText("chat:groups.members.noSession")}
        </p>
      ) : dense ? null : (
        <LongContent sessionId={sessionId} />
      )}
      {goal !== undefined && goal !== null ? (
        <div className="mt-1 flex items-center gap-1 text-[10px]">
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              goal.status === "active"
                ? "text-state-success"
                : "text-muted-foreground",
            )}
            title={goal.objective}
          >
            {goal.objective}
          </span>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() =>
              void setGoal.mutateAsync({
                sessionId,
                action: goal.status === "active" ? "pause" : "resume",
              })
            }
          >
            {goal.status === "active"
              ? translateText("common:actions.pause")
              : translateText("common:actions.resume")}
          </button>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() =>
              void setGoal.mutateAsync({ sessionId, action: "clear" })
            }
          >
            {translateText("common:actions.delete")}
          </button>
        </div>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("chat:groups.members.remove")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("chat:groups.members.removeDescription", { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                membership.mutate({
                  groupId,
                  agentId: member.agent_id,
                  member: false,
                });
              }}
            >
              {translateText("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/**
 * The three long things, as numbers until you ask for the text.
 *
 * A system prompt is thousands of characters and a tool list is a list; neither belongs open in a
 * panel whose job is to be scanned. What fits on a line is the fact that makes them worth opening:
 * how much of the prompt a provider can cache against how much is rewritten every generation, how
 * many tools the model is actually offered, whether the conversation has been compacted.
 *
 * They open **in place** — a `<details>`, not a modal. The panel does not move, the block does not
 * jump, and closing it puts you back exactly where you were reading.
 */
function LongContent({ sessionId }: { sessionId: string }) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const { data: prompt } = useQuery({
    queryKey: ["session-prompt", sessionId],
    staleTime: 30_000,
    queryFn: async () => {
      const response = await fetch(`/sessions/${sessionId}/prompt`);
      return response.ok
        ? ((await response.json()) as {
            sections: {
              name: string;
              stable: boolean;
              chars: number;
              text: string;
            }[];
            stable_chars: number;
            adaptive_chars: number;
            blocks: number;
          })
        : null;
    },
  });
  return (
    <details className="mt-1 text-[10px] text-muted-foreground [&_summary]:outline-none">
      <summary className="cursor-pointer font-mono tabular-nums">
        {prompt === undefined || prompt === null
          ? "prompt · —"
          : `stable ${tokens(prompt.stable_chars)} / adaptive ${tokens(prompt.adaptive_chars)} · ${prompt.blocks} blocks`}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {(prompt?.sections ?? []).map((section) => (
          <li key={section.name} className="flex gap-2">
            <span className="min-w-0 flex-1 truncate font-mono">
              {section.name}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-faint">
              {section.stable ? "stable" : "adaptive"} · {tokens(section.chars)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-faint">
        {translateText("chat:panel.sessionJson", {
          size: tokens(JSON.stringify(prompt ?? {}).length),
        })}
      </p>
    </details>
  );
}
