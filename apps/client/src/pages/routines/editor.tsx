import type {
  RoutineFields,
  RoutineInfo,
  RoutineResults,
  RoutineSchedule,
} from "@eta/client-contracts";
import type { JSX, ViewStyle } from "nsh";
import { HOURLY_STEPS } from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  dialogWidth,
  Field,
  focusRing,
  grow,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import {
  canHover,
  MenuFrame,
  MenuRow,
  touchRow,
  touchScreen,
} from "../../components/menu";
import {
  control as controlHeight,
  icon,
  opacity,
  space,
  weight,
} from "../../components/tokens";
import { formatLocale, uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TimeField } from "../../ui";
import { timeZones, upcomingTimes, weekday } from "./schedule";

interface ScheduleOption {
  label: string;
  checked: boolean;
  onSelect: () => void;
}

/** A schedule select's menu. */
const selectMenuWidth = { phone: 240, tablet: 200, desktop: 180 } as const;
/** A row of that menu off touch screens. */
const optionHeight = { tablet: 36, desktop: 32 } as const;
/** The time of day beside the frequency. */
const timeFieldWidth = { sheet: 140, tablet: 112, desktop: 116 } as const;
/** The phone sheet's frequency and interval selects. */
const frequencyWidth = { cron: 152, other: 120 } as const;
/** The cron expression field. */
const cronWidth = 160;
/** The time zone field. */
const timezoneWidth = { tablet: 240, desktop: 368 } as const;
/** The brief: in the phone sheet when editing or creating, and on wider screens. */
const briefHeight = { edit: 96, create: 124, wide: 112 } as const;
/** The inline form's column. */
const formWidth = 800;

/**
 * The phone form's select: a 44pt trigger, opening the design's titled
 * bottom sheet of 48pt rows with the selected one tinted.
 */
function PhoneSelect(props: {
  label: string;
  title: string;
  value: string;
  options: ScheduleOption[];
  triggerStyle?: ViewStyle;
}) {
  const c = colors();
  return (
    <MenuFrame
      popupStyle={{
        width: selectMenuWidth.phone,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      sheetStyle={{ paddingBottom: space[24] }}
      sheetHeader={
        <View
          style={{
            ...row,
            height: controlHeight.touch,
            paddingHorizontal: space[16],
          }}
        >
          <Label weight={weight.strong}>{props.title}</Label>
        </View>
      }
      trigger={
        <View
          accessibilityLabel={props.label}
          hoverStyle={canHover ? { backgroundColor: c().selected } : undefined}
          focusVisibleStyle={focusRing(c(), "inset")}
          style={{
            ...row,
            height: controlHeight.touch,
            gap: space[8],
            paddingHorizontal: space[12],
            cursor: "pointer",
            borderWidth: 1,
            borderColor: c().border,
            backgroundColor: c().canvas,
            ...props.triggerStyle,
          }}
        >
          <Label lines={1} style={{ flex: 1, minWidth: 0 }}>
            {props.value}
          </Label>
          <Icon name="down" size={icon.md} tone="muted" />
        </View>
      }
    >
      <Each of={props.options}>
        {(option) => (
          <MenuRow
            role="menuitemradio"
            checked={option().checked}
            label={option().label}
            style={{
              ...row,
              height: space[48],
              flexShrink: 0,
              paddingHorizontal: space[16],
              borderTopWidth: 1,
              borderColor: c().border,
              backgroundColor: option().checked ? c().selected : undefined,
            }}
            onSelect={option().onSelect}
          >
            <Label style={{ flex: 1 }}>{option().label}</Label>
            <View
              style={{ width: space[16], height: space[16], flexShrink: 0 }}
            >
              <If when={option().checked}>
                <Icon name="check" size={icon.md} />
              </If>
            </View>
          </MenuRow>
        )}
      </Each>
    </MenuFrame>
  );
}

/**
 * The form's selects. In the tablet and desktop layouts they open as the
 * design's popover under the trigger's left edge (so they never cover the
 * routine list), whatever the platform; the phone form has its own titled
 * sheet.
 */
function ScheduleSelect(props: {
  label: string;
  /** The phone sheet's title. */
  title?: string;
  value: string;
  options: ScheduleOption[];
  tablet?: boolean;
  phone?: boolean;
  triggerStyle?: ViewStyle;
}) {
  const c = colors();
  return (
    <If
      when={!props.phone}
      else={
        <PhoneSelect
          label={props.label}
          title={props.title ?? props.label}
          value={props.value}
          options={props.options}
          triggerStyle={props.triggerStyle}
        />
      }
    >
      <MenuFrame
        popupStyle={{
          width: props.tablet
            ? selectMenuWidth.tablet
            : selectMenuWidth.desktop,
          borderWidth: 1,
          borderColor: c().strong,
          backgroundColor: c().canvas,
        }}
        trigger={
          <View
            accessibilityLabel={props.label}
            hitSlop={touchScreen ? 6 : undefined}
            hoverStyle={
              canHover ? { backgroundColor: c().selected } : undefined
            }
            focusVisibleStyle={focusRing(c(), "inset")}
            style={{
              ...row,
              justifyContent: "space-between",
              gap: props.tablet ? space[12] : space[8],
              cursor: "pointer",
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().canvas,
              ...props.triggerStyle,
            }}
          >
            <Label variant="small" lines={1} style={{ minWidth: 0 }}>
              {props.value}
            </Label>
            <Icon
              name="down"
              size={icon.sm}
              tone={props.tablet ? "ink" : "muted"}
            />
          </View>
        }
      >
        <Each of={props.options}>
          {(option) => (
            <MenuRow
              role="menuitemradio"
              checked={option().checked}
              label={option().label}
              style={{
                ...row,
                height: touchScreen
                  ? touchRow
                  : props.tablet
                    ? optionHeight.tablet
                    : optionHeight.desktop,
                gap: space[8],
                paddingHorizontal: space[12],
                backgroundColor: option().checked ? c().selected : undefined,
              }}
              onSelect={option().onSelect}
            >
              <Label variant="small" style={{ flex: 1 }}>
                {option().label}
              </Label>
              <View
                style={{ width: space[12], height: space[12], flexShrink: 0 }}
              >
                <If when={option().checked}>
                  <Icon name="check" size={icon.sm} />
                </If>
              </View>
            </MenuRow>
          )}
        </Each>
      </MenuFrame>
    </If>
  );
}

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
  const type = textFaces();
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
  const zones = () => timeZones(timezone());
  // The phone sheet: 36px controls with 14px text, a footer bar under the fields.
  const sheet = () => props.phone && !props.inline;
  // The tablet form uses 32px controls with a 10px inset; the desktop one 28px and 8px.
  const control = () =>
    sheet()
      ? controlHeight.touch
      : props.tablet
        ? controlHeight.lg
        : controlHeight.md;
  const controlInset = () => (sheet() || props.tablet ? space[12] : space[8]);
  const input = () => ({
    height: control(),
    paddingHorizontal: controlInset(),
    ...textStyle(type("small")),
  });
  const select = () => ({
    height: control(),
    paddingHorizontal: controlInset(),
    gap: space[8],
    borderColor: c().border,
  });
  const interval = (hours: number) =>
    hours === 1 ? uiText("intervalHour") : uiText("intervalHours", { hours });
  const field = (label: string, content: JSX.Element, width?: number) => (
    <View style={{ gap: space[4], width: width ?? "100%", maxWidth: "100%" }}>
      <Label variant="small" tone={sheet() ? "mutedInk" : undefined}>
        {label}
      </Label>
      {content}
    </View>
  );
  const time = () => (
    <If when={kind() === "weekly" || kind() === "daily"}>
      <TimeField
        label={uiText("time")}
        value={at()}
        hourCycle={formatLocale() === "zh-CN" ? "h23" : "h12"}
        height={control()}
        paddingHorizontal={controlInset()}
        iconSize={sheet() ? icon.md : icon.sm}
        style={{
          width: sheet()
            ? timeFieldWidth.sheet
            : props.tablet
              ? timeFieldWidth.tablet
              : timeFieldWidth.desktop,
        }}
        onChange={at.set}
      />
    </If>
  );
  const actions = () => (
    <View
      style={{
        ...row,
        gap: space[8],
        justifyContent: "flex-end",
        ...(sheet()
          ? {
              paddingTop: space[12],
              paddingHorizontal: space[16],
              paddingBottom: space[24],
              borderTopWidth: 1,
              borderColor: c().border,
            }
          : { paddingTop: space[4] }),
      }}
    >
      <Button
        label={uiText("cancel")}
        size={sheet() ? controlHeight.touch : controlHeight.md}
        disabled={busy()}
        style={{ paddingHorizontal: space[16] }}
        onPress={props.onClose}
      />
      <Button
        label={props.item ? uiText("save") : uiText("routineCreate")}
        tone="primary"
        size={sheet() ? controlHeight.touch : controlHeight.md}
        disabled={!valid()}
        busy={busy()}
        dimDisabled={!sheet()}
        style={{
          paddingHorizontal: space[16],
          opacity: sheet() || valid() ? 1 : opacity.disabled,
          // The phone sheet draws a disabled primary in the faint fill.
          ...(sheet() && !valid()
            ? { backgroundColor: c().faint, borderColor: c().faint }
            : {}),
        }}
        onPress={() => void save()}
      />
    </View>
  );
  const form = () => (
    <View
      style={{
        paddingVertical: props.inline && !props.tablet ? space[20] : space[16],
        paddingTop: sheet() ? space[12] : undefined,
        paddingHorizontal: props.tablet
          ? space[24]
          : props.inline
            ? space[32]
            : space[16],
        gap: props.tablet ? space[12] : space[16],
        width: "100%",
        maxWidth: props.inline ? formWidth : undefined,
        borderTopWidth: sheet() ? 1 : 0,
        borderColor: c().border,
      }}
    >
      <If when={props.inline}>
        <View style={{ gap: props.tablet ? space[12] : space[4] }}>
          <View
            role="button"
            accessibilityLabel={props.item?.name ?? uiText("routines2")}
            onPress={props.onClose}
            focusVisibleStyle={focusRing(c(), "inset")}
            style={{
              ...row,
              height: props.tablet ? undefined : controlHeight.md,
              gap: space[4],
              alignSelf: "flex-start",
              cursor: "pointer",
            }}
          >
            <Icon name="arrowLeft" size={icon.sm} />
            <Label variant="small" tone={props.tablet ? "mutedInk" : "muted"}>
              {props.item?.name ?? uiText("routines2")}
            </Label>
          </View>
          <Label weight={weight.strong}>
            {props.item ? uiText("edit") : uiText("newRoutine")}
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
            style={
              sheet()
                ? {
                    height: props.item ? briefHeight.edit : briefHeight.create,
                    paddingVertical: space[8],
                    paddingHorizontal: space[12],
                    ...textStyle(type("small"), "prose"),
                  }
                : {
                    height: briefHeight.wide,
                    padding: space[12],
                    ...textStyle(type("small"), "prose"),
                  }
            }
          />
          <If when={props.tablet}>
            <Label variant="small" tone="muted">
              {uiText("routineRunByCaptain")}
            </Label>
          </If>
          <If when={sheet()}>
            <Label variant="small" tone="muted">
              {uiText("routineRunByCaptain")}
            </Label>
          </If>
        </>,
      )}
      <If when={!props.tablet && !sheet()}>
        <Label variant="small" tone="muted">
          {uiText("routineRunByCaptain")}
        </Label>
      </If>
      {field(
        uiText("schedule"),
        <>
          <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
            <ScheduleSelect
              label={uiText("scheduleFrequency")}
              title={uiText("frequency")}
              value={uiText(kinds[kind()])}
              tablet={props.tablet}
              phone={props.phone}
              triggerStyle={
                sheet()
                  ? kind() === "hourly"
                    ? { flex: 1, minWidth: 0 }
                    : {
                        width:
                          kind() === "cron"
                            ? frequencyWidth.cron
                            : frequencyWidth.other,
                        flexShrink: 0,
                      }
                  : select()
              }
              options={(Object.keys(kinds) as RoutineSchedule["kind"][]).map(
                (option) => ({
                  label: uiText(kinds[option]),
                  checked: kind() === option,
                  onSelect: () => kind.set(option),
                }),
              )}
            />
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
                      focusVisibleStyle={focusRing(c(), "inset")}
                      style={{
                        ...(props.tablet
                          ? { paddingHorizontal: space[8] }
                          : { width: controlHeight.md }),
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
                        variant="small"
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
              <ScheduleSelect
                label={uiText("repeatEvery")}
                value={interval(every())}
                tablet={props.tablet}
                phone={props.phone}
                triggerStyle={
                  sheet()
                    ? { width: frequencyWidth.other, flexShrink: 0 }
                    : select()
                }
                options={HOURLY_STEPS.map((hours) => ({
                  label: interval(hours),
                  checked: every() === hours,
                  onSelect: () => every.set(hours),
                }))}
              />
            </If>
            <If when={kind() === "cron"}>
              <Field
                label={uiText("cronExpression")}
                placeholder="0 8 * * 1-5"
                value={cron()}
                onChange={cron.set}
                style={{
                  ...input(),
                  ...(sheet()
                    ? { flex: 1, minWidth: 0 }
                    : { width: cronWidth }),
                }}
              />
            </If>
          </View>
          <If when={kind() === "cron" && !props.tablet}>
            <Label variant="small" tone="muted">
              {uiText("minuteHourDayOfMonthMonth")}
            </Label>
          </If>
          <If
            when={props.tablet}
            else={
              <If when={preview()}>
                <Label variant="small" tone="muted">
                  {preview()}
                </Label>
              </If>
            }
          >
            <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
              {time()}
              <If when={kind() === "cron"}>
                <Label variant="caption" tone="muted">
                  {uiText("minuteHourDayOfMonthMonth")}
                </Label>
              </If>
              <If when={preview()}>
                <Label variant="caption" tone="muted" style={{ flex: 1 }}>
                  {preview()}
                </Label>
              </If>
            </View>
          </If>
        </>,
      )}
      {field(
        uiText("timeZone"),
        <If
          when={sheet()}
          else={
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
            </ActionMenu>
          }
        >
          <PhoneSelect
            label={uiText("timeZone")}
            title={uiText("timeZone")}
            value={timezone()}
            options={zones().map((zone) => ({
              label: zone,
              checked: timezone() === zone,
              onSelect: () => timezone.set(zone),
            }))}
          />
        </If>,
        sheet()
          ? undefined
          : props.tablet
            ? timezoneWidth.tablet
            : timezoneWidth.desktop,
      )}
      <If when={!sheet()}>{actions()}</If>
    </View>
  );
  return (
    <If
      when={props.inline}
      else={
        <Modal
          title={
            props.item
              ? props.phone
                ? uiText("edit")
                : uiText("editRoutine")
              : uiText("newRoutine")
          }
          phone={props.phone}
          sheet={props.phone}
          plainSheetHeader={props.phone}
          overPhoneNavigation={props.phone}
          width={dialogWidth.lg}
          onClose={props.onClose}
        >
          <SmoothScroll style={{ flexShrink: 1 }}>{form()}</SmoothScroll>
          <If when={sheet()}>{actions()}</If>
        </Modal>
      }
    >
      <SmoothScroll style={grow}>{form()}</SmoothScroll>
    </If>
  );
}
