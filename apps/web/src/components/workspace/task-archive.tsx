import type { BoardTaskView, TaskArchiveDays } from "@eta/client-contracts";
import type { ArchiveAction } from "./use-archive-action";
import type { TaskActivity, TaskDetail } from "@/queries/tasks";
import {
  archivedEntry,
  DEFAULT_TASK_ARCHIVE_DAYS,
  TASK_ARCHIVE_DAYS,
  unarchivedEntry,
} from "@eta/client-contracts";
import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty } from "@/components/states";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import {
  isArchived,
  useArchivedTasks,
  useBoardSettings,
  useSetBoardSettings,
  useUnarchiveTasks,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { when } from "./routine-format";
import { statusLabel } from "./task-format";
import { useTaskNav } from "./task-nav";
import { filterTasks } from "./task-plan";
import { StatusIcon } from "./task-status-icon";

// Archiving on the page: a task put away from the board's lists (by the host, once it is finished
// and quiet, or by hand from its menu), the line an archived task's page opens with, the view of
// everything archived, and the archived matches a search finds. The host decides what is archived
// and brings a task back on anything new; the page only asks and shows.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

const DAY = 86_400_000;

/* ------------------------------------------------------------------ archive / restore */

/** The question archiving a task that is not finished, or that runs, asks first. */
export function ArchiveDialog({ action }: { action: ArchiveAction }) {
  const { t } = useTranslation(["tasks"] as const);
  const { task, running, below, asking, setAsking, pending, confirm } = action;
  if (task === undefined) return null;
  const status = statusLabel(task.status);
  return (
    <AlertDialog open={asking} onOpenChange={setAsking}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {running
              ? t("archive.confirmRunningTitle", { number: task.number })
              : t("archive.confirmOpenTitle", { number: task.number })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {running
              ? t("archive.confirmRunningDescription", { status })
              : t("archive.confirmOpenDescription", { status })}
            {below > 0
              ? ` ${t("archive.confirmSubtasks", { count: below })}`
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("archive.keep")}</AlertDialogCancel>
          <AlertDialogAction
            variant={running ? "destructive" : "default"}
            disabled={pending}
            onClick={(e) => {
              // Closed once the host has done it, so a refusal is read with the dialog still open.
              e.preventDefault();
              confirm();
            }}
          >
            {running
              ? t("archive.confirmRunningAction")
              : t("archive.confirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The newest `archived` entry of a task: who put it away, and why. */
function lastArchive(task: TaskDetail) {
  const entry = [...task.activity].reverse().find((a) => a.kind === "archived");
  return entry === undefined ? undefined : archivedEntry(entry.data);
}

/** What an archived task's page opens with: when and why it was put away, and the way back. */
export function ArchivedBanner({
  task,
  className,
}: {
  task: TaskDetail;
  className?: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const { agents } = useAgentList();
  const unarchive = useUnarchiveTasks();
  if (!isArchived(task)) return null;
  const read = lastArchive(task);
  const date = when(task.archivedAt!);
  const by = task.archivedBy ?? read?.by ?? "user";
  const text =
    read?.with != null
      ? t("archive.bannerWith", { date, number: read.with.number })
      : by === "auto"
        ? read?.days == null
          ? t("archive.bannerAutoNoDays", { date })
          : t("archive.bannerAuto", { date, days: read.days })
        : by === "user"
          ? t("archive.bannerUser", { date })
          : t("archive.bannerAgent", { date, name: agentName(agents, by) });
  return (
    <div
      role="status"
      data-archived-banner
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border bg-muted/40 px-3 py-2 text-xs",
        className,
      )}
    >
      <ArchiveIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{text}</p>
        <p className="text-muted-foreground">{t("archive.bannerHint")}</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2.5 text-xs"
        disabled={unarchive.isPending}
        onClick={() =>
          unarchive.mutate(
            { taskId: task.id },
            {
              onSuccess: () =>
                toast.success(
                  t("archive.restoredToast", { count: 1, number: task.number }),
                ),
              onError: showError,
            },
          )
        }
      >
        <ArrowCounterClockwiseIcon aria-hidden="true" className="size-3.5" />
        {t("archive.restoreToBoard")}
      </Button>
    </div>
  );
}

/** An `archived` or `unarchived` timeline entry in the reader's words. */
export function ArchiveLine({ a }: { a: TaskActivity }): React.ReactNode {
  if (a.kind === "archived") {
    const read = archivedEntry(a.data);
    if (read.with !== null)
      return translate("tasks:activity.archivedWith", {
        number: read.with.number,
      });
    if (read.reason === "stale")
      return read.days === null
        ? translate("tasks:activity.archivedAutoNoDays")
        : translate("tasks:activity.archivedAuto", { days: read.days });
    return translate("tasks:activity.archivedManual");
  }
  const read = unarchivedEntry(a.data);
  if (read.cause === "manual")
    return read.with === null
      ? translate("tasks:activity.restoredManual")
      : translate("tasks:activity.restoredWith", { number: read.with.number });
  const cause = read.cause.startsWith("run_")
    ? "run"
    : ((["comment", "status", "artifact"] as const).find(
        (c) => c === read.cause,
      ) ?? "other");
  return translate("tasks:activity.restoredBecause", {
    cause: translate(`tasks:activity.causes.${cause}`),
  });
}

/* ------------------------------------------------------------------ on the board */

/** The bar's switch to the archived tasks, with how many there are. */
export function ArchivedToggle({ className }: { className?: string }) {
  const { t } = useTranslation(["tasks"] as const);
  const archived = useArchivedTasks();
  const [nav, setNav] = useTaskNav();
  const on = nav.archived === true;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={on}
      title={t("archive.toggleLabel")}
      onClick={() => void setNav({ archived: on ? null : true })}
      className={cn(
        "h-7 gap-1 px-2 text-xs font-normal text-muted-foreground tabular-nums",
        on && "text-foreground",
        className,
      )}
    >
      <ArchiveIcon aria-hidden="true" className="size-3.5" />
      {t("archive.toggle", { count: archived.length })}
    </Button>
  );
}

/** Under the done column: how many more there are, put away, and the way to them. */
export function ArchivedMore({ count }: { count: number }) {
  const { t } = useTranslation(["tasks"] as const);
  const [, setNav] = useTaskNav();
  if (count === 0) return null;
  return (
    <li>
      <button
        type="button"
        onClick={() => void setNav({ archived: true })}
        className="w-full border border-dashed px-3 py-2 text-left text-xs text-muted-foreground tabular-nums outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        {t("archive.more", { count })}
      </button>
    </li>
  );
}

/** One archived task as a row: what it is, who put it away and when, and the way back. */
function ArchivedRow({
  task,
  selected,
  onSelect,
}: {
  task: BoardTaskView;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const { agents } = useAgentList();
  const [, setNav] = useTaskNav();
  const unarchive = useUnarchiveTasks();
  const by =
    task.archivedBy === "auto"
      ? t("archive.byAuto")
      : task.archivedBy === "user" || task.archivedBy == null
        ? t("archive.byUser")
        : agentName(agents, task.archivedBy);
  return (
    <li className="flex min-h-10 items-center gap-3 border-b px-3 py-1.5 text-sm last:border-b-0 hover:bg-muted/40">
      {onSelect ? (
        <Checkbox
          checked={selected}
          aria-label={t("archive.select", { number: task.number })}
          onCheckedChange={(value) => onSelect(value === true)}
        />
      ) : null}
      <StatusIcon status={task.status} className="size-3.5 shrink-0" />
      <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">
        #{task.number}
      </span>
      <button
        type="button"
        onClick={() => void setNav({ task: task.id })}
        className="min-w-0 flex-1 truncate text-left outline-none hover:underline focus-visible:underline"
      >
        {task.title}
      </button>
      <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
        {by} · {when(task.archivedAt ?? task.updatedAt)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={unarchive.isPending}
        onClick={() =>
          unarchive.mutate(
            { taskId: task.id },
            {
              onSuccess: () =>
                toast.success(
                  t("archive.restoredToast", { count: 1, number: task.number }),
                ),
              onError: showError,
            },
          )
        }
      >
        {t("archive.unarchive")}
      </Button>
    </li>
  );
}

/** Archived this week, or before: the view's two groups. */
function byWeek(tasks: readonly BoardTaskView[], now = Date.now()) {
  const recent = tasks.filter((t) => now - (t.archivedAt ?? 0) < 7 * DAY);
  const earlier = tasks.filter((t) => now - (t.archivedAt ?? 0) >= 7 * DAY);
  return [
    { key: "thisWeek", tasks: recent },
    { key: "earlier", tasks: earlier },
  ] as const;
}

/**
 * Everything archived: grouped by when it was put away, searchable by title or number, restored one
 * by one or several at once.
 */
export function ArchivedView() {
  const { t } = useTranslation(["tasks"] as const);
  const archived = useArchivedTasks();
  const [, setNav] = useTaskNav();
  const unarchive = useUnarchiveTasks();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const shown = useMemo(
    () => filterTasks(archived, { q, who: null, under: null }),
    [archived, q],
  );
  // What is picked and still here: a task that came back on its own is not restored twice.
  const chosen = shown.filter((task) => picked.has(task.id));
  const restore = (ids: string[]) =>
    unarchive.mutate(
      { taskIds: ids },
      {
        onSuccess: ({ tasks }) => {
          setPicked(new Set());
          toast.success(
            t("archive.restoredToast", {
              count: tasks.length,
              number: tasks[0]?.number,
            }),
          );
        },
        onError: showError,
      },
    );
  return (
    <div className="mx-auto flex h-full w-full max-w-content flex-col px-4 py-3 sm:px-6">
      <div className="flex shrink-0 items-center gap-3 pb-3">
        <h2 className="text-sm font-semibold">
          {t("archive.archived")}{" "}
          <span className="font-normal text-muted-foreground tabular-nums">
            {archived.length}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs"
          onClick={() => void setNav({ archived: null })}
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          {t("archive.back")}
        </Button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 border px-2 text-xs text-muted-foreground focus-within:border-foreground/40">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="size-3.5 shrink-0"
          />
          <input
            type="search"
            aria-label={t("archive.search")}
            placeholder={t("archive.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        {chosen.length > 0 ? (
          <Button
            size="sm"
            className="h-8 px-2.5 text-xs"
            disabled={unarchive.isPending}
            onClick={() => restore(chosen.map((task) => task.id))}
          >
            {t("archive.restoreSelected", { count: chosen.length })}
          </Button>
        ) : shown.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2.5 text-xs"
            disabled={unarchive.isPending}
            onClick={() => restore(shown.map((task) => task.id))}
          >
            {t("archive.restoreAll")}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border">
        {archived.length === 0 ? (
          <div className="py-12">
            <Empty icon={ArchiveIcon} title={t("archive.empty")}>
              {t("archive.emptyHint")}
            </Empty>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            {t("archive.noMatch")}
          </p>
        ) : (
          byWeek(shown).map((group) =>
            group.tasks.length === 0 ? null : (
              <section key={group.key} aria-label={t(`archive.${group.key}`)}>
                <h3 className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                  {t(`archive.${group.key}`)}
                </h3>
                <ul>
                  {group.tasks.map((task) => (
                    <ArchivedRow
                      key={task.id}
                      task={task}
                      selected={picked.has(task.id)}
                      onSelect={(on) =>
                        setPicked((was) => {
                          const next = new Set(was);
                          if (on) next.add(task.id);
                          else next.delete(task.id);
                          return next;
                        })
                      }
                    />
                  ))}
                </ul>
              </section>
            ),
          )
        )}
      </div>
    </div>
  );
}

/**
 * What a search on the board finds among the archived tasks: a group of its own, after what is on
 * the board. Nothing while there is no search, or no archived task matches it.
 */
export function ArchivedMatches({
  q,
  onBoard,
}: {
  q: string;
  /** How many of the board's own tasks the search found. */
  onBoard: number;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const archived = useArchivedTasks();
  const found = useMemo(
    () =>
      q.trim() === ""
        ? []
        : filterTasks(archived, { q, who: null, under: null }),
    [archived, q],
  );
  if (found.length === 0) return null;
  return (
    <section
      aria-label={t("archive.inArchive", { count: found.length })}
      data-archived-matches
      className="max-h-[45%] shrink-0 overflow-y-auto border-t bg-background"
    >
      <p className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground tabular-nums sm:px-6">
        {t("archive.onBoard", { count: onBoard })}
      </p>
      <h3 className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground tabular-nums sm:px-6">
        {t("archive.inArchive", { count: found.length })}
      </h3>
      <ul className="sm:px-3">
        {found.map((task) => (
          <ArchivedRow key={task.id} task={task} />
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ the setting */

/** Settings: how long a finished task stays quiet before the host archives it, or never. */
export function TaskArchiveSetting() {
  const { t } = useTranslation(["tasks"] as const);
  const { archiveAfterDays } = useBoardSettings();
  const save = useSetBoardSettings();
  const labelId = useId();
  const choices: { value: TaskArchiveDays | null; label: string }[] = [
    ...TASK_ARCHIVE_DAYS.map((days) => ({
      value: days,
      label:
        days === DEFAULT_TASK_ARCHIVE_DAYS
          ? t("archive.daysDefault", { count: days })
          : t("archive.days", { count: days }),
    })),
    { value: null, label: t("archive.never") },
  ];
  return (
    <div className="mb-6">
      <div className="settings-heading">
        <h2>{t("archive.settingTitle")}</h2>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <div id={labelId}>{t("archive.settingLabel")}</div>
          <p>{t("archive.settingHint")}</p>
        </div>
        <div
          className="settings-control settings-inline"
          role="group"
          aria-labelledby={labelId}
        >
          {choices.map((choice) => (
            <button
              key={String(choice.value)}
              type="button"
              aria-pressed={archiveAfterDays === choice.value}
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  { archiveAfterDays: choice.value },
                  { onError: showError },
                )
              }
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Settings: whether the agent that made a task answers its executor's questions before the user. */
export function TaskAskSetting() {
  const { t } = useTranslation(["tasks"] as const);
  const { autoAnswerAsks } = useBoardSettings();
  const save = useSetBoardSettings();
  return (
    <div className="mb-6">
      <div className="settings-heading">
        <h2>{t("asks.settingTitle")}</h2>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <div>{t("asks.settingLabel")}</div>
          <p>{t("asks.settingHint")}</p>
        </div>
        <div className="settings-control">
          <Switch
            id="task-auto-answer-asks"
            aria-label={t("asks.settingLabel")}
            checked={autoAnswerAsks}
            disabled={save.isPending}
            onCheckedChange={(on) =>
              save.mutate({ autoAnswerAsks: on }, { onError: showError })
            }
          />
        </div>
      </div>
    </div>
  );
}
