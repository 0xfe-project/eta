import type {
  BriefVersion,
  ListedRun,
  Routine,
  RoutineSummary,
  Run,
  RunStatus,
} from "@/queries/routines";

import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretLeftIcon } from "@phosphor-icons/react/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { listSeparator, translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  useDeleteRoutine,
  useMarkRoutineSeen,
  useRestoreBrief,
  useRoutine,
  useRoutines,
  useRunRoutineNow,
  useSendFeedback,
  useSetRoutineEnabled,
} from "@/queries/routines";
import { RoutineForm } from "./routine-form";
import { describeSchedule, when } from "./routine-format";
import { useRoutineNav } from "./routine-nav";
import { UsageLine } from "./usage-line";

const runStatusLabels: Record<RunStatus, string> = {
  get running() {
    return translate("common:status.running");
  },
  get sent() {
    return translate("routines:runStatus.sent");
  },
  get nothing_new() {
    return translate("routines:runStatus.nothingNew");
  },
  get failed() {
    return translate("common:status.failed");
  },
};

const showError = (error: Error) => toast.error(error.message);

function took(run: Run) {
  if (!run.finished_at) return null;
  const seconds = Math.round(
    (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) /
      1000,
  );
  return seconds < 60
    ? translate("common:time.durationSeconds", { seconds })
    : translate("common:time.durationMinutesSeconds", {
        minutes: Math.floor(seconds / 60),
        seconds: seconds % 60,
      });
}

/** A run as a small square: filled when it sent a report. */
function RunMark({ status }: { status: RunStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0",
        status === "sent" && "bg-foreground",
        status === "nothing_new" && "border border-muted-foreground/50",
        status === "failed" && "bg-destructive",
        status === "running" &&
          "border border-foreground motion-safe:animate-pulse",
      )}
    />
  );
}

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

// --- list -----------------------------------------------------------------------

/** The last runs, oldest first, on a fixed-width track. */
function History({
  runs,
  length = 14,
}: {
  runs: ListedRun[];
  length?: number;
}) {
  useTranslation(["routines", "common", "navigation"] as const);
  const recent = runs.slice(0, length).reverse();
  return (
    <span
      role="img"
      aria-label={recent
        .map((run) => runStatusLabels[run.status])
        .join(listSeparator())}
      className="flex items-center gap-0.5"
    >
      {Array.from({ length: length - recent.length }, (_, i) => (
        <span key={i} className="size-2 bg-muted" />
      ))}
      {recent.map((run) => (
        <RunMark key={run.id} status={run.status} />
      ))}
    </span>
  );
}

function NextRun({ routine }: { routine: RoutineSummary }) {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  if (routine.runs[0]?.status === "running")
    return (
      <span className="inline-flex items-center gap-1.5 text-foreground">
        <span className="size-1.5 bg-foreground motion-safe:animate-pulse" />
        {translateText("common:status.running")}
      </span>
    );
  if (!routine.enabled) return translateText("common:status.paused");
  return routine.next_run_at ? when(routine.next_run_at) : "—";
}

/**
 * The routines; `selected` marks the one open beside the list, and `bare`
 * leaves the heading to the page around it.
 */
export function RoutineList({
  selected,
  bare = false,
}: {
  selected?: string | null;
  bare?: boolean;
}) {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  const [, setNav] = useRoutineNav();
  const { data, error, refetch } = useRoutines();
  return (
    <div className="space-y-2">
      <div
        className={cn("flex items-center justify-between", bare && "hidden")}
      >
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={translateText("actions.create")}
          title={translateText("common:actions.new")}
          onClick={() => void setNav({ edit: "new" })}
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </div>
      {error && !data ? (
        <LoadError
          what={translateText("title")}
          error={error}
          onRetry={() => void refetch()}
        />
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty
          icon={ClockIcon}
          title={translateText("empty.title")}
          action={
            <Button size="sm" onClick={() => void setNav({ edit: "new" })}>
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              {translateText("actions.create")}
            </Button>
          }
        >
          {translateText("empty.description")}
        </Empty>
      ) : (
        <ul aria-label={translateText("title")} className="-mx-2">
          {data.map((routine) => (
            <li key={routine.id}>
              <button
                type="button"
                onClick={() =>
                  void setNav({ routine: routine.id, run: null, edit: null })
                }
                aria-current={routine.id === selected ? "true" : undefined}
                className={cn(
                  "grid w-full grid-cols-[1fr_auto_5.5rem] items-center gap-4 px-2 py-2 text-left transition-colors duration-[60ms] ease-linear outline-none hover:bg-muted/60 focus-visible:bg-muted/60 aria-[current]:bg-muted",
                  !routine.enabled && "text-muted-foreground",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {routine.name}
                  </span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {describeSchedule(routine.schedule)}
                  </span>
                </span>
                <span className={routine.enabled ? undefined : "opacity-40"}>
                  <History runs={routine.runs} length={bare ? 7 : 14} />
                </span>
                <span className="text-right text-xs text-muted-foreground tabular-nums">
                  <NextRun routine={routine} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- detail ---------------------------------------------------------------------

type Moment =
  | { kind: "next"; at: string }
  | { kind: "run"; at: string; run: Run }
  | { kind: "brief"; at: string; brief: BriefVersion };

/** The next run, then runs and brief revisions, newest first. */
function moments(routine: Routine): Moment[] {
  const past: Moment[] = [
    ...routine.runs.map((run) => ({
      kind: "run" as const,
      at: run.started_at,
      run,
    })),
    ...routine.briefs.map((brief) => ({
      kind: "brief" as const,
      at: brief.created_at,
      brief,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const idle = routine.runs[0]?.status !== "running";
  return routine.enabled && routine.next_run_at && idle
    ? [{ kind: "next", at: routine.next_run_at }, ...past]
    : past;
}

/** A row on the timeline: its mark on the rail, the time, then what. */
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
  useTranslation(["routines", "common", "navigation"] as const);
  return (
    <li className="relative grid grid-cols-[0.75rem_5.25rem_1fr] gap-x-2 pb-3">
      {last ? null : (
        <span
          aria-hidden="true"
          className="absolute top-3.5 bottom-0 left-[calc(0.375rem-0.5px)] w-px bg-border"
        />
      )}
      <span className="flex h-5 items-center justify-center">{mark}</span>
      <span className="text-xs leading-5 text-muted-foreground tabular-nums">
        {when(at)}
      </span>
      <div className="min-w-0 text-sm leading-5">{children}</div>
    </li>
  );
}

function RunMoment({
  routine,
  run,
  handoff,
  last,
}: {
  routine: Routine;
  run: Run;
  handoff: boolean;
  last: boolean;
}) {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  const [, setNav] = useRoutineNav();
  const open = () => void setNav({ routine: routine.id, run: run.id });
  return (
    <Entry
      mark={<RunMark status={run.status} />}
      at={run.started_at}
      last={last}
    >
      {run.status === "sent" ? (
        <button
          type="button"
          onClick={open}
          className="block max-w-full truncate text-left underline-offset-4 outline-none hover:underline focus-visible:underline"
        >
          {run.title}
        </button>
      ) : (
        <p
          className={cn(
            "truncate",
            run.status === "failed"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {run.error ?? runStatusLabels[run.status]}
        </p>
      )}
      {run.feedback.map((feedback) => (
        <button
          type="button"
          key={feedback.id}
          onClick={open}
          className="block max-w-full truncate text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
        >
          “{feedback.text}”
        </button>
      ))}
      {handoff && routine.handoff ? (
        <p
          title={translateText("reports.handoffNotes", {
            notes: routine.handoff.text,
          })}
          className="mt-1 line-clamp-2 border-l pl-2 text-xs text-muted-foreground"
        >
          {routine.handoff.text}
        </p>
      ) : null}
    </Entry>
  );
}

function BriefMoment({
  routine,
  brief,
  last,
}: {
  routine: Routine;
  brief: BriefVersion;
  last: boolean;
}) {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  const restore = useRestoreBrief();
  const current = brief.version === routine.briefs[0].version;
  return (
    <Entry
      mark={
        <span
          aria-hidden="true"
          className="size-[7px] rotate-45 border border-foreground bg-card"
        />
      }
      at={brief.created_at}
      last={last}
    >
      <div className="group flex items-center gap-2">
        <p className="min-w-0 truncate text-muted-foreground">
          <span className="text-foreground">
            {brief.version === 1
              ? translateText("common:actions.create")
              : translateText("brief.version", { version: brief.version })}
          </span>
          {brief.feedback
            ? translateText("brief.revisedFrom", { feedback: brief.feedback })
            : null}
        </p>
        {current ? null : (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto h-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            disabled={restore.isPending}
            onClick={() =>
              restore.mutate(
                { id: routine.id, version: brief.version },
                {
                  onSuccess: () =>
                    toast(
                      translateText("brief.restored", {
                        version: brief.version,
                      }),
                    ),
                  onError: showError,
                },
              )
            }
          >
            {translateText("common:actions.resume")}
          </Button>
        )}
      </div>
    </Entry>
  );
}

function Timeline({ routine }: { routine: Routine }) {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  const all = moments(routine);
  const latest = routine.runs.find((run) => run.status !== "running");
  return (
    <ol aria-label={translateText("common:labels.timeline")}>
      {all.map((moment, i) => {
        const last = i === all.length - 1;
        if (moment.kind === "next")
          return (
            <Entry
              key="next"
              mark={
                <span className="size-2 border border-dashed border-muted-foreground" />
              }
              at={moment.at}
              last={last}
            >
              <span className="text-muted-foreground">
                {translateText("schedule.nextRun")}
              </span>
            </Entry>
          );
        if (moment.kind === "brief")
          return (
            <BriefMoment
              key={`v${moment.brief.version}`}
              routine={routine}
              brief={moment.brief}
              last={last}
            />
          );
        return (
          <RunMoment
            key={moment.run.id}
            routine={routine}
            run={moment.run}
            handoff={moment.run.id === latest?.id}
            last={last}
          />
        );
      })}
    </ol>
  );
}

/** A routine; `listed` when the list stays in view beside it on wide screens. */
export function RoutineDetail({
  routine,
  listed = false,
}: {
  routine: Routine;
  listed?: boolean;
}) {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  const [, setNav] = useRoutineNav();
  const setEnabled = useSetRoutineEnabled();
  const runNow = useRunRoutineNow();
  const remove = useDeleteRoutine();
  const [brief] = routine.briefs;
  const [expanded, setExpanded] = useState(false);
  const running = routine.runs[0]?.status === "running";
  // Opened: its reports and failures so far are seen.
  const finished = routine.runs.find((run) => run.finished_at)?.id;
  const { mutate: markSeen } = useMarkRoutineSeen();
  useEffect(() => {
    if (finished) markSeen(routine.id);
  }, [routine.id, finished, markSeen]);
  return (
    <div className="space-y-4">
      <div>
        <span className={listed ? "md:hidden" : undefined}>
          <Back
            label={translateText("title")}
            onClick={() => void setNav({ routine: null })}
          />
        </span>
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
            {routine.name}
          </h2>
          <Switch
            checked={routine.enabled}
            aria-label={
              routine.enabled
                ? translateText("common:actions.pause")
                : translateText("common:actions.enable")
            }
            title={
              routine.enabled
                ? translateText("common:actions.pause")
                : translateText("common:actions.enable")
            }
            onCheckedChange={(enabled) =>
              setEnabled.mutate(
                { id: routine.id, enabled },
                { onError: showError },
              )
            }
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={translateText("actions.runNow")}
            title={translateText("actions.runNow")}
            disabled={running || runNow.isPending}
            onClick={() => runNow.mutate(routine.id, { onError: showError })}
          >
            <PlayIcon aria-hidden="true" />
          </Button>
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
                onSelect={() => void setNav({ edit: routine.id })}
              >
                {translateText("common:actions.edit")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  remove.mutate(routine.id, {
                    onSuccess: () => void setNav({ routine: null }),
                    onError: showError,
                  })
                }
              >
                {translateText("common:actions.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {describeSchedule(routine.schedule)} · {routine.timezone} ·{" "}
          {routine.model}
        </p>
        <UsageLine principal={`routine-${routine.id}`} />
      </div>

      <button
        type="button"
        aria-expanded={expanded}
        aria-label={translateText("brief.version", {
          version: brief.version,
        })}
        onClick={() => setExpanded(!expanded)}
        className="block w-full border-l-2 border-foreground pl-3 text-left outline-none focus-visible:bg-muted/60"
      >
        <span
          className={cn(
            "block text-sm leading-relaxed whitespace-pre-wrap",
            expanded ? null : "line-clamp-3",
          )}
        >
          {brief.text}
        </span>
      </button>

      <Timeline routine={routine} />
    </div>
  );
}

// --- report ---------------------------------------------------------------------

function FeedbackForm({ routine, run }: { routine: Routine; run: Run }) {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  const [text, setText] = useState("");
  const send = useSendFeedback();
  const submit = () => {
    const value = text.trim();
    if (!value || send.isPending) return;
    send.mutate(
      { id: routine.id, runId: run.id, text: value },
      { onSuccess: () => setText(""), onError: showError },
    );
  };
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label={translateText("feedback.label")}
        placeholder={translateText("feedback.placeholder")}
        value={text}
        rows={1}
        maxLength={4000}
        className="min-h-8 resize-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button type="submit" disabled={!text.trim() || send.isPending}>
        {translateText("common:actions.send")}
      </Button>
    </form>
  );
}

export function RunView({ routine, run }: { routine: Routine; run: Run }) {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  const [, setNav] = useRoutineNav();
  const reports = routine.runs.filter((r) => r.status === "sent");
  const index = reports.findIndex((r) => r.id === run.id);
  const newer = reports[index - 1];
  const older = reports[index + 1];
  const duration = took(run);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Back label={routine.name} onClick={() => void setNav({ run: null })} />
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {when(run.started_at)}
          {duration ? ` · ${duration}` : ""}
        </span>
        <span className="flex">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={translateText("reports.previous")}
            disabled={!older}
            onClick={() => older && void setNav({ run: older.id })}
          >
            <CaretLeftIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={translateText("reports.next")}
            disabled={!newer}
            onClick={() => newer && void setNav({ run: newer.id })}
          >
            <CaretRightIcon aria-hidden="true" />
          </Button>
        </span>
      </div>
      {run.report ? (
        <Markdown className="text-sm">{run.report}</Markdown>
      ) : run.error ? (
        <p role="alert" className="text-sm text-destructive">
          {run.error}
        </p>
      ) : null}
      <section
        aria-label={translateText("feedback.label")}
        className="space-y-2"
      >
        {run.feedback.map((feedback) => (
          <div key={feedback.id} className="border-l-2 border-foreground pl-3">
            <p className="text-sm">{feedback.text}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {when(feedback.created_at)} ·{" "}
              {feedback.revision_failed ? (
                <span className="text-destructive">
                  {translateText("feedback.revisionFailed")}
                </span>
              ) : feedback.brief_version === null ? (
                <span className="motion-safe:animate-pulse">
                  {translateText("feedback.revising")}
                </span>
              ) : (
                <button
                  type="button"
                  className="underline-offset-4 outline-none hover:underline focus-visible:underline"
                  onClick={() => void setNav({ run: null })}
                >
                  {translateText("feedback.briefUpdated", {
                    version: feedback.brief_version,
                  })}
                </button>
              )}
            </p>
          </div>
        ))}
        <FeedbackForm routine={routine} run={run} />
      </section>
    </div>
  );
}

// --- tab --------------------------------------------------------------------------

/** Where a routine would be: loading, failed, or gone. */
export function RoutineMissing({
  isPending,
  error,
  onRetry,
}: {
  isPending: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  if (error)
    return (
      <LoadError
        what={translateText("title")}
        error={error}
        onRetry={onRetry}
      />
    );
  if (isPending) return <Loading layout="detail" />;
  return (
    <Empty icon={ClockIcon} title={translateText("empty.deletedTitle")}>
      {translateText("common:empty.mayBeDeleted")}
    </Empty>
  );
}

/** Routines: agents that run on a schedule and leave reports. */
export function Routines() {
  const { t: translateText } = useTranslation([
    "routines",
    "common",
    "navigation",
  ] as const);
  const [nav, setNav] = useRoutineNav();
  const editing = nav.edit && nav.edit !== "new" ? nav.edit : null;
  const {
    data: routine,
    isPending,
    error,
    refetch,
  } = useRoutine(nav.routine ?? editing);

  if (nav.edit === "new")
    return (
      <RoutineForm
        routine={null}
        onDone={(id) => void setNav({ edit: null, routine: id ?? null })}
      />
    );
  if (editing && routine)
    return (
      <RoutineForm
        routine={routine}
        onDone={() => void setNav({ edit: null })}
      />
    );
  if (!nav.routine && !editing) return <RoutineList />;
  if (!routine)
    return (
      <div className="space-y-3">
        <Back
          label={translateText("title")}
          onClick={() => void setNav({ edit: null, routine: null, run: null })}
        />
        <RoutineMissing
          isPending={isPending}
          error={error}
          onRetry={() => void refetch()}
        />
      </div>
    );
  const run = routine.runs.find((r) => r.id === nav.run);
  return run ? (
    <RunView routine={routine} run={run} />
  ) : (
    <RoutineDetail routine={routine} />
  );
}
