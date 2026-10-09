import type { AssigneeDraft } from "./assignee-draft";
import type {
  LogEntry,
  Task,
  TaskActivity,
  TaskDetail,
  TaskRun,
  TaskStatus,
} from "@/queries/tasks";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectOption } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSendMessage } from "@/queries/chat";
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
import {
  draftInput,
  draftOf,
  emptyDraft,
  useDraftPlaces,
} from "./assignee-draft";
import { AssigneeFields } from "./assignee-picker";
import { when } from "./routine-format";
import {
  ago,
  assigneeLabel,
  isActive,
  placeLabel,
  remoteLabel,
  runStatusLabels,
  statuses,
  statusLabel,
} from "./task-format";
import { useTaskNav } from "./task-nav";
import { StatusIcon } from "./task-status-icon";
import { useAgents } from "./use-agents";
import { useWorkspaceStore } from "./workspace-store";

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

/** A remote agent at work: a pulsing square, like a running routine. */
function Working({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
      <span className="size-1.5 bg-foreground motion-safe:animate-pulse" />
      {label}
    </span>
  );
}

// --- list ------------------------------------------------------------------------

/** Done and cancelled start folded: they are the past. */
const folded = new Set<TaskStatus>(["done", "cancelled"]);

/** Whether the task's agent is at work, or its last run failed. */
export function RunState({ task }: { task: Task }) {
  if (isActive(task.run_status)) return <Working />;
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

export function StatusSelect({
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
          className="min-h-32"
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
        <span className="inline-flex flex-wrap items-center gap-x-1">
          <GitPullRequestIcon aria-hidden="true" />
          交付了{" "}
          <a
            href={str(d.url)}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            {str(d.title) || str(d.url).replace("https://github.com/", "")}
          </a>
        </span>
      );
    case "cleanup":
      return a.body ?? "收尾完成";
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

const logKindLabels: Record<LogEntry["kind"], string> = {
  user: "指令",
  assistant: "回复",
  tool: "工具",
  reasoning: "思考",
  terminal: "终端",
  other: "其他",
};

function RunLog({ task, run }: { task: string; run: TaskRun }) {
  const live = isActive(run.status);
  const { data, error, isPending } = useRunLog(task, run.id, live);
  if (isPending) return <Loading layout="lines" label="正在读取记录…" />;
  if (error) return <p className="text-xs text-destructive">{error.message}</p>;
  if (!data?.length)
    return <p className="text-xs text-muted-foreground">还没有记录。</p>;
  return (
    <ol className="max-h-96 space-y-1.5 overflow-y-auto border-l pl-3 text-xs">
      {data.map((entry) => (
        <li
          key={`${entry.at}-${entry.kind}-${entry.text.slice(0, 32)}`}
          className="min-w-0"
        >
          <span className="text-muted-foreground">
            {logKindLabels[entry.kind]}
            {entry.tool ? ` · ${entry.tool}` : ""}
            {entry.status && entry.status !== "completed"
              ? ` · ${entry.status}`
              : ""}
          </span>
          {entry.command ? (
            <pre className="mt-0.5 overflow-x-auto bg-muted px-2 py-1 font-mono whitespace-pre-wrap">
              $ {entry.command}
            </pre>
          ) : null}
          {entry.text ? (
            entry.kind === "assistant" || entry.kind === "user" ? (
              <Markdown className="mt-0.5 text-xs">{entry.text}</Markdown>
            ) : (
              <pre className="mt-0.5 max-h-48 overflow-auto font-mono whitespace-pre-wrap text-muted-foreground">
                {entry.text}
              </pre>
            )
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function RunEntry({
  task,
  run,
  activity,
}: {
  task: TaskDetail;
  run: TaskRun;
  activity: TaskActivity;
}) {
  const [open, setOpen] = useState(false);
  const interrupt = useInterruptRun();
  const active = isActive(run.status);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground">
          {remoteLabel({
            computer_name: run.computer_name,
            runtime: run.runtime,
            provider: run.provider,
          })}{" "}
          {describe(activity)}
        </span>
        {active ? (
          <Working label={runStatusLabels[run.status]} />
        ) : (
          <span
            className={cn(
              "text-xs",
              run.status === "failed"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {runStatusLabels[run.status]}
            {run.error && run.status === "failed" ? `：${run.error}` : ""}
          </span>
        )}
        <span className="ml-auto flex items-center">
          {run.status === "running" ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={interrupt.isPending}
              onClick={() =>
                interrupt.mutate(
                  { id: task.id, run: run.id },
                  { onError: showError },
                )
              }
            >
              <StopIcon aria-hidden="true" />
              停止
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "收起记录" : "执行记录"}
          </Button>
        </span>
      </div>
      {run.workspace && open ? (
        <p className="text-xs text-muted-foreground">
          工作区 <code>{run.workspace}</code>
        </p>
      ) : null}
      {open ? <RunLog task={task.id} run={run} /> : null}
    </div>
  );
}

function Entry({
  mark,
  at,
  last,
  children,
}: {
  mark: React.ReactNode;
  at: string;
  last: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="relative grid grid-cols-[1rem_1fr] gap-x-2 pb-3">
      {last ? null : (
        <span
          aria-hidden="true"
          className="absolute top-4 bottom-0 left-[calc(0.5rem-0.5px)] w-px bg-border"
        />
      )}
      <span className="flex h-5 items-center justify-center">{mark}</span>
      <div className="min-w-0 text-sm leading-5">
        {children}
        <span className="block text-xs text-muted-foreground tabular-nums">
          {when(at)}
        </span>
      </div>
    </li>
  );
}

export function Timeline({ task }: { task: TaskDetail }) {
  // Runs show where they started; their queueing is not news.
  const items = task.activity.filter((a) => describe(a) !== null);
  const runs = new Map(task.runs.map((r) => [r.id, r]));
  return (
    <ol aria-label="时间线">
      {items.map((a, i) => {
        const last = i === items.length - 1;
        if (a.kind === "comment")
          return (
            <Entry
              key={a.id}
              at={a.created_at}
              last={last}
              mark={
                a.actor.kind === "user" ? (
                  <span className="size-2 bg-foreground" />
                ) : (
                  <RobotIcon aria-hidden="true" className="size-3.5" />
                )
              }
            >
              <div className="border bg-background px-3 py-2">
                <p className="mb-1 text-xs font-medium">{actorName(a)}</p>
                <Markdown className="text-sm">{a.body ?? ""}</Markdown>
              </div>
            </Entry>
          );
        const run = a.kind === "run_started" && a.run_id && runs.get(a.run_id);
        return (
          <Entry
            key={a.id}
            at={a.created_at}
            last={last}
            mark={
              <span
                className={cn(
                  "size-1.5 bg-muted-foreground/60",
                  a.kind === "run_failed" && "bg-destructive",
                )}
              />
            }
          >
            {run ? (
              <RunEntry task={task} run={run} activity={a} />
            ) : (
              <p className="text-muted-foreground">
                {a.kind.startsWith("run_") ? null : `${actorName(a)} `}
                {describe(a)}
              </p>
            )}
          </Entry>
        );
      })}
    </ol>
  );
}

// --- detail ---------------------------------------------------------------------------

export function CommentBox({ task }: { task: TaskDetail }) {
  const [text, setText] = useState("");
  const comment = useCommentTask();
  const remote = task.assignee.kind === "remote";
  const submit = () => {
    const body = text.trim();
    if (!body || comment.isPending) return;
    comment.mutate(
      { id: task.id, body },
      { onSuccess: () => setText(""), onError: showError },
    );
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label="评论"
        placeholder={
          remote
            ? "评论会作为追问发给远程智能体……"
            : "写一条评论，支持 Markdown"
        }
        rows={3}
        maxLength={20000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {remote ? `${assigneeLabel(task.assignee)} 会收到这条评论` : null}
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={!text.trim() || comment.isPending}
        >
          评论
        </Button>
      </div>
    </form>
  );
}

/** Ask one of the AXP agents to look at the task and give feedback on it. */
export function FeedbackDialog({
  task,
  open,
  onOpenChange,
}: {
  task: TaskDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { agents } = useAgents();
  const send = useSendMessage();
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  const [agentId, setAgentId] = useState<string>("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [note, setNote] = useState("");
  const chosen = agentId || agents.at(-1)?.id || "";
  const text = [
    `请看一下任务 #${task.number}「${task.title}」，读它的描述和时间线（get_task），然后用 comment_task 在任务下给出你的反馈。`,
    note.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>让智能体反馈</DialogTitle>
          <DialogDescription>
            给一个 AXP 智能体发一条消息，请它审阅这个任务，并在任务下评论。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field id="feedback-agent" label="智能体">
            <Select
              id="feedback-agent"
              className="w-full"
              value={chosen}
              onValueChange={(value) => setAgentId(value)}
            >
              {agents.map((agent) => (
                <SelectOption key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectOption>
              ))}
            </Select>
          </Field>
          <Field
            label="方式"
            hint={
              mode === "queue"
                ? "排在它手头的工作之后。"
                : "插进它正在进行的这一轮。"
            }
          >
            <div role="radiogroup" aria-label="方式" className="flex gap-1">
              {(["queue", "steer"] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  size="sm"
                  variant={mode === m ? "default" : "outline"}
                  onClick={() => setMode(m)}
                >
                  {m === "queue" ? "排队（queue）" : "插话（steer）"}
                </Button>
              ))}
            </div>
          </Field>
          <Field id="feedback-note" label="补充（可选）">
            <Textarea
              id="feedback-note"
              rows={2}
              maxLength={4000}
              placeholder="例如：重点看测试是否覆盖了边界情况"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button
            disabled={!chosen || send.isPending}
            onClick={() =>
              send.mutate(
                { agentId: chosen, text, mode },
                {
                  onSuccess: () => {
                    const name = agents.find((a) => a.id === chosen)?.name;
                    toast(`已发给${name ?? "智能体"}`);
                    onOpenChange(false);
                    setNote("");
                    setMobilePanel("chat");
                  },
                  onError: showError,
                },
              )
            }
          >
            发送
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
          "min-w-0 flex-1 cursor-text text-base font-semibold break-words",
          className,
        )}
        onClick={() => {
          setTitle(task.title);
          setEditing(true);
        }}
      >
        {task.title}
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

export function Description({ task }: { task: TaskDetail }) {
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
  return (
    <button
      type="button"
      onClick={() => {
        setText(task.description);
        setEditing(true);
      }}
      className="block w-full border-l-2 border-foreground pl-3 text-left outline-none focus-visible:bg-muted/60"
    >
      {task.description.trim() ? (
        <Markdown className="text-sm">{task.description}</Markdown>
      ) : (
        <span className="text-sm text-muted-foreground">添加描述…</span>
      )}
    </button>
  );
}

/** The assignee and its place, changed together. */
export function AssigneeRow({ task }: { task: TaskDetail }) {
  const update = useUpdateTask();
  const [draft, setDraft] = useState<AssigneeDraft | null>(null);
  const places = useDraftPlaces(draft ?? emptyDraft);
  if (!draft) {
    const place = placeLabel(task.assignee.place);
    return (
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          {assigneeLabel(task.assignee)}
          {place ? (
            <span className="block text-muted-foreground">{place}</span>
          ) : null}
        </span>
        <Button
          size="xs"
          variant="ghost"
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

function TaskView({ task }: { task: TaskDetail }) {
  const [, setNav] = useTaskNav();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const [feedback, setFeedback] = useState(false);
  const change = (changes: Parameters<typeof update.mutate>[0]["changes"]) =>
    update.mutate({ id: task.id, changes }, { onError: showError });
  return (
    <div className="space-y-4">
      <div>
        <Back label="任务" onClick={() => void setNav({ task: null })} />
        <div className="flex items-start gap-2">
          <span className="pt-0.5 text-sm text-muted-foreground tabular-nums">
            #{task.number}
          </span>
          <EditableTitle key={task.title} task={task} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="更多">
                <DotsThreeIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setFeedback(true)}>
                让智能体反馈
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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
        <p className="text-xs text-muted-foreground">
          {task.created_by.kind === "agent"
            ? `由 ${task.created_by.agent_name ?? "智能体"} 创建`
            : "由我创建"}{" "}
          · {when(task.created_at)}
        </p>
      </div>

      <dl className="grid grid-cols-[4rem_1fr] items-center gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">状态</dt>
        <dd className="flex items-center gap-2">
          <StatusIcon status={task.status} />
          <StatusSelect
            className="flex-1"
            value={task.status}
            onChange={(status) => change({ status })}
          />
        </dd>
        <dt className="self-start pt-1 text-muted-foreground">指派给</dt>
        <dd>
          <AssigneeRow task={task} />
        </dd>
      </dl>

      <Description key={task.description} task={task} />

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setFeedback(true)}>
          <RobotIcon aria-hidden="true" />
          让智能体反馈
        </Button>
      </div>

      <Timeline task={task} />
      <CommentBox task={task} />
      <FeedbackDialog task={task} open={feedback} onOpenChange={setFeedback} />
    </div>
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
  const { data: task, isPending, error, refetch } = useTask(id);
  if (nav.task === "new")
    return <TaskForm onDone={(id) => void setNav({ task: id ?? null })} />;
  if (!id) return <TaskList />;
  if (!task)
    return (
      <div className="space-y-3">
        <Back label="任务" onClick={() => void setNav({ task: null })} />
        <TaskMissing
          isPending={isPending}
          error={error}
          onRetry={() => void refetch()}
        />
      </div>
    );
  return <TaskView task={task} />;
}
