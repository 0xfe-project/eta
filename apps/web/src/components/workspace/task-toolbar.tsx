import type { TaskViewKind } from "./task-view";
import type { Task } from "@/queries/tasks";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { XIcon } from "@phosphor-icons/react/X";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { agentName, useAgentList } from "@/queries/agents";
import { useNewTask } from "./task-new-store";
import { executorOf } from "./task-plan";
import { StatusIcon } from "./task-status-icon";
import { taskViews, useTaskView } from "./task-view";

// The tasks page's bar: find a task, narrow to an executor or to one piece of work (a parent and
// what is under it), switch between the board, the list and the plan, and start a new task. The
// filter belongs to the page, not to a view: switching views keeps it.

const filterButton =
  "h-7 gap-1 px-2 text-xs font-normal text-muted-foreground data-[active=true]:text-foreground";

/** Search by title or number. */
export function TaskSearch({ className }: { className?: string }) {
  const { t } = useTranslation(["tasks"] as const);
  const q = useTaskView((s) => s.filter.q);
  const setFilter = useTaskView((s) => s.setFilter);
  return (
    <label
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 border border-transparent px-2 text-xs text-muted-foreground focus-within:border-border",
        q !== "" && "border-border text-foreground",
        className,
      )}
    >
      <MagnifyingGlassIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <input
        type="search"
        aria-label={t("views.search")}
        placeholder={t("views.search")}
        value={q}
        onChange={(e) => setFilter({ q: e.target.value })}
        className="w-24 min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground @3xl:w-32"
      />
    </label>
  );
}

/** Narrow to one executor: the agents that execute some task, and me for the tasks no agent has. */
export function ExecutorFilter({ tasks }: { tasks: readonly Task[] }) {
  const { t } = useTranslation(["tasks"] as const);
  const { agents } = useAgentList();
  const who = useTaskView((s) => s.filter.who);
  const setFilter = useTaskView((s) => s.setFilter);
  const ids = [...new Set(tasks.map((task) => executorOf(task) ?? "me"))];
  const name = (id: string) =>
    id === "me" ? t("assignee.me") : agentName(agents, id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-active={who !== null}
          className={filterButton}
        >
          {who === null ? t("views.who") : name(who)}
          <CaretDownIcon aria-hidden="true" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("views.who")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={who ?? ""}
          onValueChange={(value) =>
            setFilter({ who: value === "" ? null : value })
          }
        >
          <DropdownMenuRadioItem value="">
            {t("views.whoAll")}
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {ids.map((id) => (
            <DropdownMenuRadioItem key={id} value={id}>
              {name(id)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Narrow to one piece of work: a task that has subtasks, with everything under it. */
export function ParentFilter({ tasks }: { tasks: readonly Task[] }) {
  const { t } = useTranslation(["tasks"] as const);
  const under = useTaskView((s) => s.filter.under);
  const setFilter = useTaskView((s) => s.setFilter);
  const parents = tasks.filter((task) =>
    tasks.some((other) => other.parentId === task.id),
  );
  const current = parents.find((p) => p.id === under);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-active={under !== null}
          className={cn(filterButton, "max-w-48")}
        >
          <span className="truncate">
            {t("views.underLabel", {
              name: current?.title ?? t("views.underAll"),
            })}
          </span>
          <CaretDownIcon aria-hidden="true" className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-80">
        <DropdownMenuLabel>{t("views.under")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={under ?? ""}
          onValueChange={(value) =>
            setFilter({ under: value === "" ? null : value })
          }
        >
          <DropdownMenuRadioItem value="">
            {t("views.underAll")}
          </DropdownMenuRadioItem>
          {parents.length > 0 ? <DropdownMenuSeparator /> : null}
          {parents.map((parent) => (
            <DropdownMenuRadioItem
              key={parent.id}
              value={parent.id}
              className="gap-2"
            >
              <StatusIcon status={parent.status} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{parent.title}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                #{parent.number}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Clear every filter at once, shown only while one is set. */
export function ClearFilter() {
  const { t } = useTranslation(["tasks"] as const);
  const filter = useTaskView((s) => s.filter);
  const setFilter = useTaskView((s) => s.setFilter);
  if (filter.q === "" && filter.who === null && filter.under === null)
    return null;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={t("views.clear")}
      title={t("views.clear")}
      onClick={() => setFilter({ q: "", who: null, under: null })}
    >
      <XIcon aria-hidden="true" />
    </Button>
  );
}

/** Board, list, plan: one of the three, as a segmented control. */
export function ViewSwitch<V extends string = TaskViewKind>({
  value,
  onChange,
  options = taskViews as unknown as readonly V[],
  label,
}: {
  value: V;
  onChange: (view: V) => void;
  options?: readonly V[];
  label?: string;
}) {
  const { t } = useTranslation(["tasks"] as const);
  return (
    <div
      role="radiogroup"
      aria-label={label ?? t("views.label")}
      className="inline-flex shrink-0 border"
    >
      {options.map((view) => (
        <button
          key={view}
          type="button"
          role="radio"
          aria-checked={value === view}
          onClick={() => onChange(view)}
          className={cn(
            "px-2.5 text-xs leading-6 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
            value === view &&
              "bg-foreground text-background hover:text-background",
          )}
        >
          {t(`views.${view as TaskViewKind | "overview"}`)}
        </button>
      ))}
    </div>
  );
}

/** "+ New": the new-task form. */
export function NewTask() {
  const { t } = useTranslation(["tasks"] as const);
  const open = useNewTask((s) => s.open);
  return (
    <Button
      size="sm"
      className="h-7 gap-1 px-2.5 text-xs"
      onClick={() => open()}
    >
      <PlusIcon aria-hidden="true" className="size-3.5" />
      {t("views.new")}
    </Button>
  );
}
