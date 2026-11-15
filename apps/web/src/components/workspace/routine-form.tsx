import type { HourlyStep } from "@eta/client-contracts";
import type { Routine, Schedule } from "@/queries/routines";
import { HOURLY_STEPS } from "@eta/client-contracts";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { listSeparator, translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useConversationList } from "@/queries/conversations";
import { useModels } from "@/queries/providers";
import { useCreateRoutine, useUpdateRoutine } from "@/queries/routines";
import { wireErrorMessage } from "@/queries/wire";
import { ModelSelect } from "./model-select";
import { occurrences, when } from "./routine-format";
import { Select, SelectOption } from "./select-field";
import { useWorkspaceStore } from "./workspace-store";

const KINDS = [
  {
    value: "daily",
    get label() {
      return translate("routines:schedule.kinds.daily");
    },
  },
  {
    value: "weekly",
    get label() {
      return translate("common:time.windows.weekly");
    },
  },
  {
    value: "hourly",
    get label() {
      return translate("routines:schedule.kinds.hourly");
    },
  },
  {
    value: "cron",
    get label() {
      return translate("routines:schedule.kinds.cron");
    },
  },
] as const;

const WEEKDAYS = [
  "common:weekdays.monday",
  "common:weekdays.tuesday",
  "common:weekdays.wednesday",
  "common:weekdays.thursday",
  "common:weekdays.friday",
  "common:weekdays.saturday",
  "common:weekdays.sunday",
] as const;

const browserZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
const ZONES = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

function defaults(kind: Schedule["kind"], from: Schedule): Schedule {
  const time = "time" in from ? from.time : "08:00";
  switch (kind) {
    case "daily":
      return { kind, time };
    case "weekly":
      return { kind, days: [1], time };
    case "hourly":
      return { kind, every: 6 };
    case "cron":
      return { kind, cron: "0 8 * * 1-5" };
  }
}

/** The next few run times, in the routine's time zone; none for cron. */
function nextRuns(schedule: Schedule, timeZone: string) {
  const now = new Date();
  const later = new Date(now.getTime() + 60 * 86_400_000);
  return occurrences(schedule, now, later, timeZone).slice(0, 3);
}

function ScheduleFields({
  schedule,
  onChange,
}: {
  schedule: Schedule;
  onChange: (schedule: Schedule) => void;
}) {
  const { t: translateText } = useTranslation([
    "routines",
    "agents",
    "common",
    "providers",
  ] as const);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label={translateText("schedule.frequencyLabel")}
        value={schedule.kind}
        onValueChange={(value) =>
          onChange(defaults(value as Schedule["kind"], schedule))
        }
      >
        {KINDS.map((kind) => (
          <SelectOption key={kind.value} value={kind.value}>
            {kind.label}
          </SelectOption>
        ))}
      </Select>
      {schedule.kind === "weekly" ? (
        <div
          role="group"
          aria-label={translateText("schedule.weekdaysLabel")}
          className="flex"
        >
          {WEEKDAYS.map((label, i) => {
            const day = (i + 1) % 7;
            const on = schedule.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const days = on
                    ? schedule.days.filter((d) => d !== day)
                    : [...schedule.days, day].sort();
                  if (days.length) onChange({ ...schedule, days });
                }}
                className={cn(
                  "-ml-px size-8 border text-xs duration-[60ms] first:ml-0",
                  on
                    ? "relative z-10 border-foreground bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {translateText(label)}
              </button>
            );
          })}
        </div>
      ) : null}
      {schedule.kind === "daily" || schedule.kind === "weekly" ? (
        <Input
          type="time"
          aria-label={translateText("schedule.timeLabel")}
          className="w-32"
          value={schedule.time}
          onChange={(e) =>
            e.target.value && onChange({ ...schedule, time: e.target.value })
          }
        />
      ) : null}
      {schedule.kind === "hourly" ? (
        <Select
          aria-label={translateText("schedule.intervalLabel")}
          value={String(schedule.every)}
          onValueChange={(value) =>
            onChange({
              ...schedule,
              every: Number(value) as HourlyStep,
            })
          }
        >
          {HOURLY_STEPS.map((n) => (
            <SelectOption key={n} value={n}>
              {translateText("common:time.hours", { count: n })}
            </SelectOption>
          ))}
        </Select>
      ) : null}
      {schedule.kind === "cron" ? (
        <Input
          aria-label={translateText("schedule.cronLabel")}
          className="w-40 font-mono"
          value={schedule.cron}
          spellCheck={false}
          onChange={(e) => onChange({ ...schedule, cron: e.target.value })}
        />
      ) : null}
    </div>
  );
}

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

/** Creates a routine, or edits one; editing the brief adds a version. */
export function RoutineForm({
  routine,
  onDone,
}: {
  routine: Routine | null;
  onDone: (id?: string) => void;
}) {
  const { t: translateText } = useTranslation([
    "routines",
    "agents",
    "common",
    "providers",
  ] as const);
  const { data: models } = useModels();
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const lastModel = useWorkspaceStore((s) => s.workspace.lastModel);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const noModels =
    models !== undefined && !models.some((item) => item.available);
  const create = useCreateRoutine();
  const update = useUpdateRoutine();
  // The group a new routine belongs to: the one you have open. Read from the cached snapshot so
  // this form works the same in the panel, the full-window page and a test.
  const { conversations } = useConversationList();
  const selectedGroupId = useWorkspaceStore((s) => s.workspace.selectedGroupId);
  const group =
    conversations.find((candidate) => candidate.id === selectedGroupId) ?? null;
  const [name, setName] = useState(routine?.name ?? "");
  const [brief, setBrief] = useState(routine?.briefs[0]?.text ?? "");
  // A routine runs on eta's own loop, which has no default model: it names one. A new routine
  // starts on the last used model, else the first usable one; one saved without a model (from
  // before) waits for a choice.
  const usable = (models ?? []).filter((item) => item.available);
  const [picked, setModel] = useState(routine?.model ?? "");
  const model =
    picked ||
    (routine === null
      ? ((usable.find((item) => item.id === lastModel) ?? usable[0])?.id ?? "")
      : "");
  // Chosen once, then removed from the providers: said, never swapped for another.
  const modelGone =
    model !== "" &&
    models !== undefined &&
    !models.some((item) => item.id === model);
  const [schedule, setSchedule] = useState<Schedule>(
    routine?.schedule ?? { kind: "daily", time: "08:00" },
  );
  const [timezone, setTimezone] = useState(
    () => routine?.timezone ?? browserZone(),
  );
  const zones = ZONES.includes(timezone) ? ZONES : [timezone, ...ZONES];
  const preview = nextRuns(schedule, timezone);
  const ready = name.trim() && brief.trim() && model;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        const fields = {
          name: name.trim(),
          brief: brief.trim(),
          model,
          schedule,
          timezone,
        };
        setWorkspace((state) => ({ ...state, lastModel: model }));
        const onError = (error: Error) => toast.error(wireErrorMessage(error));
        if (routine === null)
          create.mutate(
            {
              ...fields,
              // The conversation whose folder and members it runs with. Omitted when there is
              // none open: "no conversation" is a state the list shows, not something to guess at.
              ...(group === null ? {} : { conversationId: group.id }),
            },
            { onSuccess: (result) => onDone(result.routine.id), onError },
          );
        else
          update.mutate(
            { routineId: routine.id, ...fields },
            { onSuccess: () => onDone(routine.id), onError },
          );
      }}
    >
      <div className="space-y-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 px-2 text-muted-foreground"
          onClick={() => onDone()}
        >
          <ArrowLeftIcon aria-hidden="true" />
          {routine ? routine.name : translateText("title")}
        </Button>
        <h2 className="text-sm font-semibold">
          {routine
            ? translateText("common:actions.edit")
            : translateText("actions.create")}
        </h2>
      </div>
      <Field id="routine-name" label={translateText("common:labels.name")}>
        <Input
          id="routine-name"
          placeholder={translateText("fields.namePlaceholder")}
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field id="routine-brief" label={translateText("fields.briefLabel")}>
        <Textarea
          id="routine-brief"
          rows={6}
          maxLength={8000}
          className="min-h-32"
          placeholder={translateText("fields.briefPlaceholder")}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
      </Field>
      <Field
        label={translateText("fields.scheduleLabel")}
        hint={
          preview.length ? (
            <span className="tabular-nums">
              {preview.map((d) => when(d.getTime())).join(listSeparator())}…
              {timezone === browserZone()
                ? null
                : translateText("schedule.localTimeSuffix")}
            </span>
          ) : (
            translateText("schedule.cronSyntaxHint")
          )
        }
      >
        <ScheduleFields schedule={schedule} onChange={setSchedule} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={translateText("schedule.timeZoneLabel")}>
          <Select
            aria-label={translateText("schedule.timeZoneLabel")}
            className="w-full"
            value={timezone}
            onValueChange={(value) => setTimezone(value)}
          >
            {zones.map((zone) => (
              <SelectOption key={zone} value={zone}>
                {zone}
              </SelectOption>
            ))}
          </Select>
        </Field>
        <Field
          id="routine-model"
          label={translateText("common:entities.model")}
          hint={
            noModels ? (
              <span id="routine-model-hint">
                {translateText("agents:models.noneAvailable")}
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto px-1"
                  onClick={() =>
                    setSettings({ open: true, section: "providers" })
                  }
                >
                  {translateText("providers:actions.openSettings")}
                </Button>
              </span>
            ) : modelGone ? (
              <span id="routine-model-hint" className="text-state-warning">
                {translateText("agents:models.gone")}
              </span>
            ) : undefined
          }
        >
          <ModelSelect
            id="routine-model"
            aria-label={translateText("common:entities.model")}
            aria-describedby={
              noModels || modelGone ? "routine-model-hint" : undefined
            }
            value={model}
            models={models}
            invalid={modelGone}
            onValueChange={(value) => setModel(value)}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => onDone()}>
          {translateText("common:actions.cancel")}
        </Button>
        <Button
          type="submit"
          disabled={!ready || create.isPending || update.isPending}
        >
          {routine
            ? translateText("common:actions.save")
            : translateText("common:actions.create")}
        </Button>
      </div>
    </form>
  );
}
