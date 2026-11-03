import type { ConversationSummary } from "@eta/client-contracts";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ROUTINES_VISIBLE } from "@/lib/features";
import { useArtifacts } from "@/queries/artifacts";
import { useConversation } from "@/queries/conversations";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";
import { ActivityRefCard } from "./activity-ref";
import { GroupMembers } from "./groups";
import { when } from "./routine-format";

/**
 * 上下文: what this conversation is made of, for the panel beside it, ordered by
 * whether it is worth a look *now* — reading it top down should cost one glance,
 * not a scroll to find out whether anything needs the user.
 *
 * So: what the group made and what it is on track to make first (任务, 产物,
 * 定时), then the background that is only news when it changes (成员, 目标).
 * What waits for the user is the 待处理 tab's, with its badge; it is not listed
 * again here.
 *
 * The members are the group's own component, the one the group manager uses,
 * because it already carries everything a member has (its session's numbers, the
 * per-member menu, invite, rename, archive) and a second list beside it was a
 * second thing to keep in sync. What this file adds is only what surrounds that.
 */

/** What 任务 leaves out: a closed task needs nothing more, and the 任务 tab still holds it. */
const closed = new Set<string>(["done", "cancelled"]);

export function GroupPanel({
  group,
}: {
  group: ConversationSummary | undefined;
}) {
  const { t: translateText } = useTranslation([
    "chat",
    "navigation",
    "artifacts",
    "routines",
    "tasks",
  ] as const);
  const { tasks: board } = useTasks();
  const { routines } = useRoutines();
  const { artifacts } = useArtifacts();
  const { info } = useConversation(group?.id);
  if (group === undefined) return null;
  const groupTasks = board.filter((task) => task.conversationId === group.id);
  const tasks = groupTasks.filter((task) => !closed.has(task.status));
  const groupRoutines = routines.filter(
    (routine) => routine.conversationId === group.id,
  );
  const groupArtifacts = artifacts.filter(
    (artifact) => artifact.conversationId === group.id,
  );
  // The last move made on them, latest first.
  const listed = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="divide-y divide-border pb-2">
        <Section
          title={translateText("navigation:sections.tasks")}
          count={tasks.length}
        >
          {tasks.length === 0 ? (
            // "No tasks yet" would be wrong once some have been closed here.
            <p className="text-xs text-muted-foreground">
              {translateText(
                groupTasks.length === 0
                  ? "tasks:empty.title"
                  : "tasks:empty.noOpen",
              )}
            </p>
          ) : (
            <ul className="space-y-1">
              {listed.slice(0, 5).map((task) => (
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
              ))}
            </ul>
          )}
        </Section>

        <Section
          title={translateText("navigation:sections.artifacts")}
          count={groupArtifacts.length}
        >
          {groupArtifacts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translateText("artifacts:empty.title")}
            </p>
          ) : (
            <ul className="space-y-1">
              {groupArtifacts.map((artifact) => (
                <li key={artifact.id}>
                  <ActivityRefCard
                    value={{
                      kind: "artifact",
                      id: artifact.id,
                      title: artifact.title,
                      number: artifact.versions[0]?.number ?? 0,
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>

        {ROUTINES_VISIBLE ? (
          <Section
            title={translateText("navigation:sections.routines")}
            count={groupRoutines.length}
          >
            {groupRoutines.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {translateText("routines:empty.title")}
              </p>
            ) : (
              <ul className="space-y-1">
                {groupRoutines.map((routine) => (
                  <li
                    key={routine.id}
                    className="flex min-w-0 items-baseline gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {routine.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-faint tabular-nums">
                      {routine.nextRunAt === null
                        ? "—"
                        : when(routine.nextRunAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ) : null}

        <div className="px-3 py-2">
          <GroupMembers />
        </div>

        {/* The one fact the header cannot hold. The name, the folder and the unread count are
            already on screen above; repeating them here is three things to read twice. */}
        {info === undefined || info.goal.length === 0 ? null : (
          <Section title={translateText("chat:groups.fields.goal")}>
            <p className="text-sm leading-[1.65] text-foreground">
              {info.goal}
            </p>
          </Section>
        )}
      </div>
    </div>
  );
}

/** A section's heading carries its name and how many, as every block here does. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="px-3 py-2">
      <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {title}
        {count === undefined ? null : (
          <span className="ml-1 tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}
