import type { PullRequest } from "@/queries/forge";
import type { TaskDetail } from "@/queries/tasks";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError } from "@/lib/api";
import { translate } from "@/lib/i18n";
import { useMergePullRequest, usePullRequest } from "@/queries/forge";
import { useUpdateTask } from "@/queries/tasks";

const stateLabels: Record<PullRequest["state"], string> = {
  get open() {
    return translate("common:actions.open");
  },
  get draft() {
    return translate("tasks:pullRequests.status.draft");
  },
  get merged() {
    return translate("tasks:pullRequests.status.merged");
  },
  get closed() {
    return translate("tasks:pullRequests.status.closed");
  },
};

/** A merge that got no answer at all (the pull request is read again). */
function unanswered(error: Error) {
  return !(error instanceof ApiError) || error.code === "UNKNOWN";
}

/**
 * A pull request the task delivered: a link to it, its state and size on
 * GitHub now, and merging it. Merging and completing the task are two
 * steps: the task is marked done only after GitHub merged, and a task that
 * failed to complete can be completed again without merging again.
 */
export function DeliveredPull({
  task,
  url,
  title,
  onDone,
}: {
  task: TaskDetail;
  url: string;
  title: string;
  onDone: () => void;
}) {
  const { t: translateText } = useTranslation(["tasks", "common"] as const);
  const pull = usePullRequest(task.id, url);
  const merge = useMergePullRequest(task.id);
  const update = useUpdateTask();
  const [unfinished, setUnfinished] = useState<string | null>(null);
  // Set at once, before isPending: a second click in the same tick is not
  // a second merge.
  const mergingRef = useRef(false);
  const completingRef = useRef(false);
  const mergedHereRef = useRef(false);
  const finished = task.status === "done" || task.status === "cancelled";
  const data = pull.data;

  const complete = () => {
    if (completingRef.current || finished) return;
    completingRef.current = true;
    void update
      .mutateAsync({ id: task.id, changes: { status: "done" } })
      .then(
        () => {
          setUnfinished(null);
          onDone();
          toast.success(
            mergedHereRef.current
              ? translateText("pullRequests.mergedAndCompleted")
              : translateText("feedback.completed"),
            { position: "bottom-right" },
          );
        },
        (error: Error) => {
          setUnfinished(
            translateText("pullRequests.mergedTaskIncompleteWithError", {
              message: error.message,
            }),
          );
          toast.error(translateText("pullRequests.mergedTaskIncomplete"));
        },
      )
      .finally(() => {
        completingRef.current = false;
      });
  };
  const mergeIt = (andComplete: boolean) => {
    if (
      !data ||
      mergingRef.current ||
      completingRef.current ||
      data.merge !== "ready"
    )
      return;
    mergingRef.current = true;
    merge.mutate(
      { url, headSha: data.head_sha },
      {
        onSettled: () => {
          mergingRef.current = false;
        },
        onSuccess: () => {
          mergedHereRef.current = true;
          setUnfinished(null);
          if (andComplete) complete();
          else toast.success(translateText("pullRequests.status.merged"));
        },
        onError: (error) => {
          const message = unanswered(error)
            ? translateText("pullRequests.mergeResultUnknown")
            : error.message;
          setUnfinished(message);
          toast.error(message);
        },
      },
    );
  };

  const busy = merge.isPending || update.isPending;
  const mergeable = data?.merge === "ready" && !busy;
  return (
    <li className="py-1.5">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="flex items-start gap-2 leading-5 underline-offset-4 hover:underline"
      >
        <GitPullRequestIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0"
        />
        <span className="line-clamp-2 min-w-0 wrap-anywhere">{title}</span>
      </a>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1 pl-6">
        <span className="text-xs text-muted-foreground tabular-nums">
          {data ? (
            <>
              {stateLabels[data.state]}{" "}
              <span className="text-success">+{data.additions}</span>{" "}
              <span className="text-destructive">−{data.deletions}</span>
            </>
          ) : pull.isPending ? (
            translateText("common:states.reading")
          ) : (
            <span title={pull.error?.message}>
              {translateText("pullRequests.status.unavailable")}
            </span>
          )}
        </span>
        {data && data.merge ? (
          <div className="flex">
            <Button
              size="sm"
              disabled={!mergeable}
              aria-busy={merge.isPending}
              onClick={() => mergeIt(false)}
            >
              {merge.isPending
                ? translateText("pullRequests.merging")
                : translateText("pullRequests.actions.merge")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  className="border-l-primary-foreground/20"
                  disabled={!mergeable || finished}
                  aria-label={translateText(
                    "pullRequests.actions.moreMergeOptions",
                  )}
                >
                  <CaretDownIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              {/* As wide as its option, not the icon trigger, within the viewport. */}
              <DropdownMenuContent
                align="end"
                className="w-max max-w-(--radix-dropdown-menu-content-available-width)"
              >
                <DropdownMenuItem onSelect={() => mergeIt(true)}>
                  {translateText("pullRequests.actions.mergeAndComplete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : data?.state === "merged" && !finished ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={complete}
          >
            {translateText("actions.complete")}
          </Button>
        ) : null}
      </div>
      {unfinished && !finished ? (
        <p role="alert" className="pl-6 text-xs text-destructive">
          {unfinished}
        </p>
      ) : data?.merge && data.merge !== "ready" && data.reason ? (
        <p className="pl-6 text-xs text-muted-foreground">{data.reason}</p>
      ) : null}
    </li>
  );
}
