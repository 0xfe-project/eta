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
import { statusHint, statusName, TaskGlyph } from "./status";

/**
 * The Tasks page's popover menu, the design's "Cards & Menus" popover: a
 * strong border, 4px above and below the rows, an optional 10px uppercase
 * caption. In the phone layout it is a sheet at the bottom, as the shared
 * `ActionMenu` is (`menuPresentation`).
 */
export function TaskMenu(props: {
  trigger: JSX.Element;
  width: number;
  caption?: string;
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <MenuFrame
      align={props.align ?? "start"}
      margin={8}
      open={props.open}
      onOpenChange={(open) => props.onOpenChange?.(open)}
      popupStyle={{
        width: props.width,
        paddingVertical: 4,
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
              paddingTop: 6,
              paddingBottom: 4,
              paddingHorizontal: inSheet() ? 16 : 10,
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
          ? 52
          : touchScreen
            ? touchRow
            : props.hint
              ? undefined
              : (props.height ?? 28),
        paddingVertical: props.hint ? 6 : 0,
        paddingHorizontal: inSheet() ? 16 : 10,
        gap: 8,
        backgroundColor: props.checked ? c().selected : undefined,
        ...props.style,
      }}
      onSelect={props.onSelect}
    >
      <If when={props.leading}>
        <View
          style={{
            ...row,
            height: props.hint ? 16 : undefined,
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
            width: 12,
            height: props.hint ? 16 : 12,
            flexShrink: 0,
          }}
        >
          <If when={props.checked}>
            <Icon name="check" size={12} />
          </If>
        </View>
      </If>
    </MenuRow>
  );
}

/**
 * A header filter's trigger: 25px, the label and its caret muted, both ink and
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
        height: 25,
        paddingHorizontal: props.tablet ? 6 : 8,
        gap: 4,
        flexShrink: 0,
        cursor: "pointer",
        backgroundColor: props.active ? c().selected : undefined,
      }}
    >
      <Label
        variant="small"
        weight={props.tablet ? 500 : 400}
        tone={props.active ? "ink" : "muted"}
      >
        {props.label}
      </Label>
      <Icon name="down" size={10} tone={props.active ? "ink" : "muted"} />
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
            leading={<TaskGlyph status={entry()} size={12} />}
            checked={props.current === entry()}
            onSelect={() => props.onChange(entry())}
          />
        </>
      )}
    </Each>
  );
}
