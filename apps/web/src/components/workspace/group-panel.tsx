import type { ConversationSummary } from "@eta/client-contracts";
import { useTranslation } from "react-i18next";
import { useArtifacts } from "@/queries/artifacts";
import { useConversation } from "@/queries/conversations";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";
import { ActivityRefCard } from "./activity-ref";
import { GroupMembers } from "./groups";
import { when } from "./routine-format";

/**
 * 上下文: what this conversation is made of, for the panel beside it.
 *
 * One list of members, and it is the group's own — the same component the group manager uses,
 * because it already carries everything a member has (its session's numbers, the per-member menu,
 * invite, rename, archive) and a second list beside it was a second thing to keep in sync. What
 * this file adds is only what surrounds that: the goal the header cannot hold, and the group's work
 * — tasks, routines, artifacts — under it.
 */
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
  const { data: board } = useTasks();
  const { data: routines } = useRoutines();
  const { data: artifacts } = useArtifacts();
  const { info } = useConversation(group?.id);
  if (group === undefined) return null;
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* The one fact the header cannot hold. The name, the folder and the unread count are
          already on screen above; repeating them here is three things to read twice. */}
      {info === undefined || info.goal.length === 0 ? null : (
        <section className="border-b px-3 py-2">
          <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
            {translateText("chat:groups.fields.goal")}
          </h3>
          <p className="text-sm leading-[1.65] text-foreground">{info.goal}</p>
        </section>
      )}

      <div className="px-3 py-2">
        <GroupMembers />
      </div>

      <section className="border-t px-3 py-2">
        <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
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

      <section className="border-t px-3 py-2">
        <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
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
                  <span className="shrink-0 font-mono text-[10px] text-faint tabular-nums">
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

      <section className="border-t px-3 py-2 pb-4">
        <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
          {translateText("navigation:sections.artifacts")}
          <span className="ml-1 tabular-nums">{groupArtifacts.length}</span>
        </h3>
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
                    number: artifact.versions.at(-1)?.number ?? 0,
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
