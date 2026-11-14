import type { ConversationSummary } from "@eta/client-contracts";
import { runningFirst } from "@eta/client-contracts";
import { useTranslation } from "react-i18next";
import { ROUTINES_VISIBLE } from "@/lib/features";
import { useArtifacts } from "@/queries/artifacts";
import { useCaptain } from "@/queries/captain";
import { useConversation } from "@/queries/conversations";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";
import { ActivityRefCard } from "./activity-ref";
import { CaptainModel, CaptainOperations } from "./captain-operations";
import { GroupMembers } from "./groups";
import { Section } from "./panel-section";
import { when } from "./routine-format";

/**
 * Context: what this conversation is made of, for the panel beside it, ordered by
 * whether it is worth a look *now* — reading it top down should cost one glance,
 * not a scroll to find out whether anything needs the user.
 *
 * So: what the group made and what it is on track to make first (tasks, artifacts,
 * routines), then the background that is only news when it changes (members, goals).
 *
 * Captain's own conversation is the one exception: its first block is Operations rather than tasks —
 * the approvals, alerts and assignments it holds for everyone else — because "which tasks is
 * Captain working on" is not a question about Captain, it is a question about the agents it is
 * assigning them to. See captain-operations.tsx.
 * What waits for the user belongs to the Pending tab, with its badge; it is not listed
 * again here.
 *
 * The members are the group's own component, the one the group manager uses,
 * because it already carries everything a member has (its session's numbers, the
 * per-member menu, invite, rename, archive) and a second list beside it was a
 * second thing to keep in sync. What this file adds is only what surrounds that.
 */

/** What tasks leave out: a closed task needs nothing more, and the task tab still holds it. */
const closed = new Set<string>(["done", "cancelled"]);

/**
 * Tasks and artifacts as rows, edge to edge: the rule between two runs into the panel's own edges. One
 * height for both, a few rows on a normal window and less on a short one, so that members under them
 * stays in reach; a short list just ends. `overscroll-y-auto` undoes the panes' global
 * `overscroll-behavior: none`, or a list at its end, or with nothing to scroll, would keep the
 * wheel and the finger from the panel around it.
 */
const listClass =
  "-mx-3 max-h-[min(12rem,25dvh)] divide-y divide-border overflow-y-auto overscroll-y-auto";

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
  const captain = useCaptain();
  if (group === undefined) return null;
  // Captain's conversation is a conversation, so this panel is its panel too — but what it is
  // working on is not a list of tasks of its own: it is the operations it is running for everyone
  // else. Tasks give way to Operations here, and nowhere else.
  const isCaptain = captain.identity?.conversationId === group.id;
  const groupTasks = board.filter((task) => task.conversationId === group.id);
  const tasks = groupTasks.filter((task) => !closed.has(task.status));
  const groupRoutines = routines.filter(
    (routine) => routine.conversationId === group.id,
  );
  const groupArtifacts = artifacts.filter(
    (artifact) => artifact.conversationId === group.id,
  );
  // The last move made on them, latest first; within a status, a task that runs comes before one
  // that waits in the queue however recently that one moved.
  const listed = runningFirst(
    [...tasks].sort((a, b) => b.updatedAt - a.updatedAt),
  );

  return (
    // `WorkspacePanel` scrolls this. No scroll container of its own: one with nothing to scroll,
    // under `overscroll-behavior: none`, stops every wheel and touch that starts inside it.
    <div className="divide-y divide-border pb-2">
      {isCaptain ? (
        <>
          <CaptainModel key={captain.identity?.model ?? ""} />
          <CaptainOperations />
        </>
      ) : (
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
            <ul className={listClass}>
              {listed.map((task) => (
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
      )}

      <Section
        title={translateText("navigation:sections.artifacts")}
        count={groupArtifacts.length}
      >
        {groupArtifacts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translateText("artifacts:empty.title")}
          </p>
        ) : (
          <ul className={listClass}>
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
                    {routine.nextRunAt === null ? "—" : when(routine.nextRunAt)}
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
          <p className="text-sm leading-[1.65] text-foreground">{info.goal}</p>
        </Section>
      )}
    </div>
  );
}
