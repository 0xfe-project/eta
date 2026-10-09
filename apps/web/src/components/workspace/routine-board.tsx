import { PlusIcon } from "@phosphor-icons/react/Plus";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useRoutine } from "@/queries/routines";
import { PageHeader } from "./app-shell";
import { RoutineForm } from "./routine-form";
import { useRoutineNav } from "./routine-nav";
import { RoutineDetail, RoutineList, RunView } from "./routines";

/**
 * Routines as a full-window page: the list beside the open routine, its run
 * or its editor; on narrow screens one at a time.
 */
export function RoutineBoard() {
  const [nav, setNav] = useRoutineNav();
  const editing = nav.edit && nav.edit !== "new" ? nav.edit : null;
  const { data: routine, isPending } = useRoutine(nav.routine ?? editing);
  const open = Boolean(nav.edit || nav.routine);
  const run = routine?.runs.find((r) => r.id === nav.run);

  const content =
    nav.edit === "new" ? (
      <RoutineForm
        routine={null}
        onDone={(id) => void setNav({ edit: null, routine: id ?? null })}
      />
    ) : editing && routine ? (
      <RoutineForm
        routine={routine}
        onDone={() => void setNav({ edit: null })}
      />
    ) : routine && run ? (
      <RunView routine={routine} run={run} />
    ) : routine ? (
      <RoutineDetail routine={routine} listed />
    ) : nav.routine && !isPending ? (
      <p className="text-sm text-muted-foreground">这个定时任务已不存在。</p>
    ) : null;

  return (
    <>
      <PageHeader title="定时">
        <Button
          size="sm"
          onClick={() => void setNav({ edit: "new", routine: null, run: null })}
        >
          <PlusIcon aria-hidden="true" />
          <span className="hidden sm:inline">新建定时任务</span>
          <span className="sr-only sm:hidden">新建定时任务</span>
        </Button>
      </PageHeader>
      <main id="main" className="flex min-h-0 flex-1">
        <div
          className={cn(
            "w-full overflow-y-auto px-2 py-3 sm:px-4 lg:block lg:w-96 lg:shrink-0 lg:border-r",
            open && "hidden",
          )}
        >
          <RoutineList selected={nav.routine} bare />
        </div>
        <div
          className={cn(
            "min-w-0 flex-1 overflow-y-auto",
            !open && "hidden lg:block",
          )}
        >
          <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8">{content}</div>
        </div>
      </main>
    </>
  );
}
