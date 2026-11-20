import type {
  RoutineFields,
  RoutineInfo,
  RoutineResults,
  RoutineSchedule,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import { HOURLY_STEPS } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import { TimeField } from "nsh/base";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  fontFamily,
  Fonts,
  grow,
  Icon,
  Label,
  Modal,
  row,
} from "../../components";
import { formatLocale, uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { upcomingTimes, weekday } from "./schedule";

export function RoutineEditor(props: {
  phone: boolean;
  inline?: boolean;
  tablet?: boolean;
  item?: RoutineInfo;
  brief?: string;
  onClose: () => void;
  onSave: (id: string) => void;
}) {
  const host = useHost();
  const name = signal(props.item?.name ?? "");
  const brief = signal(props.brief ?? "");
  const existing = props.item?.schedule;
  const kind = signal<RoutineSchedule["kind"]>(existing?.kind ?? "weekly");
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
  const fonts = Fonts();
  const preview = () => {
    const selected = schedule();
    return selected ? upcomingTimes(selected, timezone()) : "";
  };
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
  const zones = () => {
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes(timezone()) ? all : [timezone(), ...all];
  };
  // The tablet form uses 32px controls with a 10px inset; the desktop one 28px and 8px.
  const control = () => (props.tablet ? 32 : 28);
  const controlInset = () => (props.tablet ? 10 : 8);
  const input = () => ({
    height: control(),
    paddingHorizontal: controlInset(),
    fontSize: 12,
    lineHeight: 16,
  });
  const select = () => ({
    height: control(),
    paddingHorizontal: controlInset(),
    gap: 8,
    borderColor: c().border,
  });
  const field = (label: string, content: JSX.Element, width?: number) => (
    <View style={{ gap: 6, width: width ?? "100%", maxWidth: "100%" }}>
      <Label size={12} line={16}>
        {label}
      </Label>
      {content}
    </View>
  );
  const time = () => (
    <If when={kind() === "weekly" || kind() === "daily"}>
      <View
        style={{
          ...row,
          width: props.tablet ? 110 : 114,
          height: control(),
          gap: 8,
          paddingHorizontal: controlInset(),
          justifyContent: "space-between",
          borderWidth: 1,
          borderColor: c().border,
        }}
      >
        <TimeField
          accessibilityLabel={uiText("time")}
          value={at()}
          hourCycle={formatLocale() === "zh-CN" ? "h23" : "h12"}
          onChange={({ value }) => at.set(value)}
          style={{ ...row }}
          renderSegment={(entry) => (
            <Label
              size={12}
              line={16}
              style={{ marginLeft: entry.segment === "period" ? 4 : 0 }}
            >
              {entry.label}
            </Label>
          )}
          separatorStyle={{
            fontFamily: fontFamily(fonts().interface),
            fontSize: 12,
            lineHeight: 16,
            color: c().ink,
          }}
        />
        <Icon name="routines" size={12} />
      </View>
    </If>
  );
  const form = () => (
    <View
      style={{
        paddingVertical: props.inline && !props.tablet ? 20 : 16,
        paddingHorizontal: props.tablet ? 24 : props.inline ? 28 : 16,
        gap: props.tablet ? 14 : 16,
        width: "100%",
        maxWidth: props.inline ? 800 : undefined,
      }}
    >
      <If when={props.inline}>
        <View style={{ gap: props.tablet ? 14 : 4 }}>
          <View
            role="button"
            accessibilityLabel={uiText("routines2")}
            onPress={props.onClose}
            focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
            style={{
              ...row,
              height: props.tablet ? undefined : 28,
              gap: 6,
              alignSelf: "flex-start",
              cursor: "pointer",
            }}
          >
            <Icon name="back" size={12} />
            <Label
              size={props.tablet ? 11 : 12}
              line={props.tablet ? 14 : 16}
              tone={props.tablet ? "mutedInk" : "muted"}
            >
              {uiText("routines2")}
            </Label>
          </View>
          <Label
            size={props.tablet ? 16 : 14}
            line={props.tablet ? 22 : 18}
            weight={600}
          >
            {props.item ? uiText("editRoutine") : uiText("newRoutine")}
          </Label>
        </View>
      </If>
      {field(
        uiText("name"),
        <Field
          label={uiText("name")}
          placeholder={uiText("routineNamePlaceholder")}
          value={name()}
          onChange={name.set}
          style={input()}
        />,
      )}
      {field(
        uiText("routineBriefLabel"),
        <>
          <Field
            label={uiText("routineBriefLabel")}
            placeholder={uiText("routineBriefPlaceholder")}
            value={brief()}
            onChange={brief.set}
            multiline
            style={{
              height: props.tablet ? 110 : 112,
              padding: 10,
              fontSize: 12,
              lineHeight: 18,
            }}
          />
          <If when={props.tablet}>
            <Label size={11} line={16} tone="muted">
              {uiText("routineRunByCaptain")}
            </Label>
          </If>
        </>,
      )}
      <If when={!props.tablet}>
        <Label size={12} line={18} tone="muted">
          {uiText("routineRunByCaptain")}
        </Label>
      </If>
      {field(
        uiText("schedule"),
        <>
          <View style={{ ...row, gap: 8, flexWrap: "wrap" }}>
            <ActionMenu
              label={uiText("scheduleFrequency")}
              value={uiText(kinds[kind()])}
              triggerStyle={{
                ...select(),
                width: props.tablet ? 110 : undefined,
              }}
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
              <View
                style={{
                  ...row,
                  height: control(),
                  borderWidth: 1,
                  borderColor: props.tablet ? c().border : c().strong,
                }}
              >
                <Each of={[1, 2, 3, 4, 5, 6, 0]}>
                  {(day) => (
                    <View
                      role="button"
                      accessibilityLabel={weekday(day())}
                      accessibilityState={{
                        selected: days().includes(day()),
                      }}
                      onPress={() =>
                        days.update((previous) =>
                          previous.includes(day())
                            ? previous.filter((item) => item !== day())
                            : [...previous, day()],
                        )
                      }
                      focusVisibleStyle={{
                        outlineWidth: 1,
                        outlineColor: c().blue,
                      }}
                      style={{
                        ...(props.tablet
                          ? { paddingHorizontal: 7 }
                          : { width: 28 }),
                        alignSelf: "stretch",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        backgroundColor: days().includes(day())
                          ? c().button
                          : undefined,
                      }}
                    >
                      <Label
                        size={props.tablet ? 11 : 12}
                        line={props.tablet ? 14 : 16}
                        tone={
                          days().includes(day())
                            ? "buttonInk"
                            : props.tablet
                              ? "mutedInk"
                              : "muted"
                        }
                      >
                        {weekday(day())}
                      </Label>
                    </View>
                  )}
                </Each>
              </View>
            </If>
            <If when={!props.tablet}>{time()}</If>
            <If when={kind() === "hourly"}>
              <ActionMenu
                label={uiText("repeatEvery")}
                value={
                  every() === 1
                    ? uiText("everyHour")
                    : uiText("everyHours", { hours: every() })
                }
                triggerStyle={select()}
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
              style={input()}
            />
            <Label size={12} line={16} tone="muted">
              {uiText("minuteHourDayOfMonthMonth")}
            </Label>
          </If>
          <If
            when={props.tablet}
            else={
              <If when={preview()}>
                <Label size={12} line={16} tone="muted">
                  {preview()}
                </Label>
              </If>
            }
          >
            <View style={{ ...row, gap: 8, flexWrap: "wrap" }}>
              {time()}
              <If when={preview()}>
                <Label size={11} line={14} tone="muted" style={{ flex: 1 }}>
                  {preview()}
                </Label>
              </If>
            </View>
          </If>
        </>,
      )}
      {field(
        uiText("timeZone"),
        <ActionMenu
          label={uiText("timeZone")}
          value={timezone()}
          truncateValue
          triggerStyle={select()}
        >
          <Each of={zones()}>
            {(zone) => (
              <ActionItem
                label={zone()}
                checked={timezone() === zone()}
                onSelect={() => timezone.set(zone())}
              />
            )}
          </Each>
        </ActionMenu>,
        props.tablet ? 240 : 366,
      )}
      <View
        style={{
          ...row,
          gap: 8,
          justifyContent: "flex-end",
          paddingTop: 4,
        }}
      >
        <Button
          label={uiText("cancel")}
          size={28}
          disabled={busy()}
          style={{ paddingHorizontal: 14 }}
          onPress={props.onClose}
        />
        <Button
          label={props.item ? uiText("saveChanges") : uiText("routineCreate")}
          tone="primary"
          size={28}
          disabled={!valid() || busy()}
          style={{
            paddingHorizontal: 14,
            opacity: !valid() || busy() ? (props.tablet ? 0.55 : 0.5) : 1,
          }}
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
      <Scroll style={grow}>{form()}</Scroll>
    </If>
  );
}
