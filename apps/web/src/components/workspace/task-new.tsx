import type { BaseChoice } from "./task-base";
import type { NewTaskPreset } from "./task-new-store";
import type { Task } from "@/queries/tasks";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TreeStructureIcon } from "@phosphor-icons/react/TreeStructure";
import { XIcon } from "@phosphor-icons/react/X";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAgentList } from "@/queries/agents";
import { useConversationList } from "@/queries/conversations";
import { useCreateTasks, useNewTaskWorkspace, useTasks } from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import {
  baseArg,
  baseCandidates,
  branchOf,
  derivedBase,
  shownBase,
} from "./task-base";
import { JoinHint } from "./task-detail";
import { useProjectOf } from "./task-hooks";
import { newTaskMode, newTaskStartsAtHead, splitJoinSteps } from "./task-join";
import { useTaskNav } from "./task-nav";
import { useNewTask } from "./task-new-store";
import { stepIfMade } from "./task-pick";
import { TaskPicker } from "./task-picker";
import { executorOf } from "./task-plan";
import { parseSplit, splitBatch, stepSizes } from "./task-split";
import { StatusIcon } from "./task-status-icon";
import { useGroups } from "./use-groups";

// The user's own new task, or a piece of work split into subtasks: the form the page's "+ New",
// a parent's "+ Split one out" and the plan's "+ Add a last step" open. Pressing "Create" is the
// confirmation; the host makes it all in one write (`tasks.create`), or none of it.

/** One of the form's rows: its name on the left, what it is on the right. */
function Row({
  label,
  id,
  children,
}: {
  label: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-3 text-sm">
      <span id={id} className="text-xs text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {children}
      </div>
    </div>
  );
}

/** A picked task: its mark and title, and a way to drop it. */
function Chip({
  task,
  suffix,
  onRemove,
  removeLabel,
}: {
  task: Task;
  suffix?: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 border bg-card py-0.5 pr-0.5 pl-2 text-xs">
      <StatusIcon status={task.status} className="size-3" />
      <span className="truncate">{task.title}</span>
      {suffix ? (
        <span className="shrink-0 text-muted-foreground">{suffix}</span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </span>
  );
}

/** Two choices side by side, one pressed. */
function Segments<V extends string>({
  value,
  options,
  onChange,
  labelledBy,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (value: V) => void;
  labelledBy: string;
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="flex w-fit border"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "px-2.5 py-1 text-xs",
            value === option.value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function NewTaskForm({ preset }: { preset: NewTaskPreset }) {
  const { t } = useTranslation(["tasks", "common"] as const);
  const close = useNewTask((s) => s.close);
  const [, setNav] = useTaskNav();
  const { tasks: all } = useTasks();
  const { agents } = useAgentList();
  const { conversations } = useConversationList();
  const { current: group } = useGroups();
  const projectOf = useProjectOf();
  const make = useCreateTasks();

  const [split, setSplit] = useState(preset.split === true);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState("");
  const [parentId, setParentId] = useState<string | null>(
    preset.parentId ?? null,
  );
  const [dependsOn, setDependsOn] = useState(preset.dependsOn ?? []);
  const [start, setStart] = useState<"todo" | "backlog">("todo");
  const [baseChoice, setBaseChoice] = useState<BaseChoice>({ kind: "auto" });
  const parent = all.find((task) => task.id === parentId);
  const open = conversations.filter((c) => !c.archived);
  const [conversationId, setConversationId] = useState<string | undefined>(
    group?.id ?? open[0]?.id,
  );
  // The executor, until the user picks one: the parent's, else the conversation's first member
  // that is not Captain, else the first such agent there is. Picking a parent changes it with it.
  const people = agents.filter((agent) => agent.systemRole !== "captain");
  const conversation = conversations.find((c) => c.id === conversationId);
  const [picked, setAssignee] = useState<string | undefined>();
  const assignee =
    picked ??
    (parent === undefined ? null : executorOf(parent)) ??
    conversation?.participants.find((member) =>
      people.some((agent) => agent.id === member.agentId),
    )?.agentId ??
    people[0]?.id;
  const projectId =
    parent === undefined
      ? conversation?.projectId
      : (projectOf(parent) ?? conversation?.projectId);
  const subject = {
    parentId,
    dependsOn: dependsOn.map((d) => d.id),
  };
  const step = stepIfMade(subject, all);
  const parsed = parseSplit(lines);
  const sizes = stepSizes(parsed);
  const byId = new Map(all.map((task) => [task.id, task]));
  // A join (two or more prerequisites) in a worktree project starts at the project's HEAD.
  // The host says where it will work (`tasks.workspaceFor`); until it answers, what the board shows.
  const asked = useNewTaskWorkspace(
    parentId === null ? { conversationId } : { parent: parentId },
  );
  const workspace = asked ?? newTaskMode(parent, projectId, all, projectOf);
  const joinSteps = split ? splitJoinSteps(workspace, parsed) : [];

  // Where the worktree starts, for a project that gives its tasks one. A split has no
  // prerequisites of its own here: its first step starts from HEAD unless the user says otherwise.
  const prerequisites = split
    ? []
    : dependsOn.flatMap((d) => byId.get(d.id) ?? []);
  const candidates = baseCandidates(prerequisites, all, projectId, projectOf);
  const derived = derivedBase(prerequisites, candidates);
  const shown = shownBase(baseChoice, candidates);
  const derivedValue =
    derived.kind === "task" ? `task:${derived.task.id}` : "head";
  const baseValue =
    shown.kind === "auto"
      ? derivedValue
      : shown.kind === "task"
        ? `task:${shown.taskId}`
        : shown.kind;
  const base =
    workspace === "worktree" ? baseArg(baseChoice, candidates) : undefined;
  // Left to the host, a join starts at HEAD: say so (#135), and that 起点 can change it.
  const joinsAtHead =
    !split &&
    shown.kind === "auto" &&
    newTaskStartsAtHead(workspace, dependsOn.length);

  const ready =
    assignee !== undefined &&
    (parent !== undefined || conversationId !== undefined) &&
    (split
      ? parsed.length > 0 && (parent !== undefined || title.trim() !== "")
      : title.trim() !== "");

  const submit = () => {
    if (!ready || assignee === undefined) return;
    const tasks = split
      ? splitBatch(
          parsed,
          assignee,
          parent === undefined
            ? { title: title.trim(), description: description.trim() }
            : undefined,
          base,
        )
      : [
          {
            title: title.trim(),
            description: description.trim(),
            assignee,
            dependsOn: dependsOn.map((d) => ({
              task: d.id,
              requireDone: d.requireDone,
            })),
            ...(base === undefined ? {} : { base }),
          },
        ];
    make.mutate(
      {
        tasks,
        status: start,
        ...(parentId === null ? {} : { parent: parentId }),
        ...(parent === undefined && conversationId !== undefined
          ? { conversationId }
          : {}),
      },
      {
        onError: (error) => toast.error(wireErrorMessage(error)),
        onSuccess: ({ tasks: made }) => {
          close();
          // A split opens the piece of work it made or went under; one task opens itself.
          const open = split ? (parentId ?? made[0]?.id) : made[0]?.id;
          if (open !== undefined) void setNav({ task: open });
        },
      },
    );
  };

  const parentRow = (
    <Row label={t("create.belongsTo")}>
      {parent === undefined ? null : (
        <>
          <Chip
            task={parent}
            onRemove={() => setParentId(null)}
            removeLabel={t("create.clearParent")}
          />
          {!split && step !== undefined ? (
            <span className="text-xs text-muted-foreground">
              {t("create.willBeStep", { count: step })}
            </span>
          ) : null}
        </>
      )}
      {parent === undefined ? (
        <TaskPicker
          mode="parent"
          subject={subject}
          projectId={projectId}
          onPick={(task) => setParentId(task.id)}
        >
          <Button type="button" variant="ghost" size="xs">
            <PlusIcon aria-hidden="true" />
            {t("create.pickParent")}
          </Button>
        </TaskPicker>
      ) : null}
    </Row>
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {split
            ? parent === undefined
              ? t("create.splitTitle")
              : t("create.splitUnder", { title: parent.title })
            : t("create.title")}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t("create.description")}
        </DialogDescription>
      </DialogHeader>
      <Segments
        labelledBy="new-task-mode"
        value={split ? "split" : "one"}
        onChange={(v) => setSplit(v === "split")}
        options={[
          { value: "one", label: t("create.one") },
          { value: "split", label: t("create.split") },
        ]}
      />
      <span id="new-task-mode" className="sr-only">
        {t("create.mode")}
      </span>
      {split && parent !== undefined ? null : (
        <>
          <Input
            aria-label={t(split ? "create.splitWhole" : "fields.title")}
            autoFocus
            maxLength={200}
            placeholder={t(
              split ? "create.splitWhole" : "fields.titlePlaceholder",
            )}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            aria-label={t("fields.description")}
            rows={3}
            maxLength={20000}
            className="max-h-[30dvh] min-h-20"
            placeholder={t("fields.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </>
      )}
      {split ? (
        <div className="space-y-1.5">
          <p id="split-hint" className="text-xs text-muted-foreground">
            {t("create.splitHint")}
          </p>
          <Textarea
            aria-label={t("create.split")}
            aria-describedby="split-hint split-preview"
            autoFocus={parent !== undefined}
            rows={5}
            className="min-h-28 leading-7"
            placeholder={t("create.splitPlaceholder")}
            value={lines}
            onChange={(e) => setLines(e.target.value)}
          />
          <p
            id="split-preview"
            aria-live="polite"
            className="text-xs text-muted-foreground"
          >
            {sizes.length === 0
              ? t("create.previewEmpty")
              : `${t("create.preview")}${sizes
                  .map((count, i) =>
                    count > 1
                      ? t("create.previewStepParallel", { step: i + 1, count })
                      : t("create.previewStep", { step: i + 1, count }),
                  )
                  .join(" · ")}`}
          </p>
          {joinSteps.map((step) => (
            <JoinHint key={step}>
              {t("join.stepStartsAtHead", { step, before: step - 1 })}
            </JoinHint>
          ))}
        </div>
      ) : null}
      <div className="space-y-2.5">
        <Row label={t("executor.label")} id="new-task-executor">
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger
              aria-labelledby="new-task-executor"
              size="sm"
              className="h-7 min-w-32 text-xs"
            >
              <SelectValue placeholder={t("create.pickExecutor")} />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        {parentRow}
        {parent === undefined ? (
          <Row label={t("create.in")} id="new-task-in">
            <Select value={conversationId} onValueChange={setConversationId}>
              <SelectTrigger
                aria-labelledby="new-task-in"
                size="sm"
                className="h-7 min-w-32 text-xs"
              >
                <SelectValue placeholder={t("create.pickConversation")} />
              </SelectTrigger>
              <SelectContent>
                {open.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        ) : null}
        {split ? null : (
          <Row label={t("create.dependsOn")}>
            {dependsOn.map((d) => {
              const task = byId.get(d.id);
              if (task === undefined) return null;
              return (
                <Chip
                  key={d.id}
                  task={task}
                  suffix={d.requireDone ? t("create.whenDone") : undefined}
                  removeLabel={t("create.removeDependency", {
                    title: task.title,
                  })}
                  onRemove={() =>
                    setDependsOn(dependsOn.filter((x) => x.id !== d.id))
                  }
                />
              );
            })}
            <TaskPicker
              mode="dependsOn"
              subject={subject}
              projectId={projectId}
              exclude={dependsOn.map((d) => d.id)}
              onPick={(task, requireDone) =>
                setDependsOn([...dependsOn, { id: task.id, requireDone }])
              }
            >
              <Button type="button" variant="ghost" size="xs">
                <PlusIcon aria-hidden="true" />
                {t("create.add")}
              </Button>
            </TaskPicker>
          </Row>
        )}
        {workspace === "worktree" ? (
          <Row label={t("create.base")} id="new-task-base">
            <Select
              value={baseValue}
              onValueChange={(value) =>
                setBaseChoice(
                  value === "head"
                    ? { kind: "head" }
                    : value === "custom"
                      ? { kind: "custom", value: "" }
                      : { kind: "task", taskId: value.slice("task:".length) },
                )
              }
            >
              <SelectTrigger
                aria-labelledby="new-task-base"
                size="sm"
                className="h-7 max-w-full min-w-32 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((task) => (
                  <SelectItem key={task.id} value={`task:${task.id}`}>
                    {t("create.baseTask", { title: task.title })}{" "}
                    <code className="text-muted-foreground">
                      {branchOf(task)}
                    </code>
                    {derivedValue === `task:${task.id}` ? (
                      <span className="text-muted-foreground">
                        {` ${t("create.baseAuto")}`}
                      </span>
                    ) : null}
                  </SelectItem>
                ))}
                <SelectItem value="head">
                  {t("create.baseHead")}
                  {derivedValue === "head" ? (
                    <span className="text-muted-foreground">
                      {` ${t("create.baseAuto")}`}
                    </span>
                  ) : null}
                </SelectItem>
                <SelectItem value="custom">{t("create.baseCustom")}</SelectItem>
              </SelectContent>
            </Select>
            {shown.kind === "custom" ? (
              <Input
                aria-label={t("create.baseCustom")}
                autoFocus
                maxLength={200}
                className="h-7 w-44 text-xs"
                placeholder={t("create.baseCustomPlaceholder")}
                value={shown.value}
                onChange={(e) =>
                  setBaseChoice({ kind: "custom", value: e.target.value })
                }
              />
            ) : null}
            {joinsAtHead ? (
              <div className="basis-full space-y-0.5">
                <JoinHint>{t("join.startsAtHead")}</JoinHint>
                {candidates.length > 1 ? (
                  <p className="pl-5.5 text-xs leading-5 text-muted-foreground">
                    {t("create.baseMany")}
                  </p>
                ) : null}
              </div>
            ) : split ? (
              <span className="basis-full text-xs text-muted-foreground">
                {t("create.baseSplit")}
              </span>
            ) : null}
          </Row>
        ) : null}
        <Row label={t("create.start")} id="new-task-start">
          <Segments
            labelledBy="new-task-start"
            value={start}
            onChange={setStart}
            options={[
              { value: "todo", label: t("create.startWhenReady") },
              { value: "backlog", label: t("create.startBacklog") },
            ]}
          />
        </Row>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={close}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" disabled={!ready || make.isPending}>
          {split ? (
            <>
              <TreeStructureIcon aria-hidden="true" />
              {t("create.createSubtasks", { count: parsed.length })}
            </>
          ) : (
            t("common:actions.create")
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The form, wherever it is opened from; mounted once on the tasks page. */
export function NewTaskDialog() {
  const preset = useNewTask((s) => s.preset);
  const close = useNewTask((s) => s.close);
  return (
    <Dialog open={preset !== undefined} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        {preset === undefined ? null : <NewTaskForm preset={preset} />}
      </DialogContent>
    </Dialog>
  );
}
