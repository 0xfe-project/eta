import type { ReactNode } from "react";
import type { Question } from "@/queries/questions";

import { BellIcon } from "@phosphor-icons/react/Bell";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { SpinnerIcon } from "@phosphor-icons/react/Spinner";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { listSeparator } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { agentName } from "@/queries/agents";
import { useAnswerQuestion, useQuestions } from "@/queries/questions";
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

/** A question a run is waiting on: who asked, where, what, and its answers. */
function Confirmation({ question }: { question: Question }) {
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
  const { choose, abort, answer } = useAnswerQuestion();
  const [picked, setPicked] = useState<string[]>([]);
  // The first line says what is asked ("tasks 请求确认"), the rest the details.
  const [headline, ...rest] = question.prompt.split("\n");
  const details = rest.join("\n").trim();
  const onError = (error: Error) => toast.error(error.message);
  return (
    <li className="flex gap-3 px-3 py-3">
      <AgentAvatar
        agent={{ id: question.agentId }}
        className="size-7 shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => openGroup(question.conversationId)}
            className="min-w-0 truncate font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            {agentName(agents, question.agentId)} ·{" "}
            {groups.find((g) => g.id === question.conversationId)?.name ??
              translateText("chat:groups.groupChat")}
          </button>
        </div>
        <div className="text-sm break-words">
          <p className="font-medium">{headline}</p>
          {details ? (
            <p className="whitespace-pre-wrap text-muted-foreground">
              {details}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 pt-1.5">
          {question.options.map((option, index) => {
            const chosen =
              answer.isPending && answer.variables?.questionId === question.id;
            return (
              <Button
                key={option}
                variant={
                  index === 0 || picked.includes(option) ? "default" : "outline"
                }
                disabled={answer.isPending}
                aria-busy={chosen || undefined}
                onClick={() =>
                  question.multi
                    ? setPicked(
                        picked.includes(option)
                          ? picked.filter((p) => p !== option)
                          : [...picked, option],
                      )
                    : choose(question, [option], { onError })
                }
              >
                {chosen ? (
                  <SpinnerIcon
                    aria-hidden="true"
                    className="motion-safe:animate-spin"
                  />
                ) : null}
                {option}
              </Button>
            );
          })}
          {question.multi ? (
            <Button
              disabled={answer.isPending || picked.length === 0}
              onClick={() => choose(question, picked, { onError })}
            >
              {translateText("common:actions.send")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => abort(question, { onError })}>
            {translateText("chat:confirmations.giveUp")}
          </Button>
        </div>
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
    { what: translateText("navigation:sections.tasks"), ...useTasks() },
    {
      what: translateText("navigation:sections.routines"),
      ...useRoutines(),
    },
  ];
  const confirmations = useQuestions();
  const { tasks, routines } = useAttention();
  const sectionLink = useSectionLink();
  const failed = sources.filter(({ error }) => error);
  const loading = sources.some(({ loaded, error }) => !loaded && !error);
  const total = confirmations.length + tasks.length + routines.length;

  if (loading && !total) return <Loading rows={3} />;
  return (
    <div>
      {/*
       * This page is now the *cross-group* view. The questions that belong to the conversation you
       * are in are shown there (the strip above the transcript), because that is where they block
       * something you are looking at; what is left here is everything else — the ones you would
       * only find by opening every group in turn.
       */}
      <div className="mb-2 border-b pb-2">
        <h2 className="text-sm font-semibold">
          {String(translateText("attention.allGroups"))}
        </h2>
        <p className="text-xs text-muted-foreground">
          {String(translateText("attention.allGroupsHint"))}
        </p>
      </div>
      {failed.length ? (
        <LoadError
          what={failed.map(({ what }) => what).join(listSeparator())}
          error={failed[0].error!}
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
        {confirmations.map((question) => (
          <Confirmation key={question.id} question={question} />
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
