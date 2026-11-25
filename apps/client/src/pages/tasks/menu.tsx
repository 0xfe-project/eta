import type { BoardTaskStatus } from "@eta/client-contracts";
import type { JSX, ViewStyle } from "nsh";
import { TASK_STATUSES } from "@eta/client-contracts";
import { View } from "nsh";
import { Caption, colors, Icon, Label, row } from "../../components";
import {
  canHover,
  inSheet,
  MenuFrame,
  MenuRow,
  MenuRule,
  touchRow,
  touchScreen,
} from "../../components/menu";
import { control, icon, space, weight } from "../../components/tokens";
import { statusHint, statusName, TaskGlyph } from "./status";

/**
 * The Tasks page's popover menu, the design's "Cards & Menus" popover: a
 * strong border, 4px above and below the rows, an optional 10px uppercase
 * caption. In the phone layout it is a sheet at the bottom, as the shared
 * `ActionMenu` is (`menuPresentation`).
 */
/** A menu row in a phone's sheet. */
const sheetRowHeight = 52;

export function TaskMenu(props: {
  trigger: JSX.Element;
  width: number;
  caption?: string;
  align?: "start" | "end";
  /** Tighter caption padding: the status menu on a task page and in the panel. */
  dense?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What it says while it has no options: pass it only then. */
  empty?: string;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <MenuFrame
      align={props.align ?? "start"}
      empty={props.empty}
      margin={8}
      open={props.open}
      onOpenChange={(open) => props.onOpenChange?.(open)}
      popupStyle={{
        width: props.width,
        paddingVertical: space[4],
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      trigger={props.trigger}
    >
      <If when={props.caption}>
        {(caption) => (
          <View
            style={{
              paddingTop: props.dense ? space[4] : space[8],
              paddingBottom: space[4],
              paddingHorizontal: inSheet()
                ? space[16]
                : props.dense
                  ? space[8]
                  : space[12],
            }}
          >
            <Caption text={caption()} />
          </View>
        )}
      </If>
      {props.children}
    </MenuFrame>
  );
}

/** A 1px border-coloured rule between a menu's groups. */
export function TaskMenuRule(props: { space?: number }) {
  const c = colors();
  return (
    <MenuRule
      style={{
        height: 1,
        marginVertical: props.space ?? 0,
        backgroundColor: c().border,
      }}
    />
  );
}

/**
 * A row of a `TaskMenu`: 12px text after an optional leading mark. A checked
 * row (one choice of a group) is filled muted and ends in a check; the others
 * keep the check's slot so their text lines up.
 */
export function TaskMenuItem(props: {
  label: string;
  leading?: JSX.Element;
  /** Muted text after the label, such as a parent's "#4". */
  suffix?: string;
  /** A second, 11px muted line under the label. */
  hint?: string;
  checked?: boolean;
  height?: number;
  /** One step down on padding and gap, for the status menu. */
  dense?: boolean;
  style?: ViewStyle;
  onSelect: () => void;
}) {
  const c = colors();
  const radio = () => props.checked !== undefined;
  return (
    <MenuRow
      role={radio() ? "menuitemradio" : "menuitem"}
      checked={props.checked}
      label={props.label}
      description={props.hint}
      style={{
        ...row,
        alignItems: props.hint ? "flex-start" : "center",
        minHeight: inSheet()
          ? sheetRowHeight
          : touchScreen
            ? touchRow
            : props.hint
              ? undefined
              : (props.height ?? control.md),
        paddingVertical: props.hint ? (props.dense ? space[4] : space[8]) : 0,
        paddingHorizontal: inSheet()
          ? space[16]
          : props.dense
            ? space[8]
            : space[12],
        gap: props.dense ? space[4] : space[8],
        backgroundColor: props.checked ? c().selected : undefined,
        ...props.style,
      }}
      onSelect={props.onSelect}
    >
      <If when={props.leading}>
        <View
          style={{
            ...row,
            height: props.hint ? space[16] : undefined,
            flexShrink: 0,
          }}
        >
          {props.leading}
        </View>
      </If>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label variant="small" lines={props.hint ? undefined : 1}>
          {props.label}
          <If when={props.suffix}>
            {(suffix) => (
              <Label variant="small" tone="muted">
                {`  ${suffix()}`}
              </Label>
            )}
          </If>
        </Label>
        <If when={props.hint}>
          {(hint) => (
            <Label variant="caption" tone="muted">
              {hint()}
            </Label>
          )}
        </If>
      </View>
      <If when={radio()}>
        <View
          style={{
            ...row,
            width: space[12],
            height: props.hint ? space[16] : space[12],
            flexShrink: 0,
          }}
        >
          <If when={props.checked}>
            <Icon name="check" size={icon.sm} />
          </If>
        </View>
      </If>
    </MenuRow>
  );
}

/**
 * A header filter's trigger: 24px, the label and its caret muted, both ink and
 * filled muted while the menu is open or the filter is on.
 */
export function FilterTrigger(props: {
  label: string;
  tablet: boolean;
  active?: boolean;
}) {
  const c = colors();
  return (
    <View
      accessibilityLabel={props.label}
      hoverStyle={canHover ? { backgroundColor: c().selected } : undefined}
      expandedStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: control.sm,
        paddingHorizontal: space[8],
        gap: space[4],
        flexShrink: 0,
        cursor: "pointer",
        backgroundColor: props.active ? c().selected : undefined,
      }}
    >
      <Label
        variant="small"
        weight={weight.regular}
        tone={props.active ? "ink" : "muted"}
      >
        {props.label}
      </Label>
      <Icon name="down" size={icon.sm} tone={props.active ? "ink" : "muted"} />
    </View>
  );
}

/**
 * The seven statuses of a `TaskMenu`, each with what it does under its name;
 * Blocked and Cancelled, the ones that stop work, after a rule.
 */
export function StatusOptions(props: {
  current: BoardTaskStatus;
  /** The tasks that wait for this one, which cancelling it blocks. */
  waiting: number;
  dense?: boolean;
  onChange: (status: BoardTaskStatus) => void;
}) {
  return (
    <Each of={TASK_STATUSES}>
      {(entry) => (
        <>
          <If when={entry() === "blocked"}>
            <TaskMenuRule space={4} />
          </If>
          <TaskMenuItem
            label={statusName(entry())}
            hint={statusHint(entry(), props.waiting)}
            leading={<TaskGlyph status={entry()} size={icon.sm} />}
            checked={props.current === entry()}
            dense={props.dense}
            onSelect={() => props.onChange(entry())}
          />
        </>
      )}
    </Each>
  );
}
