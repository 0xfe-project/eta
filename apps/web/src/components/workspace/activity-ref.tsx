import type { ActivityRef } from "@/api/control-plane.gen";
import type { TaskStatus } from "@/queries/tasks";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { NotePencilIcon } from "@phosphor-icons/react/NotePencil";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { statuses } from "./task-format";
import { StatusIcon } from "./task-status-icon";
import { useSectionLink } from "./workspace-search";

/**
 * The card under a tool call that made or touched one thing (its block's
 * ref, which the tool's own result names): the whole card opens it, where
 * the rest of the app does. An issue draft is not a thing yet: its card,
 * dashed, is the action that files it on GitHub. The tool line above keeps
 * the call's details.
 */
const kinds = {
  task: { icon: ListChecksIcon, open: "打开任务" },
  routine: { icon: ClockIcon, open: "打开定时" },
  pull_request: { icon: GitPullRequestIcon, open: "打开 PR" },
  issue_draft: { icon: NotePencilIcon, open: "去 GitHub 创建 issue" },
} satisfies Record<ActivityRef["kind"], unknown>;

const frameClass =
  "flex min-h-11 max-w-md items-stretch border border-[var(--terminal-muted)]/40 sm:min-h-8";
const actionClass =
  "flex min-w-0 items-center gap-2 px-2 py-1 text-left outline-none transition-colors duration-[60ms] ease-linear hover:bg-[var(--terminal-muted)]/10 focus-visible:ring-1 focus-visible:ring-[var(--terminal-link)]/60 motion-reduce:transition-none";
const muted = "text-[var(--terminal-muted)]";
const iconClass = cn("size-3.5 shrink-0", muted);

const taskStatus = (status: string | undefined) =>
  statuses.find((s) => s.value === status);

/** "owner/name" of a page on GitHub. */
function repository(url: string) {
  if (!URL.canParse(url)) return undefined;
  const [, owner, name] = new URL(url).pathname.split("/");
  return owner && name ? `${owner}/${name}` : undefined;
}

export function ActivityRefCard({
  value,
  className,
}: {
  value: ActivityRef;
  className?: string;
}) {
  const sectionLink = useSectionLink();
  const { icon: Icon, open } = kinds[value.kind];
  const status = value.kind === "task" ? taskStatus(value.status) : undefined;
  const repo = value.url ? repository(value.url) : undefined;
  const draft = value.kind === "issue_draft";
  const label = draft
    ? `${open}：${value.title}${repo ? `（${repo}）` : ""}`
    : [open, value.number ? `#${value.number}` : null, value.title || repo]
        .filter(Boolean)
        .join(" ");
  const body = (
    <>
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", muted)} />
      <span className="min-w-0 flex-1 truncate">
        {value.number ? (
          <span className={cn("tabular-nums", muted)}>#{value.number} </span>
        ) : null}
        <span className="text-[var(--terminal-foreground)]">
          {value.title || repo}
        </span>
        {value.title && repo ? <span className={muted}> · {repo}</span> : null}
      </span>
      {status ? (
        <span className={cn("flex shrink-0 items-center gap-1", muted)}>
          <StatusIcon
            status={status.value as TaskStatus}
            className={iconClass}
          />
          {status.label}
        </span>
      ) : null}
      {draft ? (
        <span className="shrink-0 text-[var(--terminal-link)]">
          去 GitHub 创建
        </span>
      ) : null}
      {value.url ? (
        <ArrowSquareOutIcon aria-hidden="true" className={iconClass} />
      ) : (
        <CaretRightIcon aria-hidden="true" className={iconClass} />
      )}
    </>
  );

  if (value.url) {
    return (
      <div className={cn(frameClass, draft && "border-dashed", className)}>
        <a
          href={value.url}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          title={label}
          className={cn(actionClass, "flex-1")}
        >
          {body}
        </a>
        {value.body ? <CopyBody text={value.body} /> : null}
      </div>
    );
  }
  if (!value.id) return null;
  const link =
    value.kind === "task"
      ? sectionLink("tasks", { task: value.id })
      : sectionLink("routines", { routine: value.id });
  return (
    <Link
      {...link}
      aria-label={label}
      title={label}
      className={cn(frameClass, actionClass, className)}
    >
      {body}
    </Link>
  );
}

/** A draft's body when its link was too long to carry it: to paste. */
function CopyBody({ text }: { text: string }) {
  const hint = "正文太长，没放进链接：复制后粘贴到 GitHub";
  return (
    <button
      type="button"
      aria-label={hint}
      title={hint}
      className={cn(
        actionClass,
        "shrink-0 border-l border-dashed border-[var(--terminal-muted)]/40",
        muted,
      )}
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => toast("已复制正文"))
          .catch(() => toast.error("复制失败：浏览器不允许访问剪贴板"))
      }
    >
      <CopyIcon aria-hidden="true" className={iconClass} />
      复制正文
    </button>
  );
}
