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
    return translate("打开");
  },
  get draft() {
    return translate("草稿");
  },
  get merged() {
    return translate("已合并");
  },
  get closed() {
    return translate("已关闭");
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
  const { t: translateText } = useTranslation();
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
              ? translateText("PR 已合并，任务已完成")
              : translateText("任务已完成"),
            { position: "bottom-right" },
          );
        },
        (error: Error) => {
          setUnfinished(
            translateText("PR 已合并，任务未完成：{{value1}}", {
              value1: error.message,
            }),
          );
          toast.error(translateText("PR 已合并，任务未完成"));
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
          else toast.success(translateText("已合并"));
        },
        onError: (error) => {
          const message = unanswered(error)
            ? translateText(
                "没有得到合并结果，已重新读取 PR 状态，请确认后再决定是否重试。",
              )
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
            translateText("读取中…")
          ) : (
            <span title={pull.error?.message}>
              {translateText("状态暂不可用")}
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
                ? translateText("合并中…")
                : translateText("合并")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  className="border-l-primary-foreground/20"
                  disabled={!mergeable || finished}
                  aria-label={translateText("更多合并方式")}
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
                  {translateText("合并并标记任务完成")}
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
            {translateText("标记任务完成")}
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
