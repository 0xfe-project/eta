import type { BoardTaskAssignee } from "@eta/client-contracts";
import type {
  Task,
  TaskActivity,
  TaskDetail,
  TaskStatus,
} from "@/queries/tasks";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { SpinnerIcon } from "@phosphor-icons/react/Spinner";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAgentList } from "@/queries/agents";
import {
  useCommentTask,
  useConfirmTaskDraft,
  useCreateTask,
  useDeleteTask,
  useTask,
  useTasks,
  useUpdateTask,
} from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { ArtifactButton } from "./artifact-dialog";
import { BackToTop } from "./back-to-top";
import { when } from "./routine-format";
import { Select, SelectOption } from "./select-field";
import { useTaskDraft } from "./task-draft";
import {
  actorName,
  ago,
  assigneeLabel,
  assignees,
  createdBy,
  statuses,
  statusLabel,
} from "./task-format";
import { useTaskNav } from "./task-nav";
import { StatusIcon } from "./task-status-icon";
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

/** Title and when on top; number, assignee and activity beneath. */
function TaskRow({ task }: { task: Task }) {
  useTranslation(["tasks", "common", "navigation"] as const);
  const [, setNav] = useTaskNav();
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
              {assigneeLabel(task.assignee)}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-3 pl-2">
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
  const [, setNav] = useTaskNav();
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
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {translateText("navigation:sections.tasks")}
        </h2>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={translateText("actions.create")}
          title={translateText("common:actions.new")}
          onClick={() => void setNav({ task: "new" })}
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </div>
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
        <Empty
          icon={ListChecksIcon}
          title={translateText("empty.title")}
          action={
            <Button size="sm" onClick={() => void setNav({ task: "new" })}>
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              {translateText("actions.create")}
            </Button>
          }
        >
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
}: {
  id?: string;
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
  className?: string;
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  return (
    <Select
      id={id}
      aria-label={id ? undefined : translateText("fields.status")}
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

function AssigneeSelect({
  id,
  value,
  onChange,
  className,
}: {
  id?: string;
  value: BoardTaskAssignee;
  onChange: (assignee: BoardTaskAssignee) => void;
  className?: string;
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  return (
    <Select
      id={id}
      aria-label={id ? undefined : translateText("assignee.label")}
      className={className}
      value={value}
      onValueChange={(value) => onChange(value as BoardTaskAssignee)}
    >
      {assignees.map((a) => (
        <SelectOption key={a.value} value={a.value}>
          {a.label}
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

/** A new task, or a draft being confirmed; `bare` leaves the heading to a dialog around it. */
export function TaskForm({
  onDone,
  bare = false,
  initialStatus = "todo",
  proposal,
}: {
  onDone: (id?: string) => void;
  bare?: boolean;
  initialStatus?: TaskStatus;
  proposal?: TaskProposal;
}) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const create = useCreateTask();
  const confirm = useConfirmTaskDraft();
  const { groups } = useGroups();
  const [conversationId, setConversationId] = useState("");
  const [title, setTitle] = useState(proposal?.title ?? "");
  const [description, setDescription] = useState(proposal?.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(initialStatus);
  const [assignee, setAssignee] = useState<BoardTaskAssignee>("none");
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        const fields = {
          title: title.trim(),
          description: description.trim(),
          status,
          assignee,
        };
        const callbacks = {
          onSuccess: (result: { task: { id: string } }) =>
            onDone(result.task.id),
          onError: showError,
        };
        if (proposal)
          confirm.mutate(
            {
              conversationId: proposal.conversationId,
              messageId: proposal.messageId,
              edits: fields,
            },
            callbacks,
          );
        else
          create.mutate(
            {
              ...fields,
              ...(conversationId ? { conversationId } : {}),
            },
            callbacks,
          );
      }}
    >
      {bare ? null : (
        <div className="space-y-1">
          <Back
            label={translateText("navigation:sections.tasks")}
            onClick={() => onDone()}
          />
          <h2 className="text-sm font-semibold">
            {translateText("actions.create")}
          </h2>
        </div>
      )}
      <Field id="task-title" label={translateText("fields.title")}>
        <Input
          id="task-title"
          autoFocus={bare}
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
      <Field id="task-assignee" label={translateText("assignee.label")}>
        <AssigneeSelect
          id="task-assignee"
          className="w-full"
          value={assignee}
          onChange={setAssignee}
        />
      </Field>
      {!proposal && (
        <Field label={translateText("fields.optionalGroup")}>
          <Select
            value={conversationId || "none"}
            onValueChange={(value) =>
              setConversationId(value === "none" ? "" : value)
            }
          >
            <SelectOption value="none">
              {translateText("fields.noGroup")}
            </SelectOption>
            {groups
              .filter((g) => !g.archived)
              .map((g) => (
                <SelectOption key={g.id} value={g.id}>
                  {g.name}
                </SelectOption>
              ))}
          </Select>
        </Field>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          {translateText("common:actions.cancel")}
        </Button>
        <Button
          type="submit"
          disabled={!title.trim() || create.isPending || confirm.isPending}
        >
          {translateText("common:actions.create")}
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
 * What the task is at now: its status and who has it. Each value starts on
 * an 8-high line beside its name; `children` adds rows.
 */
export function TaskProperties({
  task,
  className,
  children,
}: {
  task: TaskDetail;
  className?: string;
  children?: React.ReactNode;
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const update = useUpdateTask();
  return (
    <dl
      className={cn(
        "grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm",
        className,
      )}
    >
      <dt className={propertyLabel}>{translateText("fields.status")}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <StatusIcon status={task.status} />
        <StatusSelect
          className="min-w-32"
          value={task.status}
          onChange={(status) =>
            update.mutate({ taskId: task.id, status }, { onError: showError })
          }
        />
      </dd>
      <dt className={propertyLabel}>{translateText("assignee.label")}</dt>
      <dd className="min-w-0">
        <AssigneeSelect
          className="min-w-32"
          value={task.assignee}
          onChange={(assignee) =>
            update.mutate({ taskId: task.id, assignee }, { onError: showError })
          }
        />
      </dd>
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
    case "assignee":
      return translate("tasks:activity.assigned", {
        assignee: assigneeLabel(str(d.to) as BoardTaskAssignee),
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
  }
}

/** Bookkeeping the task's current state already shows; runs of it fold. */
const minor = new Set<string>([
  "created",
  "title",
  "description",
  "assignee",
  "conversation",
  "status",
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

/** An event as a line: who, what, when. */
function EventLine({ a }: { a: TaskActivity }) {
  const { agents } = useAgentList();
  return (
    <p className="text-muted-foreground wrap-anywhere">
      {actorName(a.actor, agents)} {describe(a)} <Time at={a.createdAt} />
    </p>
  );
}

/** Minor events in a row, as one line that unfolds into them. */
function Changes({ items }: { items: TaskActivity[] }) {
  const { t: translateText } = useTranslation(["tasks"] as const);
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
        {translateText("activity.changeCount", {
          count: items.length,
        })}
        <span className="ml-1">
          <Time at={items.at(-1)!.createdAt} />
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

const dot = <span className="size-1.5 bg-muted-foreground/60" />;

/** The task's history: comments in full (long ones folded), bookkeeping folded into "N 条变更". */
export function Timeline({ task }: { task: TaskDetail }) {
  const { t: translateText } = useTranslation(["common"] as const);
  const { agents } = useAgentList();
  const items = entries(task.activity);
  return (
    <ol aria-label={translateText("labels.timeline")}>
      {items.map((a, i) => {
        const last = i === items.length - 1;
        if (Array.isArray(a))
          return (
            <Entry key={a[0].id} last={last} mark={dot}>
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
                  {actorName(a.actor, agents)}
                </span>
                <Time at={a.createdAt} />
              </p>
              <Folded max="max-h-60" className="mt-1">
                <Markdown className="text-sm">{a.body ?? ""}</Markdown>
              </Folded>
            </Entry>
          );
        return (
          <Entry key={a.id} last={last} mark={dot}>
            <EventLine a={a} />
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
 * it.
 */
interface Outgoing {
  id: string;
  body: string;
  /** How many such comments the task had when it was sent. */
  before: number;
  /** Why it did not arrive; absent while it is being sent. */
  failure?: string;
}

export function CommentBox({ task }: { task: TaskDetail }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const text = useTaskDraft((s) => s.drafts[task.id] ?? "");
  const setDraft = useTaskDraft((s) => s.setDraft);
  const setText = (update: string | ((draft: string) => string)) =>
    setDraft(task.id, update);
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const comment = useCommentTask();
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
      .mutateAsync({ taskId: task.id, body: o.body })
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
          aria-label={translateText("comments.title")}
          placeholder={translateText("comments.placeholder")}
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
            type="submit"
            size="sm"
            disabled={!text.trim() || Boolean(waiting)}
          >
            {waiting && !waiting.failure ? (
              <>
                <SpinnerIcon aria-hidden="true" className="animate-spin" />
                {translateText("common:states.sending")}
              </>
            ) : (
              translateText("comments.title")
            )}
          </Button>
        </div>
      </form>
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
    <ol aria-label={translateText("comments.queuedToSend")}>
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
        ) : (
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {translateText("common:states.sending")}
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

/** The task's description; `fold` folds a long one (the side panel). */
export function Description({
  task,
  fold = false,
}: {
  task: TaskDetail;
  fold?: boolean;
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
      {task.description.trim()
        ? translateText("actions.editDescription")
        : translateText("actions.addDescription")}
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

/** A task in the side panel: one column, what matters first. */
function TaskView({ task }: { task: TaskDetail }) {
  const { t: translateText } = useTranslation([
    "tasks",
    "common",
    "navigation",
  ] as const);
  const [, setNav] = useTaskNav();
  const { agents } = useAgentList();
  const remove = useDeleteTask();
  return (
    <>
      <article className="space-y-4">
        {/* Pinned to the panel's edge, over its padding (p-3), as the rest scrolls. */}
        <header className="sticky -top-3 z-10 -mx-3 -mt-3 mb-2 space-y-1 bg-background px-3 pt-3 pb-2">
          <div className="flex items-center justify-between gap-2">
            <Back
              label={translateText("navigation:sections.tasks")}
              onClick={() => void setNav({ task: null })}
            />
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
          <p className="text-xs text-muted-foreground tabular-nums">
            #{task.number} · {createdBy(task, agents)}
          </p>
        </header>
        <TaskProperties task={task} className="bg-muted/50 px-3 py-2" />
        <Question task={task} />
        <Description key={task.description} task={task} fold />
        <section aria-labelledby="task-activity" className="space-y-3">
          <h3
            id="task-activity"
            className="text-xs font-medium text-muted-foreground"
          >
            {translateText("details.activityTab")}
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

/** The task board: a status-grouped list, a task, or a new one. */
export function Tasks() {
  const { t: translateText } = useTranslation(["tasks", "navigation"] as const);
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
      {nav.task === "new" ? (
        <TaskForm onDone={(id) => void setNav({ task: id ?? null })} />
      ) : !id ? null : !task ? (
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
