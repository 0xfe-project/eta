import type { ActivityRef } from "@/api/control-plane.gen";
import type { ChatMessage } from "@/queries/chat";
import type { RunStatus } from "@/queries/tasks";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { mentionLabel } from "@/lib/mentions";
import { useOutbox } from "@/queries/outbox";
import { useCommentTask, useUpdateTask } from "@/queries/tasks";
import { frameClass } from "./activity-card";
import { ActivityRefCard } from "./activity-ref";
import { runStatusLabels } from "./task-format";
import { TaskForm } from "./tasks";
import { useGroups } from "./use-groups";
import { usePanelViews, useSectionLink } from "./workspace-search";

export function TaskMessage({ message }: { message: ChatMessage }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "computers",
    "navigation",
  ] as const);
  const [edit, setEdit] = useState(false);
  const [reply, setReply] = useState(false);
  const [body, setBody] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const comment = useCommentTask();
  const update = useUpdateTask();
  const { groups } = useGroups();
  const group = groups.find((g) => g.id === message.group_id);
  const members = group?.participants.filter((p) => p.member) ?? [];
  const sectionLink = useSectionLink();
  // A group chat's panel has no tasks tab.
  const besideChat = usePanelViews().some((tab) => tab.value === "tasks");
  const data = message.data;
  const title = String(
    data.title ?? translateText("navigation:sections.tasks"),
  );
  if (message.kind === "task_draft")
    return (
      <>
        <div
          className={`${frameClass} flex-col items-stretch border-dashed p-3`}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {translateText("draft.title")}
            </span>
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <Button size="xs" variant="outline" onClick={() => setEdit(true)}>
              {translateText("draft.editAndCreate")}
            </Button>
          </div>
          <div className="max-h-52 overflow-y-auto">
            <Markdown>{String(data.description ?? "")}</Markdown>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {translateText("draft.notCreatedHint")}
          </p>
        </div>
        <Dialog open={edit} onOpenChange={setEdit}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{translateText("draft.confirmTitle")}</DialogTitle>
              <DialogDescription>
                {translateText("draft.confirmDescription")}
              </DialogDescription>
            </DialogHeader>
            <TaskForm bare proposal={message} onDone={() => setEdit(false)} />
          </DialogContent>
        </Dialog>
      </>
    );
  const taskId = String(data.task_id);
  if (data.deleted)
    return (
      <p className="border-l pl-3 text-xs text-muted-foreground">
        {translateText("card.deletedSummary", {
          number: Number(data.number),
          title,
        })}
      </p>
    );
  const deliverables = (data.deliverables ?? []) as {
    kind: string;
    title: string;
    url: string;
  }[];
  const artifacts = (data.artifacts ?? []) as {
    artifact_id: string;
    title: string;
    version: number;
  }[];
  const refs: ActivityRef[] = artifacts.map((a) => ({
    kind: "artifact",
    id: a.artifact_id,
    title: a.title,
    number: a.version,
  }));
  return (
    <div className="space-y-1">
      <ActivityRefCard
        value={{
          kind: "task",
          id: taskId,
          number: Number(data.number),
          title,
          status: String(data.status),
        }}
      />
      <div className="px-3 text-xs text-muted-foreground">
        <span>
          {data.assignee === "remote"
            ? translateText("common:format.joinedValues", {
                first: data.computer_name ?? translateText("computers:title"),
                second: data.provider ?? "",
              })
            : data.assignee === "user"
              ? translateText("card.assignedToYou")
              : translateText("assignee.unassigned")}
        </span>
        {data.run_status ? (
          <span> · {runStatusLabels[data.run_status as RunStatus]}</span>
        ) : null}
        {Number(data.comments) > 0 && (
          <span>
            {" "}
            {translateText("card.commentCount", {
              count: Number(data.comments),
            })}
          </span>
        )}
        {data.summary ? (
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap">
            {String(data.summary)}
          </p>
        ) : null}
        {deliverables.map(
          (d) =>
            /^https?:\/\//u.test(d.url) &&
            (d.kind === "pull_request" ? (
              <ActivityRefCard
                key={d.url}
                value={{
                  kind: "pull_request",
                  url: d.url,
                  title: d.title || "PR",
                }}
              />
            ) : (
              <a
                key={d.url}
                className="mt-1 block text-[var(--terminal-link)] hover:underline"
                href={d.url}
                target="_blank"
                rel="noreferrer"
              >
                {d.title || d.url}
              </a>
            )),
        )}
        {refs.map((ref) => (
          <ActivityRefCard key={ref.id} value={ref} className="mt-1" />
        ))}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {data.status === "in_review" && (
            <Button
              variant="outline"
              size="xs"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: taskId, changes: { status: "done" } },
                  { onError: (error) => toast.error(error.message) },
                )
              }
            >
              {translateText("actions.approve")}
            </Button>
          )}
          {besideChat && (
            <Button
              variant="ghost"
              size="xs"
              className="hidden md:inline-flex"
              asChild
            >
              <Link {...sectionLink("tasks", { task: taskId })}>
                {translateText("actions.openInSidebar")}
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            className={besideChat ? "md:hidden" : undefined}
            asChild
          >
            <Link to="/workspace/tasks" search={{ task: taskId }}>
              {translateText("common:actions.openTask")}
            </Link>
          </Button>
          {members.map((p) => (
            <Button
              key={p.agent_id}
              variant="ghost"
              size="xs"
              disabled={group?.archived}
              onClick={() => {
                const outbox = useOutbox.getState();
                outbox.setDraft(message.group_id, [
                  ...(outbox.drafts[message.group_id] ?? []),
                  {
                    type: "text",
                    text: translateText("messages.reviewRequest", {
                      agentName: mentionLabel(p, members),
                      number: Number(data.number),
                      title,
                    }),
                  },
                ]);
              }}
            >
              {translateText("actions.askToReview", { agentName: p.name })}
            </Button>
          ))}
          {data.assignee === "remote" && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-1"
              onClick={() => setReply(true)}
            >
              {translateText("messages.replyToAssignee")}
            </Button>
          )}
        </div>
      </div>
      <Dialog open={reply} onOpenChange={setReply}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translateText("messages.replyTitle", {
                number: Number(data.number),
              })}
            </DialogTitle>
            <DialogDescription>
              {translateText("messages.replyHelp")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={translateText("messages.replyToAssignee")}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setKey(crypto.randomUUID());
            }}
            maxLength={20000}
          />
          <DialogFooter>
            <Button
              disabled={!body.trim() || comment.isPending}
              onClick={() =>
                comment.mutate(
                  { id: taskId, body, key, groupId: message.group_id },
                  {
                    onError: (error) => toast.error(error.message),
                    onSuccess: () => {
                      setReply(false);
                      setBody("");
                      setKey(crypto.randomUUID());
                    },
                  },
                )
              }
            >
              {translateText("common:actions.send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
