import type { PickMode, PickOption, PickSubject } from "./task-pick";
import type { Task } from "@/queries/tasks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useTasks } from "@/queries/tasks";
import { statusLabel } from "./task-format";
import { useProjectOf } from "./task-hooks";
import { pickOptions } from "./task-pick";
import { ancestorsOfTask } from "./task-plan";
import { StatusIcon } from "./task-status-icon";

// The one picker of tasks: what a task waits for (a dependency) or what it belongs to (a parent).
// The task page's "Prerequisites · Edit…", the new-task form's "Belongs to" and "Prerequisites",
// the plan's "+ subtask" and a blocked task's "wait for another one instead" all open this.

/** What an option says at its end: why it cannot be picked, that it is elsewhere, or its state. */
function Tag({ option }: { option: PickOption }) {
  const { t } = useTranslation(["tasks"] as const);
  const { task, refusal, otherProject } = option;
  if (refusal !== undefined)
    return (
      <span className="shrink-0 text-xs text-state-error-ink">
        {t(`pick.refusal.${refusal}`)}
      </span>
    );
  if (otherProject)
    return (
      <span className="shrink-0 text-xs text-muted-foreground">
        {t("pick.otherProject")}
      </span>
    );
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      {task.status === "in_review"
        ? t("pick.delivered")
        : task.status === "in_progress"
          ? t("pick.running")
          : statusLabel(task.status)}
    </span>
  );
}

/** The two answers to "when does it let this one go", each with what it means. */
function Release({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (requireDone: boolean) => void;
}) {
  const { t } = useTranslation(["tasks"] as const);
  return (
    <fieldset className="space-y-1.5 border-t px-3 py-2.5 text-xs">
      <legend className="sr-only">{t("pick.release")}</legend>
      <p aria-hidden="true" className="font-medium">
        {t("pick.release")}
      </p>
      {([false, true] as const).map((done) => (
        <label
          key={String(done)}
          className="flex cursor-pointer items-start gap-2 leading-5"
        >
          <input
            type="radio"
            name="release"
            checked={value === done}
            onChange={() => onChange(done)}
            className="mt-1 accent-foreground"
          />
          <span>
            {t(done ? "pick.releaseDone" : "pick.releaseDelivered")}
            <small className="block text-muted-foreground">
              {t(done ? "pick.releaseDoneHint" : "pick.releaseDeliveredHint")}
            </small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The list itself, for a popover or a page: a search, the same piece of work first, the rest
 * under "Other", greyed options saying why. For a dependency, "when does it let this one go" under
 * the list; `onPick` hears the choice with it.
 */
export function TaskPickList({
  mode,
  subject,
  projectId,
  exclude = [],
  onPick,
}: {
  mode: PickMode;
  subject: PickSubject;
  /** The subject's project; another one's tasks are marked. */
  projectId: string | undefined;
  /** Tasks not to offer (already picked). */
  exclude?: readonly string[];
  onPick: (task: Task, requireDone: boolean) => void;
}) {
  const { t } = useTranslation(["tasks"] as const);
  const { tasks: all } = useTasks();
  const projectOf = useProjectOf();
  const [query, setQuery] = useState("");
  const [requireDone, setRequireDone] = useState(false);
  const options = pickOptions({
    mode,
    subject,
    all,
    query,
    projectOf,
    projectId,
  }).filter((o) => !exclude.includes(o.task.id));
  const same = options.filter((o) => o.same);
  const other = options.filter((o) => !o.same);
  const top = (() => {
    const first = same[0]?.task;
    if (first === undefined) return undefined;
    return ancestorsOfTask(first, all).at(-1) ?? first;
  })();
  const item = (option: PickOption) => (
    <CommandItem
      key={option.task.id}
      value={option.task.id}
      disabled={option.refusal !== undefined}
      onSelect={() => onPick(option.task, requireDone)}
      data-refusal={option.refusal}
      className="gap-2"
    >
      <StatusIcon status={option.task.status} className="size-3.5" />
      <span className="w-8 shrink-0 text-muted-foreground tabular-nums">
        #{option.task.number}
      </span>
      <span className="min-w-0 flex-1 truncate">{option.task.title}</span>
      <Tag option={option} />
    </CommandItem>
  );
  return (
    // The search is ours (`pickOptions`), by title or number: cmdk's own filter is off.
    <Command shouldFilter={false}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t(mode === "parent" ? "pick.searchParent" : "pick.search")}
      />
      <CommandList className="max-h-72">
        <CommandEmpty>{t("pick.none")}</CommandEmpty>
        {same.length > 0 ? (
          <CommandGroup
            heading={
              top === undefined
                ? t("pick.same")
                : t("pick.sameAs", { title: top.title })
            }
          >
            {same.map(item)}
          </CommandGroup>
        ) : null}
        {other.length > 0 ? (
          <CommandGroup heading={t("pick.other")}>
            {other.map(item)}
          </CommandGroup>
        ) : null}
      </CommandList>
      {mode === "dependsOn" ? (
        <Release value={requireDone} onChange={setRequireDone} />
      ) : null}
    </Command>
  );
}

/** The picker behind a button: `children` is the button. */
export function TaskPicker({
  children,
  align = "start",
  className,
  ...list
}: Parameters<typeof TaskPickList>[0] & {
  children: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className={cn("w-96 p-0", className)}>
        <TaskPickList
          {...list}
          onPick={(task, requireDone) => {
            setOpen(false);
            list.onPick(task, requireDone);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
