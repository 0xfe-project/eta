import type {
  RunStatus,
  Task,
  TaskActivity,
  TaskDetail,
  TaskRun,
  TaskStatus,
} from "@/queries/tasks";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/PaperPlaneRight";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { SpinnerIcon } from "@phosphor-icons/react/Spinner";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { UserIcon } from "@phosphor-icons/react/User";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { applyItem, buildMenu } from "@/lib/composer-menu";
import { translate } from "@/lib/i18n";
import { mentionedMembers, mentionLabel } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { useAgentList } from "@/queries/agents";
import { useConversationList } from "@/queries/conversations";
import { useTaskPulls } from "@/queries/github";
import {
  useCommentTask,
  useConfirmTaskDraft,
  useDeleteTask,
  useInterruptRun,
  useRerunTask,
  useTask,
  useTasks,
  useUpdateTask,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { AgentAvatar } from "./agent-identity";
import { ArtifactButton } from "./artifact-dialog";
import { when } from "./routine-format";
import { Select, SelectOption } from "./select-field";
import { useTaskDraft } from "./task-draft";
import {
  actorName,
  ago,
  isActive,
  queueReasonLabels,
  runStatusLabels,
  statuses,
  statusLabel,
  workspaceLabel,
} from "./task-format";
import { useTaskNav } from "./task-nav";
import { TaskPulls } from "./task-pulls";
import { RunLog } from "./task-run-log";
import { StatusIcon } from "./task-status-icon";
import { SlashMenu } from "./transcript/slash-menu";
import { useGroups } from "./use-groups";

const showError = (error: Error) => toast.error(wireErrorMessage(error));

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

// --- list ------------------------------------------------------------------------

/** Done and cancelled start folded: they are the past. */
const folded = new Set<TaskStatus>(["done", "cancelled"]);

/**
 * A run underway, by its own status: a spinner while the executor starts or works, a clock while
 * it waits its turn. Still under reduced motion; the words carry it either way.
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

/**
 * Whether the task's latest run is underway, or failed. A finished run shows nothing: the task's
 * status says the rest.
 */
export function RunState({ task }: { task: Task }) {
  useTranslation(["tasks", "common"] as const);
  if (isActive(task.runStatus)) return <Working status={task.runStatus} />;
  if (task.runStatus === "failed")
    return <span className="text-destructive">{runStatusLabels.failed}</span>;
  return null;
}

export function Comments({ count }: { count: number }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  return count ? (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <ChatCircleIcon
        aria-label={translateText("comments.title")}
        className="size-3.5"
      />
      {count}
    </span>
  ) : null;
}

/** Title and when on top; number, executor and activity beneath. */
function TaskRow({ task }: { task: Task }) {
  useTranslation(["tasks", "common", "navigation"] as const);
  const [, setNav] = useTaskNav();
  const { agents } = useAgentList();
  return (
    <li>
      <button
        type="button"
        onClick={() => void setNav({ task: task.id })}
        className="flex w-full items-start gap-2.5 px-2 py-2 text-left duration-[60ms] ease-linear outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        <StatusIcon status={task.status} className="mt-0.5" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-sm">
              {task.title}
            </span>
            <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {ago(task.updatedAt)}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <span className="shrink-0">#{task.number}</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">
              {actorName(task.createdBy, agents)}
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
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const { tasks: all, loaded, error } = useTasks();
  const { current: group } = useGroups();
  // A task is work in a conversation; the board opens on that conversation rather than on
  // everything at once. "All groups" is still one click away.
  const [scope, setScope] = useState<"group" | "all">("group");
  const tasks =
    scope === "group" && group !== undefined
      ? all.filter((task) => task.conversationId === group.id)
      : all;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (status: TaskStatus) => open[status] ?? !folded.has(status);
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">
        {translateText("navigation:sections.tasks")}
      </h2>
      {group === undefined ? null : (
        <div className="flex items-center gap-1 text-[11px]">
          {(["group", "all"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={scope === choice}
              onClick={() => setScope(choice)}
              className={cn(
                "border px-1.5 py-0.5 font-mono",
                scope === choice
                  ? "border-foreground text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {choice === "group"
                ? translateText("scope.group", { name: group.name })
                : translateText("scope.all")}
            </button>
          ))}
        </div>
      )}
      {error ? (
        <LoadError
          what={translateText("navigation:sections.tasks")}
          error={error}
        />
      ) : !loaded ? (
        <Loading />
      ) : tasks.length === 0 ? (
        <Empty icon={ListChecksIcon} title={translateText("empty.title")}>
          {translateText("empty.description")}
        </Empty>
      ) : (
        statuses.map(({ value, label }) => {
          const section = tasks.filter((task) => task.status === value);
          if (!section.length) return null;
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
                <span className="tabular-nums">{section.length}</span>
              </button>
              {isOpen(value) ? (
                <ul>
                  {section.map((task) => (
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
  size,
}: {
  id?: string;
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
  className?: string;
  size?: "sm" | "default";
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  return (
    <Select
      id={id}
      aria-label={id ? undefined : translateText("fields.status")}
      className={className}
      size={size}
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

/** A task an agent drafted in a conversation, to confirm (a `task_draft` row of its timeline). */
export interface TaskProposal {
  conversationId: string;
  messageId: string;
  title: string;
  description: string;
}

/**
 * The draft being confirmed. Tasks are not made here: an agent proposes them, and the user decides
 * on the proposal (edited if need be). Confirming creates the task and starts its executor; a
 * backlog task is created and waits.
 */
export function TaskForm({
  onDone,
  proposal,
}: {
  onDone: (id?: string) => void;
  proposal: TaskProposal;
}) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const confirm = useConfirmTaskDraft();
  const [title, setTitle] = useState(proposal.title);
  const [description, setDescription] = useState(proposal.description);
  const [status, setStatus] = useState<TaskStatus>("todo");
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        confirm.mutate(
          {
            conversationId: proposal.conversationId,
            messageId: proposal.messageId,
            edits: {
              title: title.trim(),
              description: description.trim(),
              status,
            },
          },
          {
            onSuccess: (result) => onDone(result.task.id),
            onError: showError,
          },
        );
      }}
    >
      <Field id="task-title" label={translateText("fields.title")}>
        <Input
          id="task-title"
          autoFocus
          maxLength={200}
          placeholder={translateText("fields.titlePlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field
        id="task-description"
        label={translateText("fields.description")}
        hint={translateText("common:labels.markdownSupported")}
      >
        <Textarea
          id="task-description"
          rows={6}
          maxLength={20000}
          className="max-h-[40dvh] min-h-32 overflow-y-auto"
          placeholder={translateText("fields.descriptionPlaceholder")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field id="task-status" label={translateText("fields.status")}>
        <StatusSelect
          id="task-status"
          className="w-full"
          value={status}
          onChange={setStatus}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          {translateText("common:actions.cancel")}
        </Button>
        <Button type="submit" disabled={!title.trim() || confirm.isPending}>
          {status === "backlog"
            ? translateText("common:actions.create")
            : translateText("actions.createAndStart")}
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
  const { t: translateText } = useTranslation(["common"] as const);
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
  const isFolded = enabled && !open;
  return (
    <div className="min-w-0">
      <div
        ref={ref}
        className={cn(
          className,
          isFolded && [max, "overflow-hidden"],
          isFolded &&
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
              {open
                ? translateText("actions.collapse")
                : translateText("actions.expandFullText")}
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** A property's name, on the first line of its value. */
const propertyLabel = "text-xs leading-8 text-muted-foreground";

/**
 * What the task is at now: its status, who executes it and where. Each value starts on an 8-high
 * line beside its name; `children` adds rows. `status={false}` leaves the status out, for a view
 * that shows it elsewhere (the side panel's header).
 */
export function TaskProperties({
  task,
  className,
  status: withStatus = true,
  children,
}: {
  task: TaskDetail;
  className?: string;
  status?: boolean;
  children?: React.ReactNode;
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const update = useUpdateTask();
  const { agents } = useAgentList();
  return (
    <dl
      className={cn(
        "grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm",
        className,
      )}
    >
      {withStatus ? (
        <>
          <dt className={propertyLabel}>{translateText("fields.status")}</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <StatusIcon status={task.status} />
            <StatusSelect
              className="min-w-32"
              value={task.status}
              onChange={(status) =>
                update.mutate(
                  { taskId: task.id, status },
                  { onError: showError },
                )
              }
            />
          </dd>
        </>
      ) : null}
      {task.createdBy.kind === "agent" ? (
        <>
          <dt className={propertyLabel}>{translateText("executor.label")}</dt>
          <dd className="min-w-0 py-1.5 leading-5 wrap-anywhere">
            {actorName(task.createdBy, agents)}
          </dd>
          <dt className={propertyLabel}>{translateText("workspace.label")}</dt>
          <dd className="min-w-0 py-1.5 leading-5">
            {workspaceLabel(task.workspace)}
            {task.workspace.branch ? (
              <span className="text-muted-foreground">
                {" · "}
                <code>{task.workspace.branch}</code>
              </span>
            ) : null}
            {task.workspace.path ? (
              <span className="block text-xs text-muted-foreground wrap-anywhere">
                <code>{task.workspace.path}</code>
              </span>
            ) : null}
          </dd>
          <RunRow task={task} />
        </>
      ) : null}
      {children}
    </dl>
  );
}

const commentBoxId = "task-comment";

/** A blocked task's open question: the agent's last word, if it is the last. */
export function Question({ task }: { task: TaskDetail }) {
  const { t: translateText } = useTranslation(["tasks", "common"] as const);
  const { agents } = useAgentList();
  if (task.status !== "blocked") return null;
  const last = task.activity.filter((a) => a.kind === "comment").at(-1);
  if (!last || last.actor.kind === "user") return null;
  return (
    <section
      aria-label={translateText("comments.awaitingReply")}
      className="space-y-1 bg-muted px-3 py-2"
    >
      <p className="text-xs">
        <span className="font-medium">{actorName(last.actor, agents)}</span>
        <span className="text-muted-foreground">
          {" "}
          {translateText("comments.awaitingYourReply")}
        </span>
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
            {translateText("common:actions.reply")}
          </Button>
        }
      >
        <Markdown className="text-sm">{last.body ?? ""}</Markdown>
      </Folded>
    </section>
  );
}

// --- detail: timeline ---------------------------------------------------------------

function str(v: unknown) {
  return typeof v === "string" ? v : "";
}

/** One line for an event that is not a comment. */
function describe(a: TaskActivity): React.ReactNode {
  const d = a.data;
  switch (a.kind) {
    case "created":
      return translate("tasks:activity.created");
    case "status":
      return translate("tasks:activity.statusChanged", {
        from: statusLabel(str(d.from) as TaskStatus),
        to: statusLabel(str(d.to) as TaskStatus),
      });
    case "title":
      return translate("tasks:activity.titleChanged", { title: str(d.to) });
    case "description":
      return translate("tasks:activity.descriptionChanged");
    case "conversation":
      return d.to
        ? translate("tasks:activity.groupLinked")
        : translate("tasks:activity.groupUnlinked");
    case "artifact":
      return (
        <>
          <AppWindowIcon
            aria-hidden="true"
            className="mr-1 inline size-3.5 align-[-2px]"
          />
          {translate("tasks:activity.artifactPublishedPrefix")}
          <ArtifactButton
            id={str(d.artifactId)}
            version={typeof d.version === "number" ? d.version : undefined}
            className="text-foreground underline underline-offset-4"
          >
            {str(d.title) || "Artifact"}
            {typeof d.version === "number"
              ? translate("artifacts:version.inlineLabel", {
                  version: d.version,
                })
              : ""}
          </ArtifactButton>
        </>
      );
    case "comment":
      return a.body;
    case "run_queued":
      return null;
    case "run_started":
      return translate("tasks:activity.started");
    case "run_completed":
      return translate("tasks:activity.turnCompleted");
    case "run_nudged":
      return translate("tasks:activity.noReplyReminder");
    case "run_failed":
      return (
        <span className="text-destructive">
          {translate("tasks:activity.turnFailed", {
            reason: a.body ? `：${a.body}` : "",
          })}
        </span>
      );
    case "run_interrupted":
      return translate("tasks:activity.turnStopped", {
        reason: a.body ? `：${a.body}` : "",
      });
  }
}

/** What the thread gives a line of its own: what was said, what was delivered, what went wrong. */
const standalone = new Set<string>(["comment", "artifact", "run_failed"]);

/**
 * Never a line: the first message already says who made the task and when, and a run waiting for
 * its turn is said under the thread while it waits (`LiveRuns`).
 */
const unlisted = new Set<string>(["created", "run_queued"]);

/** The thread's entries: what stands alone, and everything between them folded into one. */
function entries(items: TaskActivity[]) {
  const out: (TaskActivity | TaskActivity[])[] = [];
  for (const a of items) {
    const last = out.at(-1);
    if (standalone.has(a.kind)) out.push(a);
    else if (Array.isArray(last)) last.push(a);
    else out.push([a]);
  }
  return out;
}

function Time({ at }: { at: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      className="text-xs whitespace-nowrap text-muted-foreground tabular-nums"
    >
      {when(at)}
    </time>
  );
}

/** An event as a line: who, what, when, and the log of the run it is about. */
function EventLine({
  a,
  task,
  run,
}: {
  a: TaskActivity;
  task: TaskDetail;
  run?: TaskRun | undefined;
}) {
  const { agents } = useAgentList();
  // A run's events read as the executor's, unless they are a mentioned agent's own.
  const who = actorName(
    a.kind.startsWith("run_") && a.actor.kind !== "agent"
      ? task.createdBy
      : a.actor,
    agents,
  );
  return (
    <p className="text-muted-foreground wrap-anywhere">
      {who} {describe(a)} <Time at={a.createdAt} />
      {run ? <RunLogButton task={task} run={run} /> : null}
    </p>
  );
}

/** The bookkeeping between two messages, as one line that unfolds into it. */
function Changes({ items, task }: { items: TaskActivity[]; task: TaskDetail }) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const [open, setOpen] = useState(false);
  const runs = new Map(task.runs.map((run) => [run.id, run]));
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
        {translateText("activity.changeCount", {
          count: items.length,
        })}
      </button>
      {open ? (
        <ul className="mt-1 space-y-1">
          {items.map((a) => (
            <li key={a.id}>
              <EventLine
                a={a}
                task={task}
                run={
                  a.kind === "run_started" && a.runId
                    ? runs.get(a.runId)
                    : undefined
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Who wrote a message, as a face: an agent's own, a filled square for me, a muted one for eta. */
function Face({ actor }: { actor: TaskActivity["actor"] }) {
  if (actor.kind === "agent" && actor.agentId)
    return <AgentAvatar agent={{ id: actor.agentId }} className="size-7" />;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center",
        actor.kind === "user"
          ? "bg-foreground text-background"
          : "bg-muted text-muted-foreground",
      )}
    >
      <UserIcon className="size-4" />
    </span>
  );
}

/** The thread's two columns: faces, then what was said. */
const threadRow = "grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2";

/**
 * A message in the thread. `head` starts a sender's run of messages with their face, name and
 * `meta` (when); the rest of the run is only its text, under the first.
 */
function Message({
  actor,
  head,
  meta,
  children,
}: {
  actor: TaskActivity["actor"];
  head: boolean;
  meta: React.ReactNode;
  children: React.ReactNode;
}) {
  const { agents } = useAgentList();
  return (
    <li className={cn(threadRow, head ? "pt-3" : "pt-1")}>
      <span>{head ? <Face actor={actor} /> : null}</span>
      <div className="min-w-0 text-sm">
        {head ? (
          <p className="flex flex-wrap items-baseline gap-x-2 leading-5">
            <span className="font-medium wrap-anywhere">
              {actorName(actor, agents)}
            </span>
            {meta}
          </p>
        ) : null}
        {children}
      </div>
    </li>
  );
}

/** Something that happened, small and under the text column, between the messages. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <li className={cn(threadRow, "pt-1.5")}>
      <div className="col-start-2 min-w-0 text-xs leading-5">{children}</div>
    </li>
  );
}

/** A sender's messages run together while they follow each other within this. */
const runOn = 5 * 60_000;

const sameActor = (a: TaskActivity["actor"], b: TaskActivity["actor"]) =>
  a.kind === b.kind && a.agentId === b.agentId;

/** Stopping a run that has not ended; one that waits never starts. */
function StopRun({ task, run }: { task: string; run: TaskRun }) {
  const { t: translateText } = useTranslation(["common"] as const);
  const interrupt = useInterruptRun();
  if (!isActive(run.status)) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={interrupt.isPending}
      onClick={() =>
        interrupt.mutate(
          { taskId: task, runId: run.id },
          { onError: showError },
        )
      }
    >
      <StopIcon aria-hidden="true" />
      {translateText("actions.stop")}
    </Button>
  );
}

/** A run's state: spinning while at work, red when it failed. */
function RunStatusText({ run }: { run: TaskRun }) {
  useTranslation(["tasks", "common"] as const);
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

/** Who works in a run: the agent mentioned into it, or the executor. */
function useRunAgent(task: TaskDetail, run: TaskRun) {
  const { agents } = useAgentList();
  return actorName(
    run.agentId === null
      ? task.createdBy
      : { kind: "agent", agentId: run.agentId },
    agents,
  );
}

/** A run's log, in a dialog: it is as long as the run was, more than a line of the thread holds. */
function RunLogButton({ task, run }: { task: TaskDetail; run: TaskRun }) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const who = useRunAgent(task, run);
  if (run.status === "queued") return null;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="ml-2 text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:underline"
        >
          {translateText("log.title")}
        </button>
      </DialogTrigger>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">
            #{task.number} · {who} · {translateText("log.title")}
          </DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {run.workspace ? (
              <>
                {translateText("log.workspacePrefix")}
                <code>{run.workspace}</code>
              </>
            ) : (
              <RunStatusText run={run} />
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70dvh] min-h-0 overflow-auto">
          <RunLog run={run} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One run that has not ended: who, doing what, and stopping it. */
function LiveRun({ task, run }: { task: TaskDetail; run: TaskRun }) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const who = useRunAgent(task, run);
  const queued = run.status === "queued";
  const Icon = queued ? ClockIcon : SpinnerIcon;
  const doing = queued
    ? translateText("live.queued", { name: who })
    : run.status === "starting"
      ? translateText("live.starting", { name: who })
      : run.agentId === null
        ? translateText("live.working", { name: who })
        : translateText("live.answering", { name: who });
  return (
    <li className="flex min-w-0 items-center gap-1.5 text-xs">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          queued ? "text-muted-foreground" : "motion-safe:animate-spin",
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        {doing}
        {queued && run.queueReason ? (
          <span className="text-muted-foreground">
            {" · "}
            {queueReasonLabels[run.queueReason]}
          </span>
        ) : null}
      </span>
      <RunLogButton task={task} run={run} />
      <StopRun task={task.id} run={run} />
    </li>
  );
}

/**
 * What is going on the task right now, one line per run: the executor working, an agent mentioned
 * into the thread answering, a run waiting its turn. Under the thread, beside the box to answer,
 * like someone typing; gone once the run ends, whose outcome the thread then says.
 */
export function LiveRuns({
  task,
  className,
}: {
  task: TaskDetail;
  className?: string;
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const active = task.runs.filter((run) => isActive(run.status));
  if (active.length === 0) return null;
  return (
    <ul aria-label={translateText("live.label")} className={className}>
      {active.map((run) => (
        <LiveRun key={run.id} task={task} run={run} />
      ))}
    </ul>
  );
}

/**
 * The run row of the task's properties: how the latest run is going, and — once none is going — a
 * run that starts over. Only its own wording says how that differs from a comment, which leaves the
 * executor its session and everything it did in it, so the hint is said where the two could be
 * mistaken for each other: beside the button that forgets.
 */
function RunRow({ task }: { task: TaskDetail }) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const rerun = useRerunTask();
  // The executor's runs: a mentioned agent answering is not the task running.
  const own = task.runs.filter((run) => run.agentId === null);
  const latest = own.at(-1);
  const open = own.some((run) => isActive(run.status));
  return (
    <>
      <dt className={propertyLabel}>{translateText("runs.label")}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1 leading-8">
        {latest ? (
          <span className="mr-1">
            <RunStatusText run={latest} />
          </span>
        ) : (
          <span className="mr-1 text-xs text-muted-foreground">
            {translateText("runs.never")}
          </span>
        )}
        {open ? null : (
          <Button
            variant="ghost"
            size="xs"
            disabled={rerun.isPending}
            onClick={() =>
              rerun.mutate({ taskId: task.id }, { onError: showError })
            }
          >
            <ArrowClockwiseIcon aria-hidden="true" />
            {latest ? translateText("runs.rerun") : translateText("runs.run")}
          </Button>
        )}
        {latest === undefined || open ? null : (
          <p className="w-full text-xs leading-5 text-muted-foreground">
            {translateText("runs.fromScratchHint")}
          </p>
        )}
      </dd>
    </>
  );
}

/**
 * The task's history as a thread: comments as messages, a sender's run of them under one face, what
 * was delivered and what failed on lines of their own, and the rest between them folded into one
 * line ("N 条动态"). What is going now is not here but under it (`LiveRuns`).
 */
export function Timeline({ task }: { task: TaskDetail }) {
  const { t: translateText } = useTranslation(["common"] as const);
  const runs = new Map(task.runs.map((run) => [run.id, run]));
  // A run still going is said under the thread (`LiveRuns`); its start joins the thread once it ends.
  const going = (a: TaskActivity) =>
    a.kind === "run_started" &&
    a.runId !== null &&
    isActive(runs.get(a.runId)?.status);
  const items = entries(
    task.activity.filter(
      (a) => !unlisted.has(a.kind) && !going(a) && describe(a) !== null,
    ),
  );
  return (
    <ol aria-label={translateText("labels.timeline")}>
      {items.map((a, i) => {
        if (Array.isArray(a))
          return (
            <Note key={a[0].id}>
              <Changes items={a} task={task} />
            </Note>
          );
        if (a.kind === "comment") {
          const before = items[i - 1];
          const head = !(
            before &&
            !Array.isArray(before) &&
            before.kind === "comment" &&
            sameActor(before.actor, a.actor) &&
            a.createdAt - before.createdAt < runOn
          );
          return (
            <Message
              key={a.id}
              actor={a.actor}
              head={head}
              meta={<Time at={a.createdAt} />}
            >
              <Folded max="max-h-60">
                <Markdown className="text-sm">{a.body ?? ""}</Markdown>
              </Folded>
            </Message>
          );
        }
        return (
          <Note key={a.id}>
            <EventLine
              a={a}
              task={task}
              run={a.runId ? runs.get(a.runId) : undefined}
            />
          </Note>
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
 * it.
 */
interface Outgoing {
  id: string;
  body: string;
  /** The agents it calls in, as written when it was sent. */
  mentions: string[];
  /** How many such comments the task had when it was sent. */
  before: number;
  /** Why it did not arrive; absent while it is being sent. */
  failure?: string;
}

/**
 * Who a comment on the task can call in: the members of the group it came from, or, for a task
 * from a direct chat, any agent. Labelled the way the chat's composer labels them.
 */
function useMentionable(task: TaskDetail) {
  const { agents } = useAgentList();
  const { conversations } = useConversationList();
  const origin = conversations.find((c) => c.id === task.originConversationId);
  const members =
    origin?.kind === "group"
      ? new Set(origin.participants.map((member) => member.agentId))
      : undefined;
  const people = agents.filter((agent) => members?.has(agent.id) ?? true);
  return people.map((agent) => ({
    id: agent.id,
    name: mentionLabel(agent, people),
    busy: agent.status !== "idle",
  }));
}

/** The box for the next comment; `className` places it (the side panel docks it at the bottom). */
export function CommentBox({
  task,
  className,
  top,
}: {
  task: TaskDetail;
  className?: string;
  /** Over the box, inside what places it (the side panel: what is going now). */
  top?: React.ReactNode;
}) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
    "chat",
  ] as const);
  const text = useTaskDraft((s) => s.drafts[task.id] ?? "");
  const setDraft = useTaskDraft((s) => s.setDraft);
  const setText = (update: string | ((draft: string) => string)) =>
    setDraft(task.id, update);
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const comment = useCommentTask();
  // `@` offers the agents the comment can call in (composer-menu.ts, as in the chat).
  const listId = useId();
  const members = useMentionable(task);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menu = buildMenu({
    text,
    members,
    files: [],
    commands: [],
    tasks: [],
    dismissed: menuDismissed,
  });
  const items = menu?.items ?? [];
  const menuActive = Math.min(menuIndex, items.length - 1);
  const choose = (index: number) => {
    const item = items[index];
    if (!menu || !item) return;
    setText(applyItem(text, menu, item).text);
    setMenuIndex(0);
  };
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const leftOut = (files: number) => {
    if (files)
      toast.warning(
        translateText("comments.unsupportedAttachments", {
          action: translateText("comments.title"),
          count: files,
        }),
      );
  };
  // Arrived once the task has one more of it, from the reply or a push: the
  // timeline shows it in the same render this stops showing it.
  const waiting =
    outgoing && commentsLike(task, outgoing.body) <= outgoing.before
      ? outgoing
      : null;
  const deliver = (o: Outgoing) => {
    comment
      .mutateAsync({
        taskId: task.id,
        body: o.body,
        ...(o.mentions.length ? { mentions: o.mentions } : {}),
      })
      .catch((error: unknown) => {
        const failure = wireErrorMessage(error);
        // Gone with the task's view: say so, as the box that held it is gone.
        if (!mountedRef.current) {
          toast.error(
            translateText("comments.deliveryFailed", {
              action: translateText("comments.title"),
              message: failure,
            }),
          );
          return;
        }
        setOutgoing((current) =>
          current?.id === o.id ? { ...current, failure } : current,
        );
      });
  };
  const submit = () => {
    const body = text.trim();
    if (!body || waiting) return;
    const o = {
      id: crypto.randomUUID(),
      body,
      mentions: mentionedMembers(body, members),
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
      <div className={className}>
        {top}
        <form
          className="relative flex items-end border border-input bg-background focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 dark:bg-input/30"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {items.length ? (
            <SlashMenu
              id={listId}
              rows={items.map((item) => ({
                name: item.value.trim(),
                description:
                  item.kind === "member" && item.hint
                    ? translateText("chat:mentions.busyHint")
                    : translateText("chat:mentions.replyHint"),
              }))}
              active={menuActive}
              label={translateText("chat:mentions.pickTargets")}
              onHover={setMenuIndex}
              onChoose={(row) =>
                choose(
                  items.findIndex((item) => item.value.trim() === row.name),
                )
              }
            />
          ) : null}
          <Textarea
            id={commentBoxId}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={items.length > 0}
            aria-controls={items.length ? listId : undefined}
            aria-activedescendant={
              items.length ? `${listId}-${menuActive}` : undefined
            }
            aria-label={translateText("comments.title")}
            placeholder={translateText("comments.placeholder")}
            rows={1}
            maxLength={20000}
            className="max-h-48 min-h-9 resize-none border-0 bg-transparent text-sm focus-visible:ring-0 md:text-sm dark:bg-transparent"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setMenuDismissed(false);
            }}
            // A comment is text only: a pasted or dropped file would vanish
            // without a word, so say it stayed out (a paste's text still goes in).
            onPaste={(e) => leftOut(e.clipboardData.files.length)}
            onDrop={(e) => {
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              leftOut(e.dataTransfer.files.length);
            }}
            onKeyDown={(e) => {
              if (items.length && !e.nativeEvent.isComposing) {
                const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
                if (step) {
                  e.preventDefault();
                  setMenuIndex(
                    (menuActive + step + items.length) % items.length,
                  );
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  choose(menuActive);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMenuDismissed(true);
                  return;
                }
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button
            type="submit"
            size="icon-sm"
            variant="ghost"
            className="m-0.5"
            title={translateText("comments.title")}
            disabled={!text.trim() || Boolean(waiting)}
          >
            {waiting && !waiting.failure ? (
              <>
                <SpinnerIcon
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
                <span className="sr-only">
                  {translateText("common:states.sending")}
                </span>
              </>
            ) : (
              <>
                <PaperPlaneRightIcon aria-hidden="true" />
                <span className="sr-only">
                  {translateText("comments.title")}
                </span>
              </>
            )}
          </Button>
        </form>
      </div>
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
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  return (
    <ol aria-label={translateText("comments.queuedToSend")} className="pb-3">
      <Message
        actor={{ kind: "user", agentId: null }}
        head
        meta={
          outgoing.failure ? null : (
            <span role="status" className="text-xs text-muted-foreground">
              {translateText("common:states.sending")}
            </span>
          )
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
              {translateText("comments.notDelivered", {
                message: outgoing.failure,
              })}
            </p>
            <div className="-ml-2 flex flex-wrap gap-x-1">
              <Button size="xs" variant="ghost" onClick={onRetry}>
                {translateText("common:actions.retry")}
              </Button>
              <Button size="xs" variant="ghost" onClick={onEdit}>
                {translateText("common:actions.edit")}
              </Button>
              <Button size="xs" variant="ghost" onClick={onDiscard}>
                {translateText("common:actions.discard")}
              </Button>
            </div>
          </div>
        ) : null}
      </Message>
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
  const { t: translateText } = useTranslation(["tasks"] as const);
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
          title={translateText("actions.changeTitle")}
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
        { taskId: task.id, title: title.trim() },
        { onError: showError },
      );
  };
  return (
    <Input
      aria-label={translateText("fields.title")}
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

/**
 * The task's description; `fold` folds a long one (the side panel), `className` replaces its
 * quote rule (the side panel's thread has the description as its first message). `quiet` makes
 * its edit button a pencil that shows where the pointer is over a `group/first` around it (and
 * always on touch), placed by the nearest positioned ancestor, rather than a line of its own.
 */
export function Description({
  task,
  fold = false,
  className = "border-l-2 border-foreground pl-3",
  quiet = false,
}: {
  task: TaskDetail;
  fold?: boolean;
  className?: string;
  quiet?: boolean;
}) {
  const { t: translateText } = useTranslation(["tasks", "common"] as const);
  const update = useUpdateTask();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.description);
  if (editing)
    return (
      <div className="space-y-2">
        <Textarea
          aria-label={translateText("fields.description")}
          autoFocus
          rows={8}
          maxLength={20000}
          className="max-h-[60dvh] text-sm md:text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {translateText("common:actions.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { taskId: task.id, description: text },
                { onSuccess: () => setEditing(false), onError: showError },
              )
            }
          >
            {translateText("common:actions.save")}
          </Button>
        </div>
      </div>
    );
  const startEditing = () => {
    setText(task.description);
    setEditing(true);
  };
  if (quiet && task.description.trim())
    return (
      <>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translateText("actions.editDescription")}
          title={translateText("actions.editDescription")}
          className="absolute top-0 right-0 text-muted-foreground opacity-0 group-focus-within/first:opacity-100 group-hover/first:opacity-100 pointer-coarse:opacity-100"
          onClick={startEditing}
        >
          <PencilSimpleIcon aria-hidden="true" />
        </Button>
        <Folded enabled={fold} max="max-h-56" className={className}>
          <Markdown className="text-sm">{task.description}</Markdown>
        </Folded>
      </>
    );
  const edit = (
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground"
      onClick={startEditing}
    >
      <PencilSimpleIcon aria-hidden="true" />
      {task.description.trim()
        ? translateText("actions.editDescription")
        : translateText("actions.addDescription")}
    </Button>
  );
  if (!task.description.trim()) return <div className="-ml-2">{edit}</div>;
  return (
    <Folded enabled={fold} max="max-h-56" className={className} actions={edit}>
      <Markdown className="text-sm">{task.description}</Markdown>
    </Folded>
  );
}

/** The pull request the task delivered, newest, as a link in the header: it is the work. */
function PullChip({ task }: { task: TaskDetail }) {
  const pull = useTaskPulls(task.id).at(-1);
  if (!pull) return null;
  return (
    <Button
      asChild
      variant="ghost"
      size="xs"
      className="text-muted-foreground tabular-nums"
    >
      <a href={pull.url} target="_blank" rel="noreferrer" title={pull.title}>
        <GitPullRequestIcon aria-hidden="true" />#{pull.number}
      </a>
    </Button>
  );
}

/** How long the pointer rests on the details button before they open, and leaves before they close. */
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 200;

/**
 * The task's underlying properties — who executes it, where, its runs and rerunning, its pull
 * requests — behind one button. A click opens and pins them; a mouse resting on the button opens
 * them too and they close when it leaves, unless a click pinned them. Not a hover card: they hold
 * buttons, and a touch has no hover.
 */
function TaskDetails({ task }: { task: TaskDetail }) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const [open, setOpen] = useState(false);
  const pinnedRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const hover = (next: boolean) => (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || pinnedRef.current) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(
      setOpen,
      next ? HOVER_OPEN_MS : HOVER_CLOSE_MS,
      next,
    );
  };
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) pinnedRef.current = false;
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={translateText("details.propertiesTab")}
          title={translateText("details.propertiesTab")}
          onPointerEnter={hover(true)}
          onPointerLeave={hover(false)}
          onClick={(e) => {
            // Open from hovering, a click pins it; otherwise a click opens and closes.
            e.preventDefault();
            window.clearTimeout(timerRef.current);
            if (open && !pinnedRef.current) {
              pinnedRef.current = true;
              return;
            }
            pinnedRef.current = !open;
            setOpen(!open);
          }}
        >
          <InfoIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80"
        onPointerEnter={hover(true)}
        onPointerLeave={hover(false)}
      >
        <TaskProperties task={task} status={false}>
          <TaskPulls task={task} />
        </TaskProperties>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A task in the side panel, as a thread. The header holds what is always needed — the title and
 * the status — and the rest of the task's properties behind a button (`TaskDetails`); the
 * description is the first message; the comments, what was delivered and what failed follow, the
 * rest folded between them; what is going now sits over the box to reply, at the bottom.
 */
function TaskView({ task }: { task: TaskDetail }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const [, setNav] = useTaskNav();
  const { agents } = useAgentList();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const replies = task.activity.filter((a) => a.kind === "comment").length;
  // A thread opens on its latest reply, next to the box to answer it; once more after the first
  // paint, for what lays itself out late (folded text measuring itself). It is at least as tall as
  // the panel shows, so a short one still has its box at the bottom.
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const article = ref.current;
    let area = article?.parentElement;
    while (
      area &&
      !["auto", "scroll"].includes(getComputedStyle(area).overflowY)
    )
      area = area.parentElement;
    if (!article || !area) return;
    const fill = () => {
      const { paddingTop, paddingBottom } = getComputedStyle(area);
      article.style.minHeight = `${area.clientHeight - Number.parseFloat(paddingTop) - Number.parseFloat(paddingBottom)}px`;
    };
    fill();
    const resize = new ResizeObserver(fill);
    resize.observe(area);
    const end = () => area.scrollTo({ top: area.scrollHeight });
    end();
    const frame = requestAnimationFrame(end);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, []);
  return (
    <article ref={ref} className="flex flex-col">
      {/* Pinned to the panel's edge, over its padding (p-3), as the rest scrolls. */}
      <header className="sticky -top-3 z-10 -mx-3 -mt-3 space-y-1 bg-surface px-3 pt-3 pb-2">
        <div className="flex items-center gap-1">
          <Back
            label={translateText("navigation:sections.tasks")}
            onClick={() => void setNav({ task: null })}
          />
          <span className="flex-1 text-xs text-muted-foreground tabular-nums">
            #{task.number}
          </span>
          <PullChip task={task} />
          <StatusIcon status={task.status} />
          <StatusSelect
            size="sm"
            value={task.status}
            onChange={(status) =>
              update.mutate({ taskId: task.id, status }, { onError: showError })
            }
          />
          <TaskDetails task={task} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translateText("navigation:sections.more")}
              >
                <DotsThreeIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  remove.mutate(
                    { taskId: task.id },
                    {
                      onSuccess: () => void setNav({ task: null }),
                      onError: showError,
                    },
                  )
                }
              >
                {translateText("common:actions.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <EditableTitle key={task.title} task={task} />
      </header>
      <div className={cn(threadRow, "group/first relative pt-2")}>
        <Face actor={task.createdBy} />
        <div className="min-w-0 space-y-1 text-sm">
          <p className="flex flex-wrap items-baseline gap-x-2 leading-5">
            <span className="font-medium wrap-anywhere">
              {actorName(task.createdBy, agents)}
            </span>
            <Time at={task.createdAt} />
          </p>
          <Description
            key={task.description}
            task={task}
            fold
            quiet
            className=""
          />
        </div>
      </div>
      <section
        aria-label={translateText("details.activityTab")}
        className="flex flex-1 flex-col"
      >
        {replies ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            {translateText("thread.replies", { count: replies })}
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          </p>
        ) : null}
        <div className="pb-3">
          <Timeline task={task} />
        </div>
        <CommentBox
          task={task}
          className="sticky -bottom-3 z-10 -mx-3 -mb-3 mt-auto bg-surface px-3 pt-1 pb-3"
          top={<LiveRuns task={task} className="space-y-1 pb-1.5" />}
        />
      </section>
    </article>
  );
}

// --- tab -------------------------------------------------------------------------------

/** Where a task would be: loading, failed, or gone. */
export function TaskMissing({
  missing,
  error,
}: {
  missing: boolean;
  error: Error | undefined;
}) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  if (error)
    return (
      <LoadError
        what={translateText("navigation:sections.tasks")}
        error={error}
      />
    );
  if (!missing) return <Loading layout="detail" />;
  return (
    <Empty icon={ListChecksIcon} title={translateText("empty.deletedTitle")}>
      {translateText("common:empty.mayBeDeleted")}
    </Empty>
  );
}

/** The task board: a status-grouped list, or a task. */
export function Tasks() {
  const { t: translateText } = useTranslation(["tasks", "navigation"] as const);
  const [nav, setNav] = useTaskNav();
  const id = nav.task ?? null;
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
  const { task, missing, error } = useTask(id);
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
      {!id ? null : !task ? (
        <div className="space-y-3">
          <Back
            label={translateText("navigation:sections.tasks")}
            onClick={() => void setNav({ task: null })}
          />
          <TaskMissing missing={missing} error={error} />
        </div>
      ) : (
        <TaskView key={id} task={task} />
      )}
    </>
  );
}
