import type { ReactNode } from "react";
import type { Interaction } from "@/queries/chat";

import { BellIcon } from "@phosphor-icons/react/Bell";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { SpinnerIcon } from "@phosphor-icons/react/Spinner";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { formatLocale, listSeparator, translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  chatQueryOptions,
  useAnswerInteraction,
  usePendingInteractions,
} from "@/queries/chat";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";
import { AgentAvatar } from "./agent-identity";
import { useAgents } from "./use-agents";
import { useAttention } from "./use-attention";
import { useGroups, useOpenGroup } from "./use-groups";
import { useSectionLink } from "./workspace-search";

// Everything waiting for the user, the same in the side panel and on the
// full-window page: confirmations to answer in place, then tasks and
// routines to open in the same mode (the panel's tab beside the chat, or the
// full-window page). Each row says what it is, why it waits and what to do.

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString(formatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How an answered or lapsed confirmation ended. */
function outcome(interaction: Interaction) {
  const chosen = interaction.options.find(
    (option) => option.value === interaction.answer,
  );
  if (chosen)
    return translate("chat:confirmations.selectedChoice", {
      choice: chosen.label,
    });
  if (interaction.status === "expired")
    return translate("chat:confirmations.expired");
  return translate("chat:confirmations.answered");
}

/** A confirmation: who asked, what, and its answers or how it ended. */
export function Confirmation({ interaction }: { interaction: Interaction }) {
  const { t: translateText } = useTranslation([
    "overview",
    "agents",
    "chat",
    "common",
    "navigation",
  ] as const);
  const { agents } = useAgents();
  const openGroup = useOpenGroup();
  const { groups } = useGroups();
  const answer = useAnswerInteraction();
  const agent = agents.find((a) => a.id === interaction.agent_id);
  const pending = interaction.status === "pending";
  // The first line says what is asked ("tasks 请求确认"), the rest the details.
  const [headline, ...rest] = interaction.prompt.split("\n");
  const details = rest.join("\n").trim();
  return (
    <li className="flex gap-3 px-3 py-3">
      <AgentAvatar
        agent={agent ?? { id: interaction.agent_id }}
        className="size-7 shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => openGroup(interaction.group_id)}
            className="min-w-0 truncate font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            {agent?.name ?? translateText("agents:labels.deletedAgent")} ·{" "}
            {groups.find((g) => g.id === interaction.group_id)?.name ??
              translateText("chat:groups.groupChat")}
          </button>
          <span className="ml-auto shrink-0 tabular-nums">
            {clock(interaction.created_at)}
          </span>
        </div>
        <div
          className={cn(
            "text-sm break-words",
            !pending && "line-clamp-3 text-muted-foreground",
          )}
        >
          <p className={cn(pending && "font-medium")}>{headline}</p>
          {details ? (
            <p
              className={cn(
                "whitespace-pre-wrap",
                pending && "text-muted-foreground",
              )}
            >
              {details}
            </p>
          ) : null}
        </div>
        {pending ? (
          <div className="flex flex-wrap gap-2 pt-1.5">
            {interaction.options.map((option, index) => {
              const chosen =
                answer.isPending && answer.variables.value === option.value;
              return (
                <Button
                  key={option.value}
                  variant={index === 0 ? "default" : "outline"}
                  disabled={answer.isPending}
                  aria-busy={chosen || undefined}
                  onClick={() =>
                    answer.mutate(
                      { id: interaction.id, value: option.value },
                      { onError: (error) => toast.error(error.message) },
                    )
                  }
                >
                  {chosen ? (
                    <SpinnerIcon
                      aria-hidden="true"
                      className="motion-safe:animate-spin"
                    />
                  ) : null}
                  {option.label}
                </Button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {outcome(interaction)}
          </p>
        )}
      </div>
    </li>
  );
}

const linkRow =
  "flex items-center gap-3 px-3 py-2.5 duration-[60ms] ease-linear outline-none hover:bg-muted/60 focus-visible:bg-muted/60 motion-reduce:transition-none";

/** A task or routine's row: what it is and why it waits, then a caret. */
function LinkRowBody({
  icon: Icon,
  title,
  reason,
  alert,
}: {
  icon: typeof ClockIcon;
  title: ReactNode;
  reason: string;
  alert: boolean;
}) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-3 text-sm break-words">{title}</span>
        <span
          className={cn(
            "block text-xs",
            alert ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {reason}
        </span>
      </span>
      <span className="flex size-7 shrink-0 items-center justify-center">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      </span>
      <CaretRightIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    </>
  );
}

function Group({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  if (!count) return null;
  return (
    <section aria-label={label}>
      <h3 className="flex gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
        {label}
        <span className="tabular-nums">{count}</span>
      </h3>
      <ul className="divide-y">{children}</ul>
    </section>
  );
}

/** Confirmations, tasks and routines waiting for the user, by kind. */
export function PendingList() {
  const { t: translateText } = useTranslation([
    "overview",
    "agents",
    "chat",
    "common",
    "navigation",
  ] as const);
  // Only their state: the items come from usePendingInteractions and
  // useAttention.
  const sources = [
    {
      what: translateText("chat:confirmations.requestLabel"),
      query: useQuery(chatQueryOptions()),
    },
    { what: translateText("navigation:sections.tasks"), query: useTasks() },
    {
      what: translateText("navigation:sections.routines"),
      query: useRoutines(),
    },
  ];
  const confirmations = usePendingInteractions();
  const { tasks, routines } = useAttention();
  const sectionLink = useSectionLink();
  const failed = sources.filter(({ query }) => query.error);
  const loading = sources.some(({ query }) => query.isPending);
  const total = confirmations.length + tasks.length + routines.length;

  if (loading && !total) return <Loading rows={3} />;
  return (
    <div>
      {failed.length ? (
        <LoadError
          what={failed.map(({ what }) => what).join(listSeparator())}
          error={failed[0].query.error!}
          onRetry={() => failed.forEach(({ query }) => void query.refetch())}
          className="py-6"
        />
      ) : null}
      {!total && !failed.length && !loading ? (
        <Empty icon={BellIcon} title={translateText("attention.emptyTitle")}>
          {translateText("attention.emptyDescription")}
        </Empty>
      ) : null}
      <Group
        label={translateText("chat:confirmations.requestLabel")}
        count={confirmations.length}
      >
        {confirmations.map((interaction) => (
          <Confirmation key={interaction.id} interaction={interaction} />
        ))}
      </Group>
      <Group
        label={translateText("navigation:sections.tasks")}
        count={tasks.length}
      >
        {tasks.map(({ task, reason, alert }) => (
          <li key={task.id}>
            <Link
              {...sectionLink("tasks", { task: task.id })}
              title={`#${task.number} ${task.title}`}
              className={linkRow}
            >
              <LinkRowBody
                icon={ListChecksIcon}
                title={
                  <>
                    <span className="text-muted-foreground tabular-nums">
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
      </Group>
      <Group
        label={translateText("navigation:sections.routines")}
        count={routines.length}
      >
        {routines.map(({ routine, reason, alert }) => (
          <li key={routine.id}>
            <Link
              {...sectionLink("routines", { routine: routine.id })}
              title={routine.name}
              className={linkRow}
            >
              <LinkRowBody
                icon={ClockIcon}
                title={routine.name}
                reason={reason}
                alert={alert}
              />
            </Link>
          </li>
        ))}
      </Group>
    </div>
  );
}
