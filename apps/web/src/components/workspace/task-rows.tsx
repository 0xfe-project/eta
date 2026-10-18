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
import { cn } from "@/lib/utils";
import { actionClass, frameClass, muted } from "./activity-card";
import { ArtifactButton } from "./artifact-dialog";
import { assigneeLabel, statusLabel } from "./task-format";
import { StatusIcon } from "./task-status-icon";
import { TaskForm } from "./tasks";
import { useSectionLink } from "./workspace-search";

// The two task rows of a conversation's timeline. An agent proposes a task as a draft (`task_draft`)
// the user edits and confirms; confirming turns that same row into the task's card (`task_card`),
// which the host refreshes whenever the task changes. Both are drawn from the row alone.

/** A task an agent proposed, to confirm: its words as written, and the way to the form. */
export function TaskDraftRow({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation(["tasks", "common"] as const);
  const [open, setOpen] = useState(false);
  const draft = message.data as unknown as TaskDraftData;
  return (
    <section
      aria-label={translateText("draft.title")}
      className="max-w-md space-y-2 border border-dashed border-border px-3 py-2"
    >
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ListChecksIcon aria-hidden="true" className="size-3.5 shrink-0" />
        {translateText("draft.title")}
      </p>
      <p className="text-sm font-medium wrap-anywhere">{draft.title}</p>
      <Markdown className="line-clamp-6 text-sm">{draft.description}</Markdown>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {translateText("draft.notCreatedHint")}
        </span>
        <Button size="sm" onClick={() => setOpen(true)}>
          {translateText("draft.editAndCreate")}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{translateText("draft.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {translateText("draft.confirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <TaskForm
            bare
            proposal={{
              conversationId: message.conversationId,
              messageId: message.id,
              title: draft.title,
              description: draft.description,
            }}
            onDone={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** A task as the conversation last heard of it: the whole card opens the task. */
export function TaskCardRow({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "artifacts",
    "common",
  ] as const);
  const sectionLink = useSectionLink();
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
    card.assignee === "user" ? assigneeLabel("user") : null,
    card.comments > 0
      ? translateText("card.commentCount", { count: card.comments })
      : null,
  ].filter(Boolean);
  return (
    <div className="max-w-md space-y-1">
      <Link
        {...sectionLink("tasks", { task: card.taskId })}
        aria-label={label}
        title={label}
        className={cn(frameClass, actionClass)}
      >
        <ListChecksIcon
          aria-hidden="true"
          className={cn("size-4 shrink-0", muted)}
        />
        <span className="min-w-0 flex-1 truncate">
          <span className={cn("tabular-nums", muted)}>#{card.number} </span>
          {card.title}
        </span>
        <span className={cn("flex shrink-0 items-center gap-1", muted)}>
          <StatusIcon status={card.status} className="size-3.5" />
          {statusLabel(card.status)}
        </span>
      </Link>
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
  );
}
