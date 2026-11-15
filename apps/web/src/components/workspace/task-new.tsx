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
import { useCreateTasks, useTasks } from "@/queries/tasks";
import { wireErrorMessage } from "@/queries/wire";
import { useProjectOf } from "./task-hooks";
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
    (parent === undefined ? undefined : (executorOf(parent) ?? undefined)) ??
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
