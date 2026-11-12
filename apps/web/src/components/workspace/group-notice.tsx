import type { MessageView } from "@eta/client-contracts";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ROUTINES_VISIBLE } from "@/lib/features";
import { agentName, useAgentList } from "@/queries/agents";
import { GroupProposalCard } from "./group-proposal-card";
import { useSectionLink } from "./workspace-search";

/**
 * A system row: something that happened to the conversation, not something said in it.
 *
 * The host writes these in English, for the agents that read them at their next wake; the page
 * says them in the reader's language from the event they record (`steward`, `wake_budget`), and
 * shows the row's own text for an event it does not know.
 */
export function GroupNotice({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { agents } = useAgentList();
  const { event, from, to, budget, routineId, routineName, runId, title } =
    message.data as {
      event?: string;
      from?: string | null;
      to?: string | null;
      budget?: number;
      routineId?: string;
      routineName?: string;
      runId?: string;
      title?: string | null;
    };
  if (event === "captain_group_proposal")
    return <GroupProposalCard message={message} />;
  let text = message.text;
  if (event === "captain_created") {
    text = translateText("chat:system.createdByCaptain");
  } else if (event === "steward") {
    if (typeof to === "string" && typeof from === "string")
      text = translateText("chat:system.stewardChanged", {
        to: agentName(agents, to),
        from: agentName(agents, from),
      });
    else if (typeof to === "string")
      text = translateText("chat:system.stewardSet", {
        to: agentName(agents, to),
      });
    else if (typeof from === "string")
      text = translateText("chat:system.stewardCleared", {
        from: agentName(agents, from),
      });
  } else if (event === "wake_budget" && typeof budget === "number") {
    text = translateText("chat:system.wakeBudget", { budget });
  }
  if (event === "routine_report" && typeof routineName === "string") {
    if (ROUTINES_VISIBLE && typeof routineId === "string")
      return (
        <RoutineReport
          routineId={routineId}
          name={routineName}
          runId={runId}
          title={title}
        />
      );
    // Routine is off in this build: the report is still news, so its line stays, in the reader's
    // language; the way to the page it belongs to does not.
    text = title
      ? translateText("chat:system.routineReport", {
          name: routineName,
          title,
        })
      : translateText("chat:system.routineReportUntitled", {
          name: routineName,
        });
  }
  return (
    <div className="system-message">
      <p>{text}</p>
    </div>
  );
}

/** A routine's report: one line, which opens the report where the routine is. */
function RoutineReport({
  routineId,
  name,
  runId,
  title,
}: {
  routineId: string;
  name: string;
  runId: string | undefined;
  title: string | null | undefined;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const sectionLink = useSectionLink();
  return (
    <div className="system-message">
      <Link
        {...sectionLink("routines", {
          routine: routineId,
          ...(runId === undefined ? {} : { run: runId }),
        })}
        className="underline-offset-4 hover:underline"
      >
        {title
          ? translateText("system.routineReport", { name, title })
          : translateText("system.routineReportUntitled", { name })}
      </Link>
    </div>
  );
}
