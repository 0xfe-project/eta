import type { ConversationSummary } from "@eta/client-contracts";
import { runningFirst } from "@eta/client-contracts";
import { useTranslation } from "react-i18next";
import { useCaptain } from "@/queries/captain";
import { useConversation } from "@/queries/conversations";
import { useTasks } from "@/queries/tasks";
import { ActivityRefCard } from "./activity-ref";
import { recentArtifacts, useGroupArtifacts } from "./artifact-filter";
import { ArtifactRow } from "./artifact-list";
import { CaptainModel, CaptainOperations } from "./captain-operations";
import { GroupMembers } from "./groups";
import { Section } from "./panel-section";
import { useWorkspaceView } from "./workspace-search";

/**
 * Context: what this conversation is made of, for the panel beside it, ordered by
 * whether it is worth a look *now* — reading it top down should cost one glance,
 * not a scroll to find out whether anything needs the user.
 *
 * So: what the group made and what it is on track to make first (tasks, artifacts),
 * then the background that is only news when it changes (members, goals).
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

/** How many artifacts the context tab lists; the Artifacts tab holds the rest. */
const RECENT = 5;

/**
 * Tasks as rows, edge to edge: the rule between two runs into the panel's own edges. One
 * height, a few rows on a normal window and less on a short one, so that members under it
 * stay in reach; a short list just ends. `overscroll-y-auto` undoes the panes' global
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
  const { artifacts: groupArtifacts } = useGroupArtifacts(group?.id);
  const { info } = useConversation(group?.id);
  const captain = useCaptain();
  const [, setView] = useWorkspaceView();
  if (group === undefined) return null;
  // Captain's conversation is a conversation, so this panel is its panel too — but what it is
  // working on is not a list of tasks of its own: it is the operations it is running for everyone
  // else. Tasks give way to Operations here, and nowhere else.
  const isCaptain = captain.identity?.conversationId === group.id;
  const groupTasks = board.filter((task) => task.conversationId === group.id);
  const tasks = groupTasks.filter((task) => !closed.has(task.status));
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
          // No height cap and no scroll of its own: a few rows, then the way to all of them.
          <>
            <ul className="-mx-3 divide-y divide-border">
              {recentArtifacts(groupArtifacts, RECENT).map((artifact) => (
                <li key={artifact.id}>
                  <ArtifactRow artifact={artifact} />
                </li>
              ))}
            </ul>
            {groupArtifacts.length > RECENT ? (
              <div className="-mx-3 -mb-2 flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {translateText("artifacts:list.recent", {
                    total: groupArtifacts.length,
                    shown: RECENT,
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => void setView("artifacts")}
                  className="shrink-0 text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {translateText("artifacts:list.viewAll")}
                </button>
              </div>
            ) : null}
          </>
        )}
      </Section>

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
