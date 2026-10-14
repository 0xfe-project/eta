import type { ActivityOperation } from "@/api/control-plane.gen";

import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { FolderPlusIcon } from "@phosphor-icons/react/FolderPlus";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { HourglassMediumIcon } from "@phosphor-icons/react/HourglassMedium";
import { QuestionIcon } from "@phosphor-icons/react/Question";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { actionClass, frameClass, muted } from "./activity-card";

/**
 * A workspace or worktree an agenvo script made or opened on a remote
 * computer (its block's operations, read from the native calls it made):
 * what, where, and what became of it. AXP has no page for it, so the card
 * opens nothing; it unfolds to show every field whole. The tool line above
 * keeps the script and its output.
 */
const actions = {
  create_workspace: {
    icon: FolderOpenIcon,
    get label() {
      return translate("创建工作区");
    },
    get done() {
      return translate("已创建");
    },
  },
  create_worktree: {
    icon: GitBranchIcon,
    get label() {
      return translate("创建 worktree");
    },
    get done() {
      return translate("已创建");
    },
  },
  open_worktree: {
    icon: GitBranchIcon,
    get label() {
      return translate("打开 worktree");
    },
    get done() {
      return translate("已打开");
    },
  },
  add_project: {
    icon: FolderPlusIcon,
    get label() {
      return translate("添加项目");
    },
    get done() {
      return translate("已添加");
    },
  },
} satisfies Record<ActivityOperation["action"], unknown>;

// Accepted is not done, and an unconfirmed call is not a failure.
const statuses = {
  // Labelled by its action: created, opened, added.
  completed: {
    icon: CheckCircleIcon,
    label: "",
    className: "text-[var(--terminal-success)]",
  },
  accepted: {
    icon: HourglassMediumIcon,
    get label() {
      return translate("已受理，未确认完成");
    },
    className: muted,
  },
  failed: {
    icon: XCircleIcon,
    get label() {
      return translate("失败");
    },
    className: "text-[var(--terminal-error)]",
  },
  unknown: {
    icon: QuestionIcon,
    get label() {
      return translate("结果未确认");
    },
    className: "text-[var(--terminal-warning)]",
  },
} satisfies Record<ActivityOperation["status"], unknown>;

const runtimes = { paseo: "Paseo", herdr: "Herdr" };

export function ActivityOperationCards({
  operations,
  className,
}: {
  operations: ActivityOperation[];
  className?: string;
}) {
  return (
    <ul className={cn("space-y-1", className)}>
      {operations.map((operation, i) => (
        // The calls' order is all that tells them apart.
        // eslint-disable-next-line react/no-array-index-key
        <li key={i}>
          <ActivityOperationCard value={operation} />
        </li>
      ))}
    </ul>
  );
}

function ActivityOperationCard({ value }: { value: ActivityOperation }) {
  const { t: translateText } = useTranslation();
  const [open, setOpen] = useState(false);
  const action = actions[value.action];
  const status = statuses[value.status];
  const statusLabel = value.status === "completed" ? action.done : status.label;
  const name = value.name || value.project || value.path || value.id;
  const where = [value.computer, runtimes[value.runtime]]
    .filter(Boolean)
    .join(" · ");
  const branch = value.branch
    ? value.base
      ? `${value.branch} ← ${value.base}`
      : value.branch
    : undefined;
  const line = cn(
    "min-w-0",
    open ? "break-all whitespace-pre-wrap" : "truncate",
  );
  const StatusIcon = status.icon;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={translateText("{{value1}}{{value2}}，{{value3}}{{value4}}", {
        value1: action.label,
        value2: name ? translateText("：{{value1}}", { value1: name }) : "",
        value3: statusLabel,
        value4: where ? translateText("（{{value1}}）", { value1: where }) : "",
      })}
      onClick={() => setOpen((v) => !v)}
      className={cn(
        frameClass,
        actionClass,
        "w-full flex-col items-stretch gap-0.5",
        value.status !== "completed" && "border-dashed",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <action.icon
          aria-hidden="true"
          className={cn("size-4 shrink-0", muted)}
        />
        <span className={cn(line, "flex-1")}>
          <span className={muted}>{action.label} </span>
          {name ? (
            <span className="text-[var(--terminal-foreground)]">{name}</span>
          ) : null}
        </span>
        <span
          className={cn("flex shrink-0 items-center gap-1", status.className)}
        >
          <StatusIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {statusLabel}
        </span>
        <CaretDownIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            muted,
            open && "rotate-180",
          )}
        />
      </span>
      <span className={cn("pl-6", muted, line)}>
        {[
          where,
          value.project && value.project !== name ? value.project : null,
          branch,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {value.path && value.path !== name ? (
        <span className={cn("pl-6", muted, line)}>{value.path}</span>
      ) : null}
      {value.error ? (
        <span className={cn("pl-6", status.className, line)}>
          {value.error}
        </span>
      ) : null}
      {open && value.id ? (
        <span className={cn("pl-6", muted, line)}>ID {value.id}</span>
      ) : null}
    </button>
  );
}
