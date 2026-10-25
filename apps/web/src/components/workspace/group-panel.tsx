import type { ConversationSummary } from "@eta/client-contracts";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ROUTINES_VISIBLE } from "@/lib/features";
import { cn } from "@/lib/utils";
import { useArtifacts } from "@/queries/artifacts";
import { useConversation } from "@/queries/conversations";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";
import { ActivityRefCard } from "./activity-ref";
import { GroupMembers } from "./groups";
import { when } from "./routine-format";
import { useAttention } from "./use-attention";
import { useSectionLink } from "./workspace-search";

/**
 * 上下文: what this conversation is made of, for the panel beside it, ordered by
 * whether it is worth a look *now* — reading it top down should cost one glance,
 * not a scroll to find out whether anything needs the user.
 *
 * So: 等你 first (what waits for the user *in this conversation*, the same rows
 * the 待处理 tab counts, from the same hook — see `useAttention`; a second judge
 * here would disagree with the badge), then what the group made and what it is
 * on track to make (任务, 产物, 定时), then the background that is only news when
 * it changes (成员, 目标). A confirmation is not drawn again here — it is already
 * demanding an answer in the conversation — so its row is the way to the tab that
 * holds them, and its count keeps this section's total equal to the badge's.
 *
 * The members are the group's own component, the one the group manager uses,
 * because it already carries everything a member has (its session's numbers, the
 * per-member menu, invite, rename, archive) and a second list beside it was a
 * second thing to keep in sync. What this file adds is only what surrounds that.
 */

/** The one row shape this panel uses twice: what waits, and why it waits. */
const rowClass =
  "flex min-w-0 items-baseline gap-2 outline-none hover:underline focus-visible:underline";

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
  const attention = useAttention();
  const sectionLink = useSectionLink();
  if (group === undefined) return null;
  const tasks = board.filter((task) => task.conversationId === group.id);
  const groupRoutines = routines.filter(
    (routine) => routine.conversationId === group.id,
  );
  const groupArtifacts = artifacts.filter(
    (artifact) => artifact.conversationId === group.id,
  );
  // What waits, as the 待处理 tab sees it, kept to this conversation.
  const waitingTasks = attention.tasks.filter(
    ({ task }) => task.conversationId === group.id,
  );
  const waitingRoutines = attention.routines.filter(
    ({ routine }) => routine.conversationId === group.id,
  );
  const waitingIds = new Set(waitingTasks.map(({ task }) => task.id));
  // Nothing of this conversation to point at, and no confirmations to send them
  // to, and the section is not drawn at all: an empty「等你」would be the panel
  // spending a heading on "nothing to see".
  const holds =
    waitingTasks.length + waitingRoutines.length + attention.interactions > 0;
  // A task the user has to act on leads its own section too; the rest follow the
  // last move made on them.
  const listed = [...tasks].sort(
    (a, b) =>
      Number(waitingIds.has(b.id)) - Number(waitingIds.has(a.id)) ||
      b.updatedAt - a.updatedAt,
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="divide-y divide-border pb-2">
        {holds ? (
          <Section
            title={translateText("chat:context.awaitingYou")}
            count={attention.total}
          >
            <ul className="space-y-1">
              {waitingTasks.map(({ task, reason, alert }) => (
                <li key={task.id}>
                  <Link
                    {...sectionLink("tasks", { task: task.id })}
                    title={`#${task.number} ${task.title}`}
                    className={rowClass}
                  >
                    <WaitingRow
                      title={
                        <>
                          <span className="text-faint tabular-nums">
                            #{task.number}{" "}
                          </span>
                          {task.title}
                        </>
                      }
                      reason={reason}
                      alert={alert}
                    />
                  </Link>
                </li>
              ))}
              {waitingRoutines.map(({ routine, reason, alert }) => (
                <li key={routine.id}>
                  <Link
                    {...sectionLink("routines", { routine: routine.id })}
                    title={routine.name}
                    className={rowClass}
                  >
                    <WaitingRow
                      title={routine.name}
                      reason={reason}
                      alert={alert}
                    />
                  </Link>
                </li>
              ))}
              {attention.interactions === 0 ? null : (
                <li>
                  <Link
                    to="/"
                    search={{ group: group.id, view: "inbox" }}
                    className={rowClass}
                  >
                    <WaitingRow
                      title={translateText("chat:confirmations.requestLabel")}
                      count={attention.interactions}
                      reason={translateText("chat:context.openPending")}
                      alert={false}
                    />
                  </Link>
                </li>
              )}
            </ul>
          </Section>
        ) : null}

        <Section
          title={translateText("navigation:sections.tasks")}
          count={tasks.length}
        >
          {tasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translateText("tasks:empty.title")}
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

/** One thing that waits: what it is, and why. The reason is the 待处理 tab's own words. */
function WaitingRow({
  title,
  count,
  reason,
  alert,
}: {
  title: ReactNode;
  count?: number;
  reason: string;
  alert: boolean;
}) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-xs">
        {title}
        {count === undefined ? null : (
          <span className="ml-1 text-faint tabular-nums">{count}</span>
        )}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono text-[10px]",
          alert ? "text-destructive" : "text-faint",
        )}
      >
        {reason}
      </span>
    </>
  );
}
