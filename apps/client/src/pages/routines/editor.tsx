import type {
  RoutineFields,
  RoutineInfo,
  RoutineResults,
  RoutineSchedule,
} from "@eta/client-contracts";
import { HOURLY_STEPS } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  Caption,
  colors,
  Field,
  grow,
  Label,
  Modal,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { weekday } from "./schedule";

export function RoutineEditor(props: {
  phone: boolean;
  inline?: boolean;
  item?: RoutineInfo;
  brief?: string;
  onClose: () => void;
  onSave: (id: string) => void;
}) {
  const host = useHost();
  const name = signal(props.item?.name ?? "");
  const brief = signal(props.brief ?? "");
  const existing = props.item?.schedule;
  const kind = signal<RoutineSchedule["kind"]>(existing?.kind ?? "daily");
  const at = signal(
    existing?.kind === "daily" || existing?.kind === "weekly"
      ? existing.time
      : "08:00",
  );
  const days = signal<number[]>(
    existing?.kind === "weekly" ? existing.days : [1],
  );
  const every = signal<(typeof HOURLY_STEPS)[number]>(
    existing?.kind === "hourly" ? existing.every : 1,
  );
  const cron = signal(existing?.kind === "cron" ? existing.cron : "");
  const kinds = {
    daily: "dailySchedule",
    weekly: "weeklySchedule",
    hourly: "hourlySchedule",
    cron: "cronSchedule",
  } as const;
  const c = colors();
  function schedule(): RoutineSchedule | undefined {
    switch (kind()) {
      case "daily":
      case "weekly": {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at().trim())) return undefined;
        if (kind() === "daily") return { kind: "daily", time: at().trim() };
        if (days().length)
          return {
            kind: "weekly",
            time: at().trim(),
            days: [...days()].sort(),
          };
        return undefined;
      }
      case "hourly":
        return { kind: "hourly", every: every() };
      case "cron":
        if (cron().trim().split(/\s+/).length === 5)
          return { kind: "cron", cron: cron().trim() };
        return undefined;
    }
  }
  const timezone = signal(
    props.item?.timezone ??
      new Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
  );
  const busy = signal(false);
  const valid = () =>
    name().trim() && brief().trim() && timezone().trim() && schedule();
  async function save() {
    const selected = schedule();
    if (!selected || !valid() || busy()) return;
    busy.set(true);
    const fields: RoutineFields = {
      name: name().trim(),
      brief: brief().trim(),
      timezone: timezone().trim(),
      schedule: selected,
    };
    const result = await host.action(() =>
      host.call<RoutineResults["create"]>(
        "routines",
        props.item ? "update" : "create",
        props.item ? { ...fields, routineId: props.item.id } : fields,
      ),
    );
    busy.set(false);
    if (result) {
      props.onClose();
      props.onSave(result.routine.id);
    }
  }
  const form = () => (
    <View style={{ padding: 16, gap: 8 }}>
      <Field
        label={uiText("name")}
        placeholder={uiText("name")}
        value={name()}
        onChange={name.set}
      />
      <Field
        label={uiText("instructions")}
        placeholder={uiText("whatShouldCaptainDoEachTime")}
        value={brief()}
        onChange={brief.set}
        multiline
        style={{ height: 112 }}
      />
      <Caption text={uiText("schedule")} />
      <View style={{ ...row, gap: 8, flexWrap: "wrap" }}>
        <ActionMenu
          label={uiText("scheduleFrequency")}
          value={uiText(kinds[kind()])}
        >
          <Each of={Object.keys(kinds) as RoutineSchedule["kind"][]}>
            {(option) => (
              <ActionItem
                label={uiText(kinds[option()])}
                checked={kind() === option()}
                onSelect={() => kind.set(option())}
              />
            )}
          </Each>
        </ActionMenu>
        <If when={kind() === "weekly"}>
          <View style={row}>
            <Each of={[1, 2, 3, 4, 5, 6, 0]}>
              {(day) => (
                <Button
                  label={weekday(day())}
                  size={28}
                  selected={days().includes(day())}
                  tone={days().includes(day()) ? "primary" : "ghost"}
                  onPress={() =>
                    days.update((previous) =>
                      previous.includes(day())
                        ? previous.filter((item) => item !== day())
                        : [...previous, day()],
                    )
                  }
                />
              )}
            </Each>
          </View>
        </If>
        <If when={kind() === "weekly" || kind() === "daily"}>
          <Field
            label={uiText("time")}
            placeholder="HH:MM"
            value={at()}
            onChange={at.set}
            style={{ width: 100 }}
          />
        </If>
        <If when={kind() === "hourly"}>
          <ActionMenu
            label={uiText("repeatEvery")}
            value={
              every() === 1
                ? uiText("everyHour")
                : uiText("everyHours", { hours: every() })
            }
          >
            <Each of={HOURLY_STEPS}>
              {(hours) => (
                <ActionItem
                  label={
                    hours() === 1
                      ? uiText("everyHour")
                      : uiText("everyHours", { hours: hours() })
                  }
                  checked={every() === hours()}
                  onSelect={() => every.set(hours())}
                />
              )}
            </Each>
          </ActionMenu>
        </If>
      </View>
      <If when={kind() === "cron"}>
        <Field
          label={uiText("cronExpression")}
          placeholder="0 8 * * 1–5"
          value={cron()}
          onChange={cron.set}
        />
        <Label size={12} tone="muted">
          {uiText("minuteHourDayOfMonthMonth")}
        </Label>
      </If>
      <Field
        label={uiText("timeZone")}
        value={timezone()}
        onChange={timezone.set}
      />
      <View
        style={{
          ...row,
          gap: 8,
          justifyContent: "flex-end",
          borderTopWidth: 1,
          borderColor: c().border,
          paddingTop: 8,
        }}
      >
        <Button
          label={uiText("cancel")}
          disabled={busy()}
          onPress={props.onClose}
        />
        <Button
          label={props.item ? uiText("saveChanges") : uiText("createRoutine")}
          tone="primary"
          disabled={!valid() || busy()}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
  return (
    <If
      when={props.inline}
      else={
        <Modal
          title={props.item ? uiText("editRoutine") : uiText("newRoutine")}
          phone={props.phone}
          width={540}
          onClose={props.onClose}
        >
          {form()}
        </Modal>
      }
    >
      <Scroll style={grow}>
        <View style={{ padding: 12, paddingBottom: 0, gap: 6 }}>
          <Button
            label={uiText("routines2")}
            icon="back"
            tone="ghost"
            style={{ alignSelf: "flex-start" }}
            onPress={props.onClose}
          />
          <Label size={15} weight={600} style={{ paddingHorizontal: 4 }}>
            {props.item ? uiText("editRoutine") : uiText("newRoutine")}
          </Label>
        </View>
        {form()}
      </Scroll>
    </If>
  );
}
