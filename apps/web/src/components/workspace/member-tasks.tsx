import type {
  SessionArgs,
  StoredTask,
  TaskStatus,
} from "@eta/client-contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useSession } from "@/queries/sessions";
import { useWireMutation } from "@/queries/wire";

/**
 * A member's task list, seen from its card in the panel.
 *
 * The tasks are the session's own — the same rows the task page draws, filtered to this agent by
 * being this agent's session. Nothing is copied: `taskUpdate` writes one row and both views follow.
 *
 * A status is a position in a cycle, not a dropdown in a row: click the chip, it moves on. The
 * dialog is for what a click cannot say — the text — and it carries the status as well, because
 * "this one is done and its wording is wrong" is one visit, not two.
 */
/** A status you can read at a glance in a four-character box. */
const MARK: Record<TaskStatus, string> = {
  pending: "·",
  in_progress: "▸",
  completed: "✓",
  cancelled: "×",
};

const ORDER: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

/** The next status in the cycle, wrapping: the click that needs no menu. */
function next(status: TaskStatus): TaskStatus {
  return ORDER[(ORDER.indexOf(status) + 1) % ORDER.length]!;
}

/** The card's own control: how many, and a way into them. Always there, count or no count. */
export function MemberTasksButton({
  sessionId,
  open,
  onToggle,
}: {
  sessionId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const tasks = useSession(sessionId)?.tasks ?? [];
  const done = tasks.filter((task) => task.status === "completed").length;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      title={translateText("chat:tasks.count", {
        done,
        total: tasks.length,
      })}
      className="shrink-0 border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground aria-expanded:border-foreground aria-expanded:text-foreground"
    >
      {translateText("chat:tasks.short")} {done}/{tasks.length}
    </button>
  );
}

/** What the button opens: the member's tasks, and one dialog for the one being edited. */
export function MemberTasksPanel({ sessionId }: { sessionId: string }) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const tasks = useSession(sessionId)?.tasks ?? [];
  const [editing, setEditing] = useState<StoredTask | null>(null);
  const update = useWireMutation<SessionArgs["taskUpdate"]>(
    "sessions",
    "taskUpdate",
  );
  const remove = useWireMutation<SessionArgs["taskRemove"]>(
    "sessions",
    "taskRemove",
  );

  if (tasks.length === 0)
    return (
      <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">
        {translateText("chat:tasks.empty")}
      </p>
    );

  return (
    <div className="border-t">
      <ul>
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-1.5 px-2 py-1">
            <button
              type="button"
              title={statusLabel(translateText, task.status)}
              aria-label={statusLabel(translateText, task.status)}
              onClick={() =>
                update.mutate({
                  session: sessionId,
                  id: task.id,
                  status: next(task.status),
                })
              }
              className="flex size-4 shrink-0 items-center justify-center border font-mono text-[9px]"
              data-status={task.status}
            >
              {MARK[task.status]}
            </button>
            <button
              type="button"
              onClick={() => setEditing(task)}
              title={task.content}
              className="min-w-0 flex-1 truncate text-left text-xs hover:underline"
            >
              {task.content}
            </button>
            {/* Taking a task away is the one thing here that cannot be undone by clicking again,
                so it is the one thing drawn in the colour of a warning. */}
            <button
              type="button"
              aria-label={translateText("chat:tasks.remove", {
                content: task.content,
              })}
              title={translateText("chat:tasks.remove", {
                content: task.content,
              })}
              onClick={() => remove.mutate({ session: sessionId, id: task.id })}
              className="flex size-4 shrink-0 items-center justify-center font-mono text-[10px] text-destructive hover:bg-destructive/10"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent className="gap-3 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{translateText("chat:tasks.edit")}</DialogTitle>
          </DialogHeader>
          {editing === null ? null : (
            <TaskForm
              task={editing}
              onSave={(content, status) => {
                update.mutate({
                  session: sessionId,
                  id: editing.id,
                  content,
                  status,
                });
                setEditing(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TaskForm({
  task,
  onSave,
}: {
  task: StoredTask;
  onSave: (content: string, status: TaskStatus) => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [content, setContent] = useState(task.content);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  return (
    <>
      <Textarea
        aria-label={translateText("chat:tasks.content")}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        className="min-h-20"
      />
      <fieldset className="flex flex-wrap gap-1">
        {ORDER.map((one) => (
          <button
            key={one}
            type="button"
            aria-pressed={status === one}
            onClick={() => setStatus(one)}
            className="border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground aria-pressed:border-foreground aria-pressed:text-foreground"
          >
            {statusLabel(translateText, one)}
          </button>
        ))}
      </fieldset>
      <DialogFooter>
        <Button
          onClick={() => onSave(content.trim(), status)}
          disabled={content.trim().length === 0}
        >
          {translateText("common:actions.save")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The word for a status, typed so a template does not have to be. */
function statusLabel(
  translateText: (key: string) => string,
  status: TaskStatus,
): string {
  switch (status) {
    case "pending":
      return translateText("chat:tasks.status.pending");
    case "in_progress":
      return translateText("chat:tasks.status.inProgress");
    case "completed":
      return translateText("chat:tasks.status.completed");
    case "cancelled":
      return translateText("chat:tasks.status.cancelled");
  }
}
