import type {
  MessageView,
  TaskCardData,
  TaskDraftData,
} from "@eta/client-contracts";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
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
import { useFold } from "@/lib/fold";
import { ACTIVE_STATUSES } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { muted } from "./activity-card";
import { ArtifactButton } from "./artifact-dialog";
import { runStatusLabels, statusLabel, workspaceLabel } from "./task-format";
import { StatusIcon } from "./task-status-icon";
import { TaskForm } from "./tasks";
import { useSectionLink } from "./workspace-search";

// The two task rows of a conversation's timeline. An agent proposes a task as a draft (`task_draft`)
// the user edits and confirms; confirming turns that same row into the task's card (`task_card`),
// which the host refreshes whenever the task changes. Both are drawn from the row alone.
//
// Both fold the way a turn's thinking and its tool calls do — one line with a chevron, opened in
// place — because to a reader skimming a conversation they are the same kind of thing: worth reading
// while they are news, something to step over afterwards. A draft is open while the turn that wrote
// it is still at work and folded to one line once that turn settles; a card, which exists because the
// reader asked for it, is open until they say otherwise. Either way the folded line says what the row
// is, what it proposes, and what it still waits for, and keeps the way to act on it on that line:
// folding hides a draft's prose and never its question. A choice the reader made themselves outranks
// both defaults and outlives the reload (see `lib/fold.ts`).

/** Whether the turn a row came out of is still at work — or the row does not say whose turn it was. */
const turnActive = (turn: MessageView | undefined) =>
  turn === undefined || ACTIVE_STATUSES.has(turn.status);

/**
 * The fold, and who it really belongs to.
 *
 * The browser does the toggling under the line, as it does for every other fold in a transcript, and
 * reports it as a `toggle`; the report is what the state, the chevron, the body and the remembered
 * choice are all drawn from, so they cannot disagree. A report that agrees with what the card already
 * shows is the browser catching up with a default that moved underneath it — a turn settling folds
 * the draft it left open — and only a report that disagrees is the reader having an opinion.
 */
function foldable(
  open: boolean,
  fold: (open: boolean) => void,
): {
  open: boolean;
  onToggle: (event: { currentTarget: HTMLDetailsElement }) => void;
} {
  return {
    open,
    onToggle: (event) => {
      const next = event.currentTarget.open;
      if (next !== open) fold(next);
    },
  };
}

/**
 * The line a folded task row leaves on the page: chevron, what it is, what it proposes, what it
 * waits on, and the way to act on it.
 *
 * A control standing on the line — the way to the form, the way to the task — is the line's other
 * purpose, and its click is spent there: it should not also fold the card around the reader's
 * fingers. That has to be said on the way into the line rather than on the way out of it, because the
 * browser begins its toggling as soon as the click has passed the line, and by the time the control's
 * own handler hears about the click the decision is already made.
 */
function TaskFoldHead({
  label,
  title,
  marker,
  children,
}: {
  label: string;
  /**
   * The one line the row is about: a proposed title, or a task's number and title — as a link when
   * there is somewhere for it to go, since this line is the card while it is folded.
   */
  title: React.ReactNode;
  /** What the reader owes this row, said quietly at the right end of the line. */
  marker?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <summary
      className="thinking-block-header task-fold-head"
      onClickCapture={(event) => {
        const target = event.target as Element;
        if (target.closest("button,a") !== null) event.preventDefault();
      }}
    >
      <span aria-hidden="true" className="thinking-block-chevron">
        ▶
      </span>
      <ListChecksIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0">{label}</span>
      <span className="task-fold-title">{title}</span>
      {marker}
      {children}
    </summary>
  );
}

/** A task an agent proposed, to confirm: its words as written, and the way to the form. */
export function TaskDraftRow({
  message,
  turn,
}: {
  message: MessageView;
  /** The reply that wrote this draft, when the draft says which turn it came out of. */
  turn?: MessageView;
}) {
  const { t: translateText } = useTranslation(["tasks", "common"] as const);
  const [open, fold] = useFold(message.id, turnActive(turn));
  const [form, setForm] = useState(false);
  const draft = message.data as unknown as TaskDraftData;
  return (
    <details className="task-fold" {...foldable(open, fold)}>
      <TaskFoldHead
        label={translateText("draft.title")}
        title={draft.title}
        marker={
          <span className="task-fold-waiting">
            {translateText("draft.awaitingConfirm")}
          </span>
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
 * No turn is asked for here. A draft is folded away when its turn ends because it was a moment in
 * that turn; a card is left open because it is only here at all in place of the draft the reader
 * confirmed, and what it has to say afterwards is the task's, not the turn's.
 */
export function TaskCardRow({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "artifacts",
    "common",
  ] as const);
  const sectionLink = useSectionLink();
  const [open, fold] = useFold(message.id, true);
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
  return (
    <details className="task-fold" {...foldable(open, fold)}>
      <TaskFoldHead
        label={translateText("card.title")}
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
          <span
            className={cn("ml-auto flex shrink-0 items-center gap-1", muted)}
          >
            <StatusIcon status={card.status} className="size-3.5" />
            {statusLabel(card.status)}
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
  );
}
