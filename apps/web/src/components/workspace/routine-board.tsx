import { ClockIcon } from "@phosphor-icons/react/Clock";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useTranslation } from "react-i18next";
import { Empty } from "@/components/states";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useRoutine, useRoutines } from "@/queries/routines";
import { PageHeader } from "./app-shell";
import { RoutineForm } from "./routine-form";
import { useRoutineNav } from "./routine-nav";
import {
  CaptainOffNotice,
  RoutineDetail,
  RoutineList,
  RoutineMissing,
  RunView,
} from "./routines";

/**
 * Routines as a full-window page: the list beside the open routine, its run
 * or its editor; on narrow screens one at a time.
 */
export function RoutineBoard() {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  const [nav, setNav] = useRoutineNav();
  const editing = nav.edit && nav.edit !== "new" ? nav.edit : null;
  const { routine, missing, error } = useRoutine(nav.routine ?? editing);
  const { routines } = useRoutines();
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
    ) : open ? (
      <RoutineMissing missing={missing} error={error} />
    ) : routines.length ? (
      // With none yet, the list says how to start.
      <Empty icon={ClockIcon} title={translateText("empty.selectTitle")}>
        {translateText("empty.selectDescription")}
      </Empty>
    ) : null;

  return (
    <>
      <PageHeader title={translateText("navigation:sections.routines")}>
        <Button
          size="sm"
          onClick={() => void setNav({ edit: "new", routine: null, run: null })}
        >
          <PlusIcon aria-hidden="true" />
          <span className="hidden sm:inline">
            {translateText("actions.create")}
          </span>
          <span className="sr-only sm:hidden">
            {translateText("actions.create")}
          </span>
        </Button>
      </PageHeader>
      {/* Inset like the header, so it lines up with the title and the list. */}
      <CaptainOffNotice className="mx-4 mt-3 sm:mx-6" />
      {/* The inbox's frame: the list pinned to the sidebar, the open routine centred in the rest. */}
      <main
        id="main"
        className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[22rem_minmax(0,1fr)]"
      >
        <aside
          className={cn(
            "min-h-0 overflow-y-auto border-r px-4 py-3 sm:px-6",
            open && "hidden md:block",
          )}
        >
          <RoutineList selected={nav.routine} bare />
        </aside>
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-y-auto",
            !open && "hidden md:block",
          )}
        >
          <div className="mx-auto max-w-content px-4 py-6 sm:px-8">
            {content}
          </div>
        </div>
      </main>
    </>
  );
}
