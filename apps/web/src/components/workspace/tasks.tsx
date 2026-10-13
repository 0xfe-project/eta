import type { AssigneeDraft } from "./assignee-draft";
import type {
  LogEntry,
  RunStatus,
  Task,
  TaskActivity,
  TaskDetail,
  TaskRun,
  TaskStatus,
} from "@/queries/tasks";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { SpinnerIcon } from "@phosphor-icons/react/Spinner";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  useCommentTask,
  useCreateTask,
  useDeleteTask,
  useInterruptRun,
  useRunLog,
  useTask,
  useTasks,
  useUpdateTask,
} from "@/queries/tasks";
import { ArtifactButton } from "./artifact-dialog";
import {
  draftInput,
  draftOf,
  emptyDraft,
  useDraftPlaces,
} from "./assignee-draft";
import { AssigneeFields } from "./assignee-picker";
import { BackToTop } from "./back-to-top";
import { when } from "./routine-format";
import { Select, SelectOption } from "./select-field";
import { AssistDialog } from "./task-assist";
import { useTaskDraft } from "./task-draft";
import {
  ago,
  assigneeLabel,
  createdBy,
  isActive,
  isPullURL,
  placeLabel,
  providerLabel,
  remoteLabel,
  runStatusLabels,
  statuses,
  statusLabel,
} from "./task-format";
import { useTaskNav } from "./task-nav";
import { DeliveredPull } from "./task-pulls";
import { StatusIcon } from "./task-status-icon";

const showError = (error: Error) => toast.error(error.message);

function Back({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-7 px-2 text-muted-foreground"
      onClick={onClick}
    >
      <ArrowLeftIcon aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * A run underway, by its own status: a spinner while the remote agent starts
 * or works, a clock while it waits its turn. Still under reduced motion; the
 * words carry it either way.
 */
function Working({ status }: { status: RunStatus }) {
  const queued = status === "queued";
  const Icon = queued ? ClockIcon : SpinnerIcon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap",
        queued ? "text-muted-foreground" : "font-medium text-foreground",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-3.5", !queued && "motion-safe:animate-spin")}
      />
      {runStatusLabels[status]}
    </span>
  );
}

// --- list ------------------------------------------------------------------------

/** Done and cancelled start folded: they are the past. */
const folded = new Set<TaskStatus>(["done", "cancelled"]);

/**
 * Whether the task's latest run is underway, or failed. A finished run (the
 * agent replied, asked, or was stopped) shows nothing: the task's status
 * says the rest.
 */
export function RunState({ task }: { task: Task }) {
  if (isActive(task.run_status)) return <Working status={task.run_status} />;
  if (task.run_status === "failed")
    return <span className="text-destructive">运行失败</span>;
  return null;
}

export function Comments({ count }: { count: number }) {
  return count ? (
    <span className="inline-flex items-center gap-1">
      <ChatCircleIcon aria-label="评论" className="size-3.5" />
      {count}
    </span>
  ) : null;
}

/** Title and when on top; number, assignee and activity beneath. */
function TaskRow({ task }: { task: Task }) {
  const [, setNav] = useTaskNav();
  return (
    <li>
      <button
        type="button"
        onClick={() => void setNav({ task: task.id })}
        className="flex w-full items-start gap-2.5 px-2 py-2 text-left transition-colors duration-[60ms] ease-linear outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        <StatusIcon status={task.status} className="mt-0.5" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-sm">
              {task.title}
            </span>
            <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {ago(task.updated_at)}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <span className="shrink-0">#{task.number}</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">
              {assigneeLabel(task.assignee)}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-3 pl-2">
              <RunState task={task} />
              <Comments count={task.comments} />
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

function TaskList() {
  const [, setNav] = useTaskNav();
  const { data, error, refetch } = useTasks();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (status: TaskStatus) => open[status] ?? !folded.has(status);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">任务</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="新建任务"
          title="新建"
          onClick={() => void setNav({ task: "new" })}
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </div>
      {error && !data ? (
        <LoadError what="任务" error={error} onRetry={() => void refetch()} />
      ) : !data ? (
        <Loading />
      ) : data.tasks.length === 0 ? (
        <Empty
          icon={ListChecksIcon}
          title="还没有任务"
          action={
            <Button size="sm" onClick={() => void setNav({ task: "new" })}>
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              新建任务
            </Button>
          }
        >
          把要做的事交给智能体，它会在时间线里记下每一步。
        </Empty>
      ) : (
        statuses.map(({ value, label }) => {
          const group = data.tasks.filter((t) => t.status === value);
          if (!group.length) return null;
          return (
            <section key={value} aria-label={label} className="-mx-2">
              <button
                type="button"
                aria-expanded={isOpen(value)}
                onClick={() => setOpen({ ...open, [value]: !isOpen(value) })}
                className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
              >
                {isOpen(value) ? (
                  <CaretDownIcon aria-hidden="true" className="size-3" />
                ) : (
                  <CaretRightIcon aria-hidden="true" className="size-3" />
                )}
                <StatusIcon status={value} className="size-3.5" />
                {label}
                <span className="tabular-nums">{group.length}</span>
              </button>
              {isOpen(value) ? (
                <ul>
                  {group.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })
      )}
    </div>
  );
}

// --- form ------------------------------------------------------------------------

function Field({
  id,
  label,
  hint,
  children,
}: {
  id?: string;
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function StatusSelect({
  id,
  value,
  onChange,
  className,
}: {
  id?: string;
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
  className?: string;
}) {
  return (
    <Select
      id={id}
      aria-label={id ? undefined : "状态"}
      className={className}
      value={value}
      onValueChange={(value) => onChange(value as TaskStatus)}
    >
      {statuses.map((s) => (
        <SelectOption key={s.value} value={s.value}>
          {s.label}
        </SelectOption>
      ))}
    </Select>
  );
}

/** A new task; `bare` leaves the heading to a dialog around it. */
export function TaskForm({
  onDone,
  bare = false,
  initialStatus = "todo",
}: {
  onDone: (id?: string) => void;
  bare?: boolean;
  initialStatus?: TaskStatus;
}) {
  const create = useCreateTask();
  const { data } = useTasks();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>(initialStatus);
  const [draft, setDraft] = useState<AssigneeDraft>(emptyDraft);
  const places = useDraftPlaces(draft);
  const assignee = draftInput(draft, places);
  const remote = draft.key.startsWith("remote:");
  const noComputers = (data?.assignees.length ?? 0) === 0;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || !assignee) return;
        create.mutate(
          {
            title: title.trim(),
            description: description.trim(),
            status,
            assignee,
          },
          { onSuccess: (task) => onDone(task.id), onError: showError },
        );
      }}
    >
      {bare ? null : (
        <div className="space-y-1">
          <Back label="任务" onClick={() => onDone()} />
          <h2 className="text-sm font-semibold">新建任务</h2>
        </div>
      )}
      <Field id="task-title" label="标题">
        <Input
          id="task-title"
          autoFocus={bare}
          maxLength={200}
          placeholder="例如：修复登录页在 Safari 上的布局"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field
        id="task-description"
        label="描述"
        hint={
          remote
            ? "远程智能体会把它当作任务说明。支持 Markdown。"
            : "支持 Markdown。"
        }
      >
        <Textarea
          id="task-description"
          rows={6}
          maxLength={20000}
          className="max-h-[40dvh] min-h-32 overflow-y-auto"
          placeholder="目标、背景、完成的标准……"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field id="task-status" label="状态">
        <StatusSelect
          id="task-status"
          className="w-full"
          value={status}
          onChange={setStatus}
        />
      </Field>
      <AssigneeFields id="task" draft={draft} onChange={setDraft} />
      {noComputers ? (
        <p className="text-xs text-muted-foreground">
          要让远程电脑上的智能体领任务，先在 设置 → 远程电脑 中接入一台电脑。
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          取消
        </Button>
        <Button
          type="submit"
          disabled={!title.trim() || !assignee || create.isPending}
        >
          {remote && status !== "backlog" ? "创建并开始" : "创建"}
        </Button>
      </div>
    </form>
  );
}

// --- detail: shared pieces ----------------------------------------------------------

/**
 * Long text folds to a few lines with a button to unfold it, so a long
 * description or report does not push everything else off a phone's screen.
 * `actions` sit beside that button.
 */
function Folded({
  children,
  className,
  max = "max-h-48",
  enabled = true,
  actions,
}: {
  children: React.ReactNode;
  className?: string;
  /** The folded height, a max-h-* class. */
  max?: string;
  enabled?: boolean;
  actions?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [enabled, open, children]);
  const folded = enabled && !open;
  return (
    <div className="min-w-0">
      <div
        ref={ref}
        className={cn(
          className,
          folded && [max, "overflow-hidden"],
          folded &&
            long &&
            "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
        )}
      >
        {children}
      </div>
      {(enabled && long) || actions ? (
        <div className="-ml-2 flex flex-wrap items-center">
          {enabled && long ? (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? "收起" : "展开全文"}
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function StopRun({ task, run }: { task: string; run: TaskRun }) {
  const interrupt = useInterruptRun();
  if (run.status !== "running") return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={interrupt.isPending}
      onClick={() =>
        interrupt.mutate({ id: task, run: run.id }, { onError: showError })
      }
    >
      <StopIcon aria-hidden="true" />
      停止
    </Button>
  );
}

/** A run's state: spinning while at work, red when it failed. */
function RunStatusText({ run }: { run: TaskRun }) {
  if (isActive(run.status)) return <Working status={run.status} />;
  return (
    <span
      className={cn(
        "text-xs",
        run.status === "failed" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {runStatusLabels[run.status]}
      {run.error && run.status === "failed" ? `：${run.error}` : ""}
    </span>
  );
}

/** What the task delivered (pull requests, mostly), newest first. */
function deliverables(task: TaskDetail) {
  return task.activity
    .filter((a) => a.kind === "deliverable" && typeof a.data.url === "string")
    .map((a) => ({
      id: a.id,
      url: a.data.url as string,
      title:
        (typeof a.data.title === "string" && a.data.title) ||
        (a.data.url as string).replace("https://github.com/", ""),
    }))
    .reverse();
}

/** A property's name, on the first line of its value. */
const propertyLabel = "text-xs leading-8 text-muted-foreground";

/**
 * What the task is at now: its status, who has it and what it delivered.
 * Each value starts on an 8-high line beside its name; `children` adds rows.
 */
export function TaskProperties({
  task,
  className,
  children,
  onDone,
}: {
  task: TaskDetail;
  className?: string;
  children?: React.ReactNode;
  onDone: () => void;
}) {
  const update = useUpdateTask();
  const links = deliverables(task);
  return (
    <dl
      className={cn(
        "grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm",
        className,
      )}
    >
      <dt className={propertyLabel}>状态</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <StatusIcon status={task.status} />
        <StatusSelect
          className="min-w-32"
          value={task.status}
          onChange={(status) =>
            update.mutate(
              { id: task.id, changes: { status } },
              { onError: showError },
            )
          }
        />
      </dd>
      <dt className={propertyLabel}>指派给</dt>
      <dd className="min-w-0">
        <AssigneeRow task={task} />
      </dd>
      {links.length ? (
        <>
          <dt className={propertyLabel}>交付</dt>
          <dd className="min-w-0">
            <ul>
              {links.map((link) =>
                isPullURL(link.url) ? (
                  <DeliveredPull
                    key={link.id}
                    task={task}
                    url={link.url}
                    title={link.title}
                    onDone={onDone}
                  />
                ) : (
                  <li key={link.id}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-start gap-2 py-1.5 leading-5 underline-offset-4 hover:underline"
                    >
                      <GitPullRequestIcon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0"
                      />
                      <span className="line-clamp-2 min-w-0 wrap-anywhere">
                        {link.title}
                      </span>
                    </a>
                  </li>
                ),
              )}
            </ul>
          </dd>
        </>
      ) : null}
      {children}
    </dl>
  );
}

const commentBoxId = "task-comment";

/** A blocked task's open question: the agent's last word, if it is the last. */
export function Question({ task }: { task: TaskDetail }) {
  if (task.status !== "blocked") return null;
  const last = task.activity.filter((a) => a.kind === "comment").at(-1);
  if (!last || last.actor.kind === "user") return null;
  return (
    <section aria-label="待回复" className="space-y-1 bg-muted px-3 py-2">
      <p className="text-xs">
        <span className="font-medium">{actorName(last)}</span>
        <span className="text-muted-foreground"> 在等你回复</span>
      </p>
      <Folded
        max="max-h-32"
        actions={
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              const box = document.getElementById(commentBoxId);
              box?.scrollIntoView({ block: "center" });
              box?.focus({ preventScroll: true });
            }}
          >
            回复
          </Button>
        }
      >
        <Markdown className="text-sm">{last.body ?? ""}</Markdown>
      </Folded>
    </section>
  );
}

// --- detail: timeline ---------------------------------------------------------------

function actorName(a: TaskActivity) {
  switch (a.actor.kind) {
    case "user":
      return "我";
    case "agent":
      return a.actor.agent_name ?? "智能体";
    case "remote":
      return remoteLabel(a.data as Parameters<typeof remoteLabel>[0]);
  }
  return "AXP";
}

function str(v: unknown) {
  return typeof v === "string" ? v : "";
}

/** One line for an event that is not a comment, or null to leave it out. */
function describe(a: TaskActivity): React.ReactNode {
  const d = a.data;
  switch (a.kind) {
    case "created":
      return "创建了任务";
    case "status":
      return `把状态从「${statusLabel(str(d.from) as TaskStatus)}」改为「${statusLabel(str(d.to) as TaskStatus)}」`;
    case "assignee": {
      const to = d.to as Task["assignee"] | undefined;
      if (!to) return "改了指派";
      const place = placeLabel(to.place);
      return `指派给 ${assigneeLabel(to)}${place ? `，${place}` : ""}`;
    }
    case "title":
      return `把标题改为「${str(d.to)}」`;
    case "description":
      return "修改了描述";
    case "deliverable":
      return (
        <>
          <GitPullRequestIcon
            aria-hidden="true"
            className="mr-1 inline size-3.5 align-[-2px]"
          />
          交付了{" "}
          <a
            href={str(d.url)}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-4"
          >
            {str(d.title) || str(d.url).replace("https://github.com/", "")}
          </a>
        </>
      );
    case "artifact":
      return (
        <>
          <AppWindowIcon
            aria-hidden="true"
            className="mr-1 inline size-3.5 align-[-2px]"
          />
          发布了 Artifact{" "}
          <ArtifactButton
            id={str(d.artifact_id)}
            version={typeof d.version === "number" ? d.version : undefined}
            className="text-foreground underline underline-offset-4"
          >
            {str(d.title) || "Artifact"}
            {typeof d.version === "number" ? ` · 第 ${d.version} 版` : ""}
          </ArtifactButton>
        </>
      );
    case "cleanup":
      return a.body ?? "收尾完成";
    case "assist":
      return `请 ${remoteLabel(d as Parameters<typeof remoteLabel>[0])} 协助`;
    case "run_queued":
      return null;
    case "run_started":
      return "开始工作";
    case "run_completed":
      return "完成了这一轮";
    case "run_nudged":
      return "这一轮结束时没有回复，已提醒一次";
    case "run_failed":
      return (
        <span className="text-destructive">
          这一轮失败了{a.body ? `：${a.body}` : ""}
        </span>
      );
    case "run_cancelled":
      return `这一轮已停止${a.body ? `：${a.body}` : ""}`;
  }
  return a.kind;
}

/** Bookkeeping the task's current state already shows; runs of it fold. */
const minor = new Set<string>([
  "created",
  "title",
  "description",
  "assignee",
  "status",
  "cleanup",
  "run_completed",
  "run_nudged",
]);

/** The timeline's entries: single events, and runs of minor ones. */
function entries(items: TaskActivity[]) {
  const out: (TaskActivity | TaskActivity[])[] = [];
  for (const a of items) {
    const last = out.at(-1);
    if (!minor.has(a.kind)) out.push(a);
    else if (Array.isArray(last)) last.push(a);
    else out.push([a]);
  }
  return out.map((e) => (Array.isArray(e) && e.length === 1 ? e[0] : e));
}

function Time({ at }: { at: string }) {
  return (
    <time
      dateTime={at}
      className="text-xs whitespace-nowrap text-muted-foreground tabular-nums"
    >
      {when(at)}
    </time>
  );
}

/** An event as a line: who, what, when. */
function EventLine({ a, run }: { a: TaskActivity; run?: TaskRun }) {
  // A run's events read as the assignee's; an assisting agent's are named.
  const who = !a.kind.startsWith("run_")
    ? `${actorName(a)} `
    : run?.assist
      ? `${remoteLabel(run)} `
      : null;
  return (
    <p className="text-muted-foreground wrap-anywhere">
      {who}
      {describe(a)} <Time at={a.created_at} />
    </p>
  );
}

const logKindLabels: Record<LogEntry["kind"], string> = {
  user: "指令",
  assistant: "回复",
  tool: "工具",
  reasoning: "思考",
  terminal: "终端",
  // Its file is on the remote computer, out of the relay's reach.
  image: "读取了图片",
  other: "其他",
};

function RunLog({ task, run }: { task: string; run: TaskRun }) {
  const live = isActive(run.status);
  const { entries, error, isPending, hasOlder, loadingOlder, loadOlder } =
    useRunLog(task, run.id, live);
  if (isPending) return <Loading layout="lines" label="正在读取记录…" />;
  // A read that fails keeps what was read before: it says nothing about the run.
  const failed = error ? (
    <p className="text-xs text-destructive">{error.message}</p>
  ) : null;
  if (!entries.length)
    return (
      failed ?? <p className="text-xs text-muted-foreground">还没有记录。</p>
    );
  return (
    <div className="space-y-2">
      {failed}
      {hasOlder ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
        >
          {loadingOlder ? "正在读取更早的记录…" : "加载更早的记录"}
        </Button>
      ) : null}
      <RunLogEntries entries={entries} />
    </div>
  );
}

function RunLogEntries({ entries }: { entries: LogEntry[] }) {
  // Entries can be alike (same time, kind and start): number the repeats.
  const seen = new Map<string, number>();
  const key = (entry: LogEntry) => {
    const base = `${entry.at}-${entry.kind}-${entry.text.slice(0, 32)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}-${n}`;
  };
  return (
    <ol aria-label="执行记录" className="space-y-2 border-l pl-3 text-xs">
      {entries.map((entry) => (
        <li key={key(entry)} className="min-w-0">
          <span className="text-muted-foreground">
            {logKindLabels[entry.kind]}
            {entry.tool ? ` · ${entry.tool}` : ""}
            {entry.status && entry.status !== "completed"
              ? ` · ${entry.status}`
              : ""}
          </span>
          {entry.command ? (
            <pre className="mt-0.5 bg-muted px-2 py-1 font-mono whitespace-pre-wrap wrap-anywhere">
              $ {entry.command}
            </pre>
          ) : null}
          {entry.text && entry.kind !== "image" ? (
            entry.kind === "assistant" || entry.kind === "user" ? (
              <Folded max="max-h-40">
                <Markdown className="mt-0.5 text-xs">{entry.text}</Markdown>
              </Folded>
            ) : (
              <Folded max="max-h-20">
                <pre className="mt-0.5 font-mono whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                  {entry.text}
                </pre>
              </Folded>
            )
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** A run where it started: who, how it went, and its log on demand. */
function RunEntry({
  task,
  run,
  activity,
}: {
  task: TaskDetail;
  run: TaskRun;
  activity: TaskActivity;
}) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground wrap-anywhere">
        {remoteLabel({
          computer_name: run.computer_name,
          runtime: run.runtime,
          provider: run.provider,
        })}{" "}
        {describe(activity)} <Time at={activity.created_at} />
      </p>
      <RunControls task={task} run={run} />
    </div>
  );
}

/** How a run went, stopping it, and its log on demand. */
function RunControls({ task, run }: { task: TaskDetail; run: TaskRun }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="-ml-2 flex flex-wrap items-center gap-x-1">
        <span className="px-2">
          <RunStatusText run={run} />
        </span>
        <StopRun task={task.id} run={run} />
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <CaretDownIcon aria-hidden="true" />
          ) : (
            <CaretRightIcon aria-hidden="true" />
          )}
          执行记录
        </Button>
      </div>
      {run.workspace && open ? (
        <p className="text-xs text-muted-foreground wrap-anywhere">
          工作区 <code>{run.workspace}</code>
        </p>
      ) : null}
      {open ? <RunLog task={task.id} run={run} /> : null}
    </>
  );
}

/**
 * The user's request of an assisting agent: whom (by name only), what, the
 * pull request it was pinned to, and how its run goes.
 */
function AssistEntry({
  task,
  activity,
  run,
}: {
  task: TaskDetail;
  activity: TaskActivity;
  run: TaskRun | undefined;
}) {
  const pull = activity.data.pull as
    | { url?: string; head_sha?: string }
    | null
    | undefined;
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xs wrap-anywhere">
          <span className="font-medium">{actorName(activity)}</span>{" "}
          <span className="text-muted-foreground">{describe(activity)}</span>
        </span>
        <Time at={activity.created_at} />
      </p>
      <Folded max="max-h-40">
        <Markdown className="text-sm">{activity.body ?? ""}</Markdown>
      </Folded>
      {pull?.url ? (
        <p className="text-xs text-muted-foreground wrap-anywhere">
          <GitPullRequestIcon
            aria-hidden="true"
            className="mr-1 inline size-3.5 align-[-2px]"
          />
          <a
            href={pull.url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            {pull.url.replace("https://github.com/", "")}
          </a>
          {pull.head_sha ? (
            <>
              {" "}
              @ <code>{pull.head_sha.slice(0, 7)}</code>
            </>
          ) : (
            "（head 由 Agent 自行确认）"
          )}
        </p>
      ) : null}
      {run ? <RunControls task={task} run={run} /> : null}
    </div>
  );
}

/** Under an assisting agent's answer: ask it more, or pass it on. */
function AssistReplyActions({
  task,
  activity,
}: {
  task: TaskDetail;
  activity: TaskActivity;
}) {
  const [asking, setAsking] = useState(false);
  const setDraft = useTaskDraft((s) => s.setDraft);
  const runtime = str(activity.data.runtime);
  const provider = str(activity.data.provider);
  const remote = task.assignee.kind === "remote";
  return (
    <div className="-ml-2 flex flex-wrap gap-x-1">
      <Button size="xs" variant="ghost" onClick={() => setAsking(true)}>
        追问 {providerLabel(provider)}
      </Button>
      {remote ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            const quote = (activity.body ?? "")
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n");
            setDraft(
              task.id,
              (draft) =>
                `${draft ? `${draft}\n\n` : ""}${actorName(activity)} 的协助结果：\n\n${quote}\n\n`,
            );
            const box = document.getElementById(commentBoxId);
            box?.scrollIntoView({ block: "center" });
            box?.focus({ preventScroll: true });
          }}
        >
          交给主执行者
        </Button>
      ) : null}
      <AssistDialog
        task={task}
        open={asking}
        onOpenChange={setAsking}
        agent={{ runtime, provider }}
      />
    </div>
  );
}

/** Minor events in a row, as one line that unfolds into them. */
function Changes({ items }: { items: TaskActivity[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
      >
        {open ? (
          <CaretDownIcon aria-hidden="true" className="size-3" />
        ) : (
          <CaretRightIcon aria-hidden="true" className="size-3" />
        )}
        {items.length} 条变更
        <span className="ml-1">
          <Time at={items.at(-1)!.created_at} />
        </span>
      </button>
      {open ? (
        <ul className="mt-1 space-y-1">
          {items.map((a) => (
            <li key={a.id}>
              <EventLine a={a} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Entry({
  mark,
  last,
  children,
}: {
  mark: React.ReactNode;
  last: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 pb-4">
      {last ? null : (
        <span
          aria-hidden="true"
          className="absolute top-5 bottom-0 left-[calc(0.5rem-0.5px)] w-px bg-border"
        />
      )}
      <span className="flex h-5 items-center justify-center">{mark}</span>
      <div className="min-w-0 text-sm leading-5">{children}</div>
    </li>
  );
}

const dot = (destructive = false) => (
  <span
    className={cn(
      "size-1.5 bg-muted-foreground/60",
      destructive && "bg-destructive",
    )}
  />
);

/**
 * The task's history: comments in full (long ones folded), runs with their
 * logs on demand, and bookkeeping folded into "N 条变更".
 */
export function Timeline({ task }: { task: TaskDetail }) {
  // Runs show where they started; their queueing is not news.
  const runs = new Map(task.runs.map((r) => [r.id, r]));
  // An assist's run starts and ends where it was asked for.
  const items = entries(
    task.activity.filter(
      (a) =>
        describe(a) !== null &&
        !(
          (a.kind === "run_started" || a.kind === "run_completed") &&
          a.run_id &&
          runs.get(a.run_id)?.assist
        ),
    ),
  );
  return (
    <ol aria-label="时间线">
      {items.map((a, i) => {
        const last = i === items.length - 1;
        if (Array.isArray(a))
          return (
            <Entry key={a[0].id} last={last} mark={dot()}>
              <Changes items={a} />
            </Entry>
          );
        if (a.kind === "comment")
          return (
            <Entry
              key={a.id}
              last={last}
              mark={
                a.actor.kind === "user" ? (
                  <span className="size-2 bg-foreground" />
                ) : (
                  <RobotIcon aria-hidden="true" className="size-3.5" />
                )
              }
            >
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs font-medium wrap-anywhere">
                  {actorName(a)}
                </span>
                <Time at={a.created_at} />
              </p>
              <Folded max="max-h-60" className="mt-1">
                <Markdown className="text-sm">{a.body ?? ""}</Markdown>
              </Folded>
              {a.actor.kind === "remote" && a.data.assist === true ? (
                <AssistReplyActions task={task} activity={a} />
              ) : null}
            </Entry>
          );
        if (a.kind === "assist")
          return (
            <Entry
              key={a.id}
              last={last}
              mark={<span className="size-2 bg-foreground" />}
            >
              <AssistEntry
                task={task}
                activity={a}
                run={a.run_id ? runs.get(a.run_id) : undefined}
              />
            </Entry>
          );
        const run = a.kind === "run_started" && a.run_id && runs.get(a.run_id);
        return (
          <Entry key={a.id} last={last} mark={dot(a.kind === "run_failed")}>
            {run ? (
              <RunEntry task={task} run={run} activity={a} />
            ) : (
              <EventLine
                a={a}
                run={a.run_id ? runs.get(a.run_id) : undefined}
              />
            )}
          </Entry>
        );
      })}
    </ol>
  );
}

// --- detail ---------------------------------------------------------------------------

/** The user's comments on a task with this body, sent or arriving. */
const commentsLike = (task: TaskDetail, body: string) =>
  task.activity.filter(
    (a) => a.kind === "comment" && a.actor.kind === "user" && a.body === body,
  ).length;

/**
 * A comment on its way: out of the box the moment it is sent, so the box is
 * free for the next one, and shown under the timeline until the timeline has
 * it. `key` is its Idempotency-Key, so a retry is the same comment.
 */
interface Outgoing {
  key: string;
  body: string;
  /** How many such comments the task had when it was sent. */
  before: number;
  /** Why it did not arrive; absent while it is being sent. */
  failure?: string;
}

export function CommentBox({ task }: { task: TaskDetail }) {
  const text = useTaskDraft((s) => s.drafts[task.id] ?? "");
  const setDraft = useTaskDraft((s) => s.setDraft);
  const setText = (update: string | ((draft: string) => string)) =>
    setDraft(task.id, update);
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const comment = useCommentTask();
  const [assisting, setAssisting] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const remote = task.assignee.kind === "remote";
  const leftOut = (files: number) => {
    if (files)
      toast.warning(
        `${remote ? "追问" : "评论"}还不能带图片或文件，${files} 个没有加进来。`,
      );
  };
  // Arrived once the task has one more of it, from the response or a refresh:
  // the timeline shows it in the same render this stops showing it.
  const waiting =
    outgoing && commentsLike(task, outgoing.body) <= outgoing.before
      ? outgoing
      : null;
  const deliver = (o: Outgoing) => {
    comment
      .mutateAsync({ id: task.id, body: o.body, key: o.key })
      .catch((error: unknown) => {
        const failure =
          error instanceof ApiError ? error.message : "网络连接失败。";
        // Gone with the task's view: say so, as the box that held it is gone.
        if (!mountedRef.current) {
          toast.error(`${remote ? "追问" : "评论"}未送达：${failure}`);
          return;
        }
        setOutgoing((current) =>
          current?.key === o.key ? { ...current, failure } : current,
        );
      });
  };
  const submit = () => {
    const body = text.trim();
    if (!body || waiting) return;
    const o = {
      key: crypto.randomUUID(),
      body,
      before: commentsLike(task, body),
    };
    setOutgoing(o);
    setText("");
    deliver(o);
  };
  return (
    <>
      {waiting ? (
        <OutgoingComment
          outgoing={waiting}
          onRetry={() => {
            const again = { ...waiting, failure: undefined };
            setOutgoing(again);
            deliver(again);
          }}
          onEdit={() => {
            setOutgoing(null);
            // Ahead of what was written since, which stays.
            setText((draft) =>
              draft ? `${waiting.body}\n${draft}` : waiting.body,
            );
          }}
          onDiscard={() => setOutgoing(null)}
        />
      ) : null}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Textarea
          id={commentBoxId}
          aria-label={remote ? "追问" : "评论"}
          placeholder={
            remote
              ? `追问 ${assigneeLabel(task.assignee)}，支持 Markdown`
              : "写一条评论，支持 Markdown"
          }
          rows={2}
          maxLength={20000}
          className="min-h-16 text-sm md:text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          // A comment is text only: a pasted or dropped file would vanish
          // without a word, so say it stayed out (a paste's text still goes in).
          onPaste={(e) => leftOut(e.clipboardData.files.length)}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            leftOut(e.dataTransfer.files.length);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAssisting(true)}
          >
            <RobotIcon aria-hidden="true" />请 Agent 协助
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!text.trim() || Boolean(waiting)}
          >
            {waiting && !waiting.failure ? (
              <>
                <SpinnerIcon aria-hidden="true" className="animate-spin" />
                发送中…
              </>
            ) : remote ? (
              "发送追问"
            ) : (
              "评论"
            )}
          </Button>
        </div>
      </form>
      <AssistDialog task={task} open={assisting} onOpenChange={setAssisting} />
    </>
  );
}

/** The comment on its way, at the end of the timeline, until it is in it. */
function OutgoingComment({
  outgoing,
  onRetry,
  onEdit,
  onDiscard,
}: {
  outgoing: Outgoing;
  onRetry: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  return (
    <ol aria-label="待发送">
      <Entry
        last
        mark={
          <span
            className={cn(
              "size-2 bg-muted-foreground/60",
              outgoing.failure && "bg-destructive",
            )}
          />
        }
      >
        <div className={cn(!outgoing.failure && "opacity-60")}>
          <Folded max="max-h-60">
            <Markdown className="text-sm">{outgoing.body}</Markdown>
          </Folded>
        </div>
        {outgoing.failure ? (
          <div className="mt-1 space-y-1">
            <p role="alert" className="text-xs text-destructive">
              未送达：{outgoing.failure}
            </p>
            <div className="-ml-2 flex flex-wrap gap-x-1">
              <Button size="xs" variant="ghost" onClick={onRetry}>
                重试
              </Button>
              <Button size="xs" variant="ghost" onClick={onEdit}>
                编辑
              </Button>
              <Button size="xs" variant="ghost" onClick={onDiscard}>
                丢弃
              </Button>
            </div>
          </div>
        ) : (
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            发送中…
          </p>
        )}
      </Entry>
    </ol>
  );
}

export function EditableTitle({
  task,
  className,
}: {
  task: TaskDetail;
  className?: string;
}) {
  const update = useUpdateTask();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  if (!editing)
    return (
      <h2
        className={cn(
          "min-w-0 flex-1 text-base font-semibold wrap-anywhere",
          className,
        )}
      >
        <button
          type="button"
          title="修改标题"
          // Kept in view while the task scrolls, so a long title stays short.
          className="line-clamp-2 cursor-text text-left outline-none focus-visible:underline"
          onClick={() => {
            setTitle(task.title);
            setEditing(true);
          }}
        >
          {task.title}
        </button>
      </h2>
    );
  const save = () => {
    setEditing(false);
    if (title.trim() && title.trim() !== task.title)
      update.mutate(
        { id: task.id, changes: { title: title.trim() } },
        { onError: showError },
      );
  };
  return (
    <Input
      aria-label="标题"
      autoFocus
      className={cn("h-8 flex-1 text-base font-semibold", className)}
      maxLength={200}
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) save();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

/** The task's description; `fold` folds a long one (the side panel). */
export function Description({
  task,
  fold = false,
}: {
  task: TaskDetail;
  fold?: boolean;
}) {
  const update = useUpdateTask();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.description);
  if (editing)
    return (
      <div className="space-y-2">
        <Textarea
          aria-label="描述"
          autoFocus
          rows={8}
          maxLength={20000}
          className="max-h-[60dvh] text-sm md:text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { id: task.id, changes: { description: text } },
                { onSuccess: () => setEditing(false), onError: showError },
              )
            }
          >
            保存
          </Button>
        </div>
      </div>
    );
  const edit = (
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground"
      onClick={() => {
        setText(task.description);
        setEditing(true);
      }}
    >
      <PencilSimpleIcon aria-hidden="true" />
      {task.description.trim() ? "编辑描述" : "添加描述"}
    </Button>
  );
  if (!task.description.trim()) return <div className="-ml-2">{edit}</div>;
  return (
    <Folded
      enabled={fold}
      max="max-h-56"
      className="border-l-2 border-foreground pl-3"
      actions={edit}
    >
      <Markdown className="text-sm">{task.description}</Markdown>
    </Folded>
  );
}

/** The assignee and its place, changed together. */
function AssigneeRow({ task }: { task: TaskDetail }) {
  const update = useUpdateTask();
  const [draft, setDraft] = useState<AssigneeDraft | null>(null);
  const places = useDraftPlaces(draft ?? emptyDraft);
  if (!draft) {
    const place = placeLabel(task.assignee.place);
    return (
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 py-1.5 leading-5 wrap-anywhere">
          {assigneeLabel(task.assignee)}
          {place ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {place}
            </span>
          ) : null}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="mt-0.5 text-muted-foreground"
          onClick={() => setDraft(draftOf(task.assignee))}
        >
          修改
        </Button>
      </div>
    );
  }
  const assignee = draftInput(draft, places);
  return (
    <div className="space-y-2">
      <AssigneeFields id="task-detail" draft={draft} onChange={setDraft} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
          取消
        </Button>
        <Button
          size="sm"
          disabled={!assignee || update.isPending}
          onClick={() =>
            assignee &&
            update.mutate(
              { id: task.id, changes: { assignee } },
              { onSuccess: () => setDraft(null), onError: showError },
            )
          }
        >
          保存
        </Button>
      </div>
    </div>
  );
}

/** A task in the side panel: one column, what matters first. */
function TaskView({ task }: { task: TaskDetail }) {
  const [, setNav] = useTaskNav();
  const remove = useDeleteTask();
  return (
    <>
      <article className="space-y-4">
        {/* Pinned to the panel's edge, over its padding (p-3), as the rest scrolls. */}
        <header className="sticky -top-3 z-10 -mx-3 -mt-3 mb-2 space-y-1 bg-background px-3 pt-3 pb-2">
          <div className="flex items-center justify-between gap-2">
            <Back label="任务" onClick={() => void setNav({ task: null })} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="更多">
                  <DotsThreeIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() =>
                    remove.mutate(task.id, {
                      onSuccess: () => void setNav({ task: null }),
                      onError: showError,
                    })
                  }
                >
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <EditableTitle key={task.title} task={task} />
          <p className="text-xs text-muted-foreground tabular-nums">
            #{task.number} · {createdBy(task)}
          </p>
        </header>
        <TaskProperties
          task={task}
          className="bg-muted/50 px-3 py-2"
          onDone={() => void setNav({ task: null }, { history: "replace" })}
        />
        <Question task={task} />
        <Description key={task.description} task={task} fold />
        <section aria-labelledby="task-activity" className="space-y-3">
          <h3
            id="task-activity"
            className="text-xs font-medium text-muted-foreground"
          >
            动态
          </h3>
          <Timeline task={task} />
          <CommentBox task={task} />
        </section>
      </article>
      <BackToTop />
    </>
  );
}

// --- tab -------------------------------------------------------------------------------

/** Where a task would be: loading, failed, or gone. */
export function TaskMissing({
  isPending,
  error,
  onRetry,
}: {
  isPending: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const gone = error instanceof ApiError && error.status === 404;
  if (error && !gone)
    return <LoadError what="任务" error={error} onRetry={onRetry} />;
  if (isPending) return <Loading layout="detail" />;
  return (
    <Empty icon={ListChecksIcon} title="这个任务已不存在">
      它可能已被删除。
    </Empty>
  );
}

/** The task board: a status-grouped list, a task, or a new one. */
export function Tasks() {
  const [nav, setNav] = useTaskNav();
  const id = nav.task && nav.task !== "new" ? nav.task : null;
  const listRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef(0);
  const detailOpen = Boolean(nav.task);
  useLayoutEffect(() => {
    let area = listRef.current?.parentElement;
    while (
      area &&
      !["auto", "scroll"].includes(getComputedStyle(area).overflowY)
    )
      area = area.parentElement;
    if (!area || detailOpen) return;
    area.scrollTop = listScrollRef.current;
  }, [detailOpen]);
  const { data: task, isPending, error, refetch } = useTask(id);
  return (
    <>
      <div
        ref={listRef}
        hidden={detailOpen}
        onClickCapture={() => {
          let area = listRef.current?.parentElement;
          while (
            area &&
            !["auto", "scroll"].includes(getComputedStyle(area).overflowY)
          )
            area = area.parentElement;
          if (area) listScrollRef.current = area.scrollTop;
        }}
      >
        <TaskList />
      </div>
      {nav.task === "new" ? (
        <TaskForm onDone={(id) => void setNav({ task: id ?? null })} />
      ) : !id ? null : !task ? (
        <div className="space-y-3">
          <Back label="任务" onClick={() => void setNav({ task: null })} />
          <TaskMissing
            isPending={isPending}
            error={error}
            onRetry={() => void refetch()}
          />
        </div>
      ) : (
        <TaskView key={id} task={task} />
      )}
    </>
  );
}
