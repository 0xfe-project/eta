import type { ReactNode } from "react";
import type { Interaction } from "@/queries/chat";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { SpinnerIcon } from "@phosphor-icons/react/Spinner";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  chatQueryOptions,
  useAnswerInteraction,
  usePendingInteractions,
} from "@/queries/chat";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";
import { AgentAvatar } from "./agent-identity";
import { useAgents, useOpenAgent } from "./use-agents";
import { useAttention } from "./use-attention";
import { useSectionLink } from "./workspace-search";

// Everything waiting for the user, the same in the side panel and on the
// full-window page: confirmations to answer in place, then tasks and
// routines to open in the same mode (the panel's tab beside the chat, or the
// full-window page). Each row says what it is, why it waits and what to do.

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How an answered or lapsed confirmation ended. */
function outcome(interaction: Interaction) {
  const chosen = interaction.options.find(
    (option) => option.value === interaction.answer,
  );
  if (chosen) return `已选择「${chosen.label}」`;
  if (interaction.status === "expired") return "已过期，没有答复";
  return "已答复";
}

/** A confirmation: who asked, what, and its answers or how it ended. */
export function Confirmation({ interaction }: { interaction: Interaction }) {
  const { agents } = useAgents();
  const openAgent = useOpenAgent();
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
            onClick={() => openAgent(interaction.agent_id)}
            className="min-w-0 truncate font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            {agent?.name ?? "已删除的智能体"}
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
  "flex items-center gap-3 px-3 py-2.5 transition-colors duration-[60ms] ease-linear outline-none hover:bg-muted/60 focus-visible:bg-muted/60 motion-reduce:transition-none";

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
  // Only their state: the items come from usePendingInteractions and
  // useAttention.
  const sources = [
    { what: "确认请求", query: useQuery(chatQueryOptions()) },
    { what: "任务", query: useTasks() },
    { what: "定时", query: useRoutines() },
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
          what={failed.map(({ what }) => what).join("、")}
          error={failed[0].query.error!}
          onRetry={() => failed.forEach(({ query }) => void query.refetch())}
          className="py-6"
        />
      ) : null}
      {!total && !failed.length && !loading ? (
        <Empty icon={BellIcon} title="没有等你处理的事">
          智能体请你确认的操作、交给你的任务、新的定时报告，都会在这里。
        </Empty>
      ) : null}
      <Group label="确认请求" count={confirmations.length}>
        {confirmations.map((interaction) => (
          <Confirmation key={interaction.id} interaction={interaction} />
        ))}
      </Group>
      <Group label="任务" count={tasks.length}>
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
      <Group label="定时" count={routines.length}>
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
