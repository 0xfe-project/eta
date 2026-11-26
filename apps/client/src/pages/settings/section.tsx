import type { JSX, ViewRef, ViewStyle } from "nsh";
import { Image, View, windowSize } from "nsh";
import {
  ActionMenu,
  Button,
  colors,
  focusRing,
  Icon,
  Label,
  row,
} from "../../components";
import { canHover } from "../../components/menu";
import { StatusDot } from "../../components/status-dot";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { tintedLogo } from "./models/logos";

export { SectionHeader, WarningLine } from "../../ui";

/** A row's status column, wide enough for its dot and word. */
const statusLaneWidth = 100;

/** The box a row's leading avatar, logo or glyph sits in when it is not the default 24. */
export const leadingBoxWidth = 28;

/** An empty pane says so right under its header, in line with it: an `EmptyState`'s inset in
 * Settings. */
export const emptyStyle: ViewStyle = {
  paddingVertical: space[24],
  paddingHorizontal: space[16],
};

export interface EntityStatus {
  label: string;
  color: string;
}

/** The 100px status lane of an entity row: a 6px square and a short label. */
export function StatusLane(props: { status?: EntityStatus; width?: number }) {
  return (
    <View
      style={{
        ...row,
        width: props.width ?? statusLaneWidth,
        height: space[20],
        gap: space[4],
        flexShrink: 0,
      }}
    >
      <If when={props.status}>
        {(status) => (
          <>
            <StatusDot color={status().color} />
            <Label variant="small" tone="mutedInk" lines={1}>
              {status().label}
            </Label>
          </>
        )}
      </If>
    </View>
  );
}

/** The phone's status line under an entity's name: a 6px square and a short label. */
export function StatusLine(props: { status: EntityStatus }) {
  return (
    <View style={{ ...row, height: space[16], gap: space[4], flexShrink: 0 }}>
      <StatusDot color={props.status.color} />
      <Label variant="small" tone="mutedInk" lines={1}>
        {props.status.label}
      </Label>
    </View>
  );
}

/** A 12px warning line under an entity's name. */
/**
 * The back arrow before a pane's title: a bare 16px ArrowLeft in muted ink in the dialog, a 14px
 * one in ink on the tablet page (the app's tablet range, as in components/modal.tsx).
 */
export function PaneBack(props: {
  label?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const tablet = () => windowSize().width < 1200;
  return (
    <Button
      label={props.label ?? uiText("back")}
      icon="arrowLeft"
      iconOnly
      tone="ghost"
      iconSize={icon.md}
      labelTone={tablet() ? "ink" : "mutedInk"}
      size={control.sm}
      disabled={props.disabled}
      style={{ paddingHorizontal: 0 }}
      onPress={props.onPress}
    />
  );
}

/**
 * One thing in a settings list: a 24px leading slot, the name and its meta, the status lane, and a
 * 24px trailing slot holding the row's menu or a caret.
 */
export function EntityRow(props: {
  title: string;
  leading?: JSX.Element;
  /** The leading slot's side: 24, or 28 for the tablet's agent avatars. */
  leadingSize?: number;
  meta?: JSX.Element | string;
  /** Let phone metadata use the full width beneath the title and status. */
  wideMeta?: boolean;
  titleTone?: "ink" | "muted";
  strike?: boolean;
  lane?: boolean;
  laneWidth?: number;
  status?: EntityStatus;
  menuLabel?: string;
  menu?: JSX.Element;
  caret?: boolean;
  /**
   * The phone stacks the status under the name instead of a lane; its trailing slot is 28px tall
   * and only there for a caret.
   */
  stacked?: boolean;
  onPress?: () => void;
  /** The pressable part, e.g. to take focus back when a detail closes. */
  controlRef?: (node: ViewRef) => void;
  /** Read instead of the title, when the row says more than its name. */
  accessibilityLabel?: string;
}) {
  const c = colors();
  const hasMenu = () => Boolean(props.menu && !props.stacked);
  const trailingHeight = () => (props.stacked ? 28 : 24);
  const title = () => (
    <Label
      weight={weight.regular}
      tone={props.titleTone ?? "ink"}
      style={{
        ...(props.wideMeta ? { flexShrink: 1 } : {}),
        ...(props.strike
          ? { textDecorationLine: "line-through" as const }
          : {}),
      }}
    >
      {props.title}
    </Label>
  );
  return (
    // The hover is the whole row's and the button fills it, padding inside, up to the rule;
    // the menu sits over the button's right padding, beside it rather than inside it.
    <View
      hoverStyle={
        props.onPress && canHover
          ? { backgroundColor: c().selected }
          : undefined
      }
      style={{
        flexShrink: 0,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View
        ref={(node) => props.controlRef?.(node)}
        role={props.onPress ? "button" : undefined}
        accessibilityLabel={
          props.onPress
            ? (props.accessibilityLabel ?? props.title)
            : props.accessibilityLabel
        }
        onPress={props.onPress}
        focusVisibleStyle={props.onPress ? focusRing(c(), "inset") : undefined}
        style={{
          ...row,
          alignItems: "flex-start",
          minWidth: 0,
          minHeight: hasMenu() ? space[8] + control.sm + space[8] : undefined,
          gap: space[8],
          paddingLeft: space[16],
          paddingRight: hasMenu()
            ? space[16] + control.sm + space[8]
            : space[16],
          paddingVertical: space[8],
          cursor: props.onPress ? "pointer" : undefined,
        }}
      >
        <If when={props.leading}>
          <View
            style={{
              width: props.leadingSize ?? space[24],
              height: props.leadingSize ?? space[24],
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {props.leading}
          </View>
        </If>
        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
          <If when={props.wideMeta} else={title()}>
            <View style={{ ...row, justifyContent: "space-between" }}>
              {title()}
              <If when={props.status}>
                {(status) => <StatusLine status={status()} />}
              </If>
            </View>
          </If>
          <If when={props.stacked ? props.status : undefined}>
            {(status) => <StatusLine status={status()} />}
          </If>
          <If when={typeof props.meta === "string"}>
            <Label variant="small" tone="muted">
              {props.meta as string}
            </Label>
          </If>
          <If when={props.meta !== undefined && typeof props.meta !== "string"}>
            {props.meta}
          </If>
        </View>
        <If when={props.lane !== false && !props.stacked && !props.wideMeta}>
          <StatusLane status={props.status} width={props.laneWidth} />
        </If>
        <If when={!hasMenu() && (!props.stacked || props.caret)}>
          <View
            style={{
              width: space[24],
              height: trailingHeight(),
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <If when={props.caret}>
              <Icon name="right" size={icon.md} tone="mutedInk" />
            </If>
          </View>
        </If>
      </View>
      <If when={hasMenu()}>
        <View style={{ position: "absolute", top: space[8], right: space[16] }}>
          <ActionMenu
            label={props.menuLabel ?? props.title}
            triggerStyle={{
              minWidth: space[24],
              width: space[24],
              height: space[24],
              paddingHorizontal: 0,
            }}
            // The row under it is already highlighted: a step darker, so the menu reads as its own target.
            triggerHoverStyle={
              props.onPress ? { backgroundColor: c().border } : undefined
            }
          >
            {props.menu}
          </ActionMenu>
        </View>
      </If>
    </View>
  );
}

/**
 * The 24px box standing in for an entity's logo or avatar: its models.dev logo (one colour, drawn
 * in the text colour at 60% of the box) when there is one, else its name's first letter.
 */
export function LetterBox(props: {
  name: string;
  size?: number;
  logo?: string | undefined;
}) {
  const c = colors();
  const size = () => props.size ?? 24;
  return (
    <View
      style={{
        width: size(),
        height: size(),
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: c().strong,
      }}
    >
      <If
        when={props.logo}
        else={
          <Label variant="small" weight={weight.strong}>
            {props.name.slice(0, 1).toUpperCase()}
          </Label>
        }
      >
        {(logo) => (
          <Image
            src={tintedLogo(logo(), c().ink)}
            fadeDuration={0}
            style={{
              width: Math.round(size() * 0.6),
              height: Math.round(size() * 0.6),
            }}
          />
        )}
      </If>
    </View>
  );
}
