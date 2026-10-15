import type { ActivityRef } from "@/api/control-plane.gen";
import type { TaskStatus } from "@/queries/tasks";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { NotePencilIcon } from "@phosphor-icons/react/NotePencil";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { actionClass, frameClass, muted } from "./activity-card";
import { ArtifactButton } from "./artifact-dialog";
import { statuses } from "./task-format";
import { StatusIcon } from "./task-status-icon";
import { useSectionLink } from "./workspace-search";

/**
 * The card under a tool call that made or touched one thing (its block's
 * ref, which the tool's own result names): the whole card opens it, where
 * the rest of the app does. An issue draft is not a thing yet: its card,
 * dashed, is the action that files it on GitHub. An artifact's card opens
 * the version the tool published in a dialog. The tool line above keeps
 * the call's details.
 */
const kinds = {
  task: {
    icon: ListChecksIcon,
    get open() {
      return translate("common:actions.openTask");
    },
  },
  routine: {
    icon: ClockIcon,
    get open() {
      return translate("common:actions.openRoutine");
    },
  },
  pull_request: {
    icon: GitPullRequestIcon,
    get open() {
      return translate("common:actions.openPullRequest");
    },
  },
  issue_draft: {
    icon: NotePencilIcon,
    get open() {
      return translate("connections:github.createIssue");
    },
  },
  artifact: {
    icon: AppWindowIcon,
    get open() {
      return translate("artifacts:actions.open");
    },
  },
} satisfies Record<ActivityRef["kind"], unknown>;

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
  const { t: translateText } = useTranslation([
    "common",
    "artifacts",
    "connections",
  ] as const);
  const sectionLink = useSectionLink();
  const { icon: Icon, open } = kinds[value.kind];
  const status = value.kind === "task" ? taskStatus(value.status) : undefined;
  const repo = value.url ? repository(value.url) : undefined;
  const draft = value.kind === "issue_draft";
  // An artifact's number is its version, not an id to show first.
  const artifact = value.kind === "artifact";
  const number = value.number && !artifact ? value.number : undefined;
  const label = draft
    ? translateText("format.referenceSummary", {
        action: open,
        title: value.title,
        repositoryHint: repo
          ? translateText("format.parenthesizedSuffix", { value: repo })
          : "",
      })
    : [
        open,
        number ? `#${number}` : null,
        value.title || repo,
        artifact && value.number
          ? translateText("artifacts:version.label", { version: value.number })
          : null,
      ]
        .filter(Boolean)
        .join(" ");
  const body = (
    <>
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", muted)} />
      <span className="min-w-0 flex-1 truncate">
        {number ? (
          <span className={cn("tabular-nums", muted)}>#{number} </span>
        ) : null}
        <span className="text-[var(--terminal-foreground)]">
          {value.title || repo}
        </span>
        {value.title && repo ? <span className={muted}> · {repo}</span> : null}
        {artifact && value.number ? (
          <span className={cn("tabular-nums", muted)}>
            {translateText("artifacts:version.inlineLabel", {
              version: value.number,
            })}
          </span>
        ) : null}
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
          {translateText("connections:github.createOnGitHub")}
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
  if (artifact)
    return (
      <div className={cn(frameClass, className)}>
        <ArtifactButton
          id={value.id}
          version={value.number}
          aria-label={label}
          title={label}
          className={cn(actionClass, "flex-1")}
        >
          {body}
        </ArtifactButton>
      </div>
    );
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
  const { t: translateText } = useTranslation([
    "common",
    "artifacts",
    "connections",
  ] as const);
  const hint = translateText("connections:github.issueDraft.bodyTooLong");
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
          .then(() =>
            toast(translateText("connections:github.issueDraft.bodyCopied")),
          )
          .catch(() => toast.error(translateText("errors.clipboardBlocked")))
      }
    >
      <CopyIcon aria-hidden="true" className={iconClass} />
      {translateText("connections:github.issueDraft.copyBody")}
    </button>
  );
}
