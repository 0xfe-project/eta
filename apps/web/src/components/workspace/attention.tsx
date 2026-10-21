import type { ReactNode } from "react";
import type { InteractionView } from "@/queries/inbox";

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
import { Input } from "@/components/ui/input";
import { formatLocale, listSeparator, translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { agentName } from "@/queries/agents";
import { useInbox, usePendingInteractions } from "@/queries/inbox";
import { useAnswerQuestion } from "@/queries/questions";
import { useRoutines } from "@/queries/routines";
import { useTasks } from "@/queries/tasks";
import { AgentAvatar } from "./agent-identity";
import { useAgents } from "./use-agents";
import { useAttention } from "./use-attention";
import { useGroups, useOpenGroup } from "./use-groups";
import { useSectionLink } from "./workspace-search";

// Everything waiting for the user, the same in the side panel and on the
// full-window page: confirmations to answer in place, then tasks and routines to
// open where that section lives — `useSectionLink` picks the panel's tab beside
// the chat when the section has one, and the page when it does not (定时 has no
// tab). Each row says what it is, why it waits and what to do.

function clock(epoch: number) {
  return new Date(epoch).toLocaleTimeString(formatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How an answered, declined or lapsed question ended. */
function outcome(interaction: InteractionView) {
  const { answer, status } = interaction;
  if (answer?.kind === "selection")
    return translate("chat:confirmations.selectedChoice", {
      choice: answer.selections.join(listSeparator()),
    });
  if (answer?.kind === "freeform") return answer.text;
  if (status === "expired") return translate("chat:confirmations.expired");
  if (status === "canceled") return translate("chat:confirmations.canceled");
  return translate("chat:confirmations.answered");
}

/** A question: who asked, where, what, and its answers, or how it ended. */
function Confirmation({ interaction }: { interaction: InteractionView }) {
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
  const [text, setText] = useState("");
  const pending = interaction.status === "pending";
  const mine = answer.isPending && answer.variables?.id === interaction.id;
  // The first line says what is asked ("tasks 请求确认"), the rest the details.
  const [headline, ...rest] = interaction.prompt.split("\n");
  const details = rest.join("\n").trim();
  const onError = (error: Error) => toast.error(error.message);
  const chosen = (option: string) => {
    const response = mine ? answer.variables?.response : undefined;
    return (
      response?.kind === "selection" && response.selections.includes(option)
    );
  };
  const conversationName = groups.find(
    (g) => g.id === interaction.conversationId,
  )?.name;
  const where = interaction.conversationId
    ? (conversationName ?? translateText("chat:groups.groupChat"))
    : null;
  const who = interaction.agentId
    ? agentName(agents, interaction.agentId)
    : null;
  const label = [who, where].filter(Boolean).join(" · ");
  const conversationId = interaction.conversationId;
  return (
    <li className="flex gap-3 px-3 py-3">
      <AgentAvatar
        agent={{ id: interaction.agentId ?? interaction.sessionId }}
        className="size-7 shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          {conversationId ? (
            <button
              type="button"
              onClick={() => openGroup(conversationId)}
              className="min-w-0 truncate font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
            >
              {label}
            </button>
          ) : (
            <span className="min-w-0 truncate font-medium text-foreground">
              {label}
            </span>
          )}
          <span className="ml-auto shrink-0 tabular-nums">
            {clock(interaction.createdAt)}
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
            {interaction.options.length === 0 ? (
              <form
                className="flex min-w-0 flex-1 gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (text.trim() !== "")
                    choose(interaction, [text.trim()], { onError });
                }}
              >
                <Input
                  aria-label={translateText("chat:confirmations.reply")}
                  value={text}
                  disabled={answer.isPending}
                  onChange={(event) => setText(event.target.value)}
                />
                <Button
                  type="submit"
                  disabled={answer.isPending || text.trim() === ""}
                >
                  {translateText("common:actions.send")}
                </Button>
              </form>
            ) : null}
            {interaction.options.map((option, index) => (
              <Button
                key={option}
                variant={
                  index === 0 || picked.includes(option) ? "default" : "outline"
                }
                disabled={answer.isPending}
                aria-busy={chosen(option) || undefined}
                onClick={() =>
                  interaction.multi
                    ? setPicked(
                        picked.includes(option)
                          ? picked.filter((p) => p !== option)
                          : [...picked, option],
                      )
                    : choose(interaction, [option], { onError })
                }
              >
                {chosen(option) ? (
                  <SpinnerIcon
                    aria-hidden="true"
                    className="motion-safe:animate-spin"
                  />
                ) : null}
                {option}
              </Button>
            ))}
            {interaction.multi ? (
              <Button
                disabled={answer.isPending || picked.length === 0}
                onClick={() => choose(interaction, picked, { onError })}
              >
                {translateText("common:actions.send")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={answer.isPending}
              onClick={() => abort(interaction, { onError })}
            >
              {translateText("chat:confirmations.giveUp")}
            </Button>
          </div>
        ) : (
          <p className="line-clamp-2 text-xs text-muted-foreground">
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
  const { loaded: inboxLoaded, error: inboxError } = useInbox();
  const sources = [
    {
      what: translateText("chat:confirmations.requestLabel"),
      loaded: inboxLoaded,
      error: inboxError,
    },
    { what: translateText("navigation:sections.tasks"), ...useTasks() },
    {
      what: translateText("navigation:sections.routines"),
      ...useRoutines(),
    },
  ];
  const confirmations = usePendingInteractions();
  const { tasks, routines } = useAttention();
  const sectionLink = useSectionLink();
  const failed = sources.filter(({ error }) => error);
  const loading = sources.some(({ loaded, error }) => !loaded && !error);
  const total = confirmations.length + tasks.length + routines.length;

  if (loading && !total) return <Loading rows={3} />;
  return (
    <div>
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
