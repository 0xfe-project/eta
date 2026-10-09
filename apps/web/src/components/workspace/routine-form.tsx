import type { HourlySchedule } from "@/api/control-plane.gen";
import type { Routine, Schedule } from "@/queries/routines";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useModels } from "@/queries/llm";
import { useSaveRoutine } from "@/queries/routines";
import { ModelSelect } from "./agent-editor";
import { occurrences, when } from "./routine-format";

const KINDS = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "hourly", label: "每隔几小时" },
  { value: "cron", label: "自定义 cron" },
] as const;

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
// The intervals the control plane accepts.
const HOURS: HourlySchedule["every"][] = [1, 2, 3, 4, 6, 8, 12];

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

/** The next few run times, in this browser's time zone; none for cron. */
function nextRuns(schedule: Schedule) {
  const now = new Date();
  const later = new Date(now.getTime() + 60 * 86_400_000);
  return occurrences(schedule, now, later).slice(0, 3);
}

function ScheduleFields({
  schedule,
  onChange,
}: {
  schedule: Schedule;
  onChange: (schedule: Schedule) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label="频率"
        value={schedule.kind}
        onChange={(e) =>
          onChange(defaults(e.target.value as Schedule["kind"], schedule))
        }
      >
        {KINDS.map((kind) => (
          <NativeSelectOption key={kind.value} value={kind.value}>
            {kind.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {schedule.kind === "weekly" ? (
        <div role="group" aria-label="星期" className="flex">
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
                  "-ml-px size-8 border text-xs transition-colors duration-[60ms] first:ml-0",
                  on
                    ? "relative z-10 border-foreground bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
      {schedule.kind === "daily" || schedule.kind === "weekly" ? (
        <Input
          type="time"
          aria-label="时间"
          className="w-32"
          value={schedule.time}
          onChange={(e) =>
            e.target.value && onChange({ ...schedule, time: e.target.value })
          }
        />
      ) : null}
      {schedule.kind === "hourly" ? (
        <NativeSelect
          aria-label="间隔"
          value={String(schedule.every)}
          onChange={(e) =>
            onChange({
              ...schedule,
              every: Number(e.target.value) as HourlySchedule["every"],
            })
          }
        >
          {HOURS.map((n) => (
            <NativeSelectOption key={n} value={n}>
              {n} 小时
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
      {schedule.kind === "cron" ? (
        <Input
          aria-label="cron 表达式"
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
  const { data: models } = useModels();
  const save = useSaveRoutine();
  const [name, setName] = useState(routine?.name ?? "");
  const [brief, setBrief] = useState(routine?.briefs[0]?.text ?? "");
  const [model, setModel] = useState(routine?.model ?? "");
  const [schedule, setSchedule] = useState<Schedule>(
    routine?.schedule ?? { kind: "daily", time: "08:00" },
  );
  const [timezone, setTimezone] = useState(
    () => routine?.timezone ?? browserZone(),
  );
  const zones = ZONES.includes(timezone) ? ZONES : [timezone, ...ZONES];
  const preview = nextRuns(schedule);
  const ready = name.trim() && brief.trim() && model;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        save.mutate(
          {
            id: routine?.id ?? null,
            input: {
              name: name.trim(),
              brief: brief.trim(),
              model,
              schedule,
              timezone,
            },
          },
          {
            onSuccess: (id) => onDone(id),
            onError: (error) => toast.error(error.message),
          },
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
          {routine ? routine.name : "定时任务"}
        </Button>
        <h2 className="text-sm font-semibold">
          {routine ? "编辑" : "新建定时任务"}
        </h2>
      </div>
      <Field id="routine-name" label="名称">
        <Input
          id="routine-name"
          placeholder="例如：科技日报"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field id="routine-brief" label="要求">
        <Textarea
          id="routine-brief"
          rows={6}
          maxLength={8000}
          className="min-h-32"
          placeholder="例如：每天早上整理 Hacker News 和 36 氪的科技新闻，挑出最重要的 3 条，每条一两句话说明为什么重要，附原文链接。发过的不要重复；没有新内容就不发。"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
      </Field>
      <Field
        label="计划"
        hint={
          preview.length ? (
            <span className="tabular-nums">
              {preview.map((d) => when(d.toISOString())).join("、")}…
            </span>
          ) : (
            "分 时 日 月 星期"
          )
        }
      >
        <ScheduleFields schedule={schedule} onChange={setSchedule} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="时区">
          <NativeSelect
            aria-label="时区"
            className="w-full"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {zones.map((zone) => (
              <NativeSelectOption key={zone} value={zone}>
                {zone}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="模型">
          <ModelSelect
            aria-label="模型"
            value={model}
            models={models}
            onChange={(e) => setModel(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => onDone()}>
          取消
        </Button>
        <Button type="submit" disabled={!ready || save.isPending}>
          {routine ? "保存" : "创建"}
        </Button>
      </div>
    </form>
  );
}
