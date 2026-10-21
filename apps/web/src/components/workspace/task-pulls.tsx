import type { GitHubPull } from "@eta/client-contracts";
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
import { translate } from "@/lib/i18n";
import { WireError } from "@/lib/wire";
import {
  useMergePullRequest,
  usePullRequest,
  useTaskPulls,
} from "@/queries/github";
import { useUpdateTask } from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";

const stateLabels: Record<GitHubPull["state"], string> = {
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
  return (
    error instanceof WireError &&
    (error.code === "timeout" || error.code === "disconnected")
  );
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
  const pull = usePullRequest(url);
  const merge = useMergePullRequest();
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
      .mutateAsync({ taskId: task.id, status: "done" })
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
              message: wireErrorMessage(error),
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
      { url, headSha: data.headSha },
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
            : wireErrorMessage(error);
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
            <span title={pull.error ? wireErrorMessage(pull.error) : undefined}>
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

/** What a property's name looks like in the task's properties (`TaskProperties`). */
const propertyLabel = "text-xs leading-8 text-muted-foreground";

/**
 * The pull requests the task delivered, as a row of its properties: a link to each, its state on
 * GitHub, and merging it. Nothing when the task has none, or the host has no GitHub: the whole row
 * (its label with it) is left out, so a task of a host without GitHub does not show an empty
 * "delivery" property waiting for a pull request.
 */
export function TaskPulls({ task }: { task: TaskDetail }) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const pulls = useTaskPulls(task.id);
  if (pulls.length === 0) return null;
  return (
    <>
      <dt className={propertyLabel}>{translateText("details.deliveryTab")}</dt>
      <dd className="min-w-0">
        <ul>
          {pulls.map((pull) => (
            <DeliveredPull
              key={pull.url}
              task={task}
              url={pull.url}
              title={pull.title}
              onDone={() => undefined}
            />
          ))}
        </ul>
      </dd>
    </>
  );
}
