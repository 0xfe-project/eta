import type {
  MessageView,
  TaskCardData,
  TaskDraftData,
} from "@eta/client-contracts";
import type { Progress } from "./task-plan";
import type { Task } from "@/queries/tasks";
import { draftStatus } from "@eta/client-contracts";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { foldable, useFold } from "@/lib/fold";
import { cn } from "@/lib/utils";
import { useTasks } from "@/queries/tasks";
import { muted } from "./activity-card";
import { ArtifactButton } from "./artifact-dialog";
import { ProgressBar } from "./task-bits";
import { TaskFoldHead } from "./task-fold";
import { runStatusLabels, statusLabel, workspaceLabel } from "./task-format";
import { isWaiting, progressOf, waitSummary } from "./task-plan";
import { StatusIcon, StatusPill } from "./task-status-icon";
import { TaskForm } from "./tasks";
import { useSectionLink } from "./workspace-search";

// The two task rows of a conversation's timeline. An agent proposes a task as a draft (`task_draft`)
// the user edits and confirms; confirming turns that same row into the task's card (`task_card`),
// which the host refreshes whenever the task changes. Both are drawn from the row alone.
//
// Both fold the way a turn's thinking and its tool calls do — one line with a chevron, opened in
// place — because to a reader skimming a conversation they are the same kind of thing: worth reading
// when they open them, something to step over otherwise. A draft arrives already folded to one line.
// While its arguments were still streaming there was no card beside the answer at all (the call lived
// in the process, like any other tool); once the row lands it stays one line — title, that it waits,
// and the way to the form — instead of opening its prose and then folding again when the turn ends.
// A card, which exists because the reader asked for it, is open until they say otherwise. Folding
// hides a draft's prose and never its question. A choice the reader made themselves outranks both
// defaults and outlives the reload (see `lib/fold.ts`).

/** A task an agent proposed, to confirm: its words as written, and the way to the form. */
export function TaskDraftRow({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation(["tasks", "common"] as const);
  // Folded from the moment the row exists. Opening it while the turn is still at work, then
  // folding it when the turn ends, is the same card shown twice; the call itself stays in the
  // process while its arguments stream.
  const [open, fold] = useFold(message.id, false);
  const [form, setForm] = useState(false);
  const draft = message.data as unknown as TaskDraftData;
  // A draft written before drafts said where they go is one that starts, as they all did then.
  const backlog = draftStatus(draft) === "backlog";
  return (
    <details className="task-fold" {...foldable(open, fold)}>
      <TaskFoldHead
        label={translateText("draft.title")}
        title={draft.title}
        marker={
          <>
            {backlog ? <StatusPill status="backlog" /> : null}
            <span className="task-fold-waiting">
              {translateText("draft.awaitingConfirm")}
            </span>
          </>
        }
      >
        {/* On the folded line rather than behind it, so a reader who has already decided is not made
         * to open the card to find the button. */}
        <Button
          size="xs"
          variant="outline"
          className="ml-auto shrink-0"
          onClick={() => setForm(true)}
        >
          {translateText("draft.editAndCreate")}
        </Button>
      </TaskFoldHead>
      <div className="task-fold-body draft-card">
        <Markdown className="text-sm">{draft.description}</Markdown>
        <p className="text-xs text-muted-foreground">
          {translateText("draft.notCreatedHint", {
            workspace: workspaceLabel({
              mode: draft.workspace,
              base: null,
              path: null,
              branch: null,
            }),
          })}
        </p>
        {backlog ? (
          <p className="text-xs text-muted-foreground">
            {translateText("draft.backlogHint")}
          </p>
        ) : null}
      </div>
      <Dialog open={form} onOpenChange={setForm}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{translateText("draft.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {translateText("draft.confirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <TaskForm
            proposal={{
              conversationId: message.conversationId,
              messageId: message.id,
              title: draft.title,
              description: draft.description,
              status: draftStatus(draft),
            }}
            onDone={() => setForm(false)}
          />
        </DialogContent>
      </Dialog>
    </details>
  );
}

/**
 * A task as the conversation last heard of it: the whole line opens the task.
 *
 * No turn is asked for here. A draft is one folded line from the moment it exists, because opening
 * it while the turn is still at work and folding it when the turn ends is the same card twice; a
 * card is left open because it is only here at all in place of the draft the reader confirmed, and
 * what it has to say afterwards is the task's, not the turn's.
 */
export function TaskCardRow({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "artifacts",
    "common",
  ] as const);
  const sectionLink = useSectionLink();
  const [open, fold] = useFold(message.id, true);
  const { tasks: all } = useTasks();
  const card = message.data as unknown as TaskCardData;
  if (card.deleted)
    return (
      <p className="text-xs text-muted-foreground">
        {translateText("card.deletedSummary", {
          number: card.number,
          title: card.title,
        })}
      </p>
    );
  const label = `${translateText("common:actions.openTask")} #${card.number} ${card.title}`;
  const meta = [
    card.runStatus === null ? null : runStatusLabels[card.runStatus],
    card.comments > 0
      ? translateText("card.commentCount", { count: card.comments })
      : null,
  ].filter(Boolean);
  // The board's copy, when it has one: what the task waits for and how far its subtasks are.
  // The status is the card's own (the host refreshes it with the task); the rest, the board's.
  const found = all.find((task) => task.id === card.taskId);
  const status = card.status;
  const live = found === undefined ? undefined : { ...found, status };
  const blocked = status === "blocked";
  const progress = live?.subtasks == null ? undefined : progressOf(live, all);
  return (
    <div
      data-task-card
      data-blocked={blocked || undefined}
      className={cn(blocked && "border-l-2 border-state-error pl-2")}
    >
      <details className="task-fold" {...foldable(open, fold)}>
        <TaskFoldHead
          label={translateText("card.title")}
          mark={<StatusIcon status={status} className="size-3.5" />}
          title={
            // The line is the card while it is folded, so the way to the task is on the line rather
            // than behind it — and clicking it is spent on the task, not on opening the card too.
            <Link
              {...sectionLink("tasks", { task: card.taskId })}
              aria-label={label}
              title={label}
            >
              <span className={cn("tabular-nums", muted)}>#{card.number} </span>
              {card.title}
            </Link>
          }
          marker={
            <span className="ml-auto shrink-0">
              {live === undefined ? (
                <StatusPill status={status} />
              ) : (
                <CardMarker task={live} all={all} progress={progress} />
              )}
            </span>
          }
        />
        <div className="task-fold-body">
          {meta.length > 0 ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              {meta.join(" · ")}
            </p>
          ) : null}
          {card.summary ? (
            <p className="line-clamp-2 text-xs wrap-anywhere text-muted-foreground">
              {card.summary}
            </p>
          ) : null}
          {card.artifacts.map((artifact) => (
            <ArtifactButton
              key={artifact.artifactId}
              id={artifact.artifactId}
              version={artifact.version}
              className="block max-w-full truncate text-xs underline-offset-4 hover:underline"
            >
              {artifact.title}
              {translateText("artifacts:version.inlineLabel", {
                version: artifact.version,
              })}
            </ArtifactButton>
          ))}
        </div>
      </details>
      {progress === undefined ? null : (
        // A piece of work says how far it is even folded: its bar, and what is going and next.
        <div data-card-progress className="space-y-1 pt-1 pl-5">
          <ProgressBar progress={progress} className="max-w-60" />
          <p className="truncate text-xs text-muted-foreground">
            {[
              progress.now === undefined
                ? null
                : translateText("cards.now", { title: progress.now.title }),
              progress.next === undefined
                ? null
                : translateText("cards.next", { title: progress.next.title }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      )}
    </div>
  );
}

/** The end of a task card's line: its status, what it waits for, or that it needs a decision. */
function CardMarker({
  task,
  all,
  progress,
}: {
  task: Task;
  all: readonly Task[];
  progress: Progress | undefined;
}) {
  const { t } = useTranslation(["tasks"] as const);
  if (progress !== undefined)
    return (
      <StatusPill status={task.status}>
        {t("chatCard.progress", {
          status: statusLabel(task.status),
          done: progress.done,
          total: progress.total,
        })}
      </StatusPill>
    );
  if (task.status === "blocked")
    return <StatusPill status="blocked">{t("chatCard.blocked")}</StatusPill>;
  if (isWaiting(task)) {
    const wait = waitSummary(task, all);
    return (
      <span className="inline-flex items-center gap-1 border px-1.5 text-xs leading-5 text-muted-foreground">
        <LockSimpleIcon aria-hidden="true" className="size-3" />
        {wait?.kind === "one"
          ? t("chatCard.waitFor", { title: wait.title })
          : t("chatCard.waitMany", { count: wait?.left ?? 0 })}
      </span>
    );
  }
  return <StatusPill status={task.status} />;
}
