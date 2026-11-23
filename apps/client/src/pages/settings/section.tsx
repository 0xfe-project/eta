import type { JSX, ViewRef, ViewStyle } from "nsh";
import { Image, View, windowSize } from "nsh";
import { ActionMenu, Button, colors, Icon, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { tintedLogo } from "./models/logos";

/** An empty pane says so right under its header, not in the middle of the pane. */
export const emptyStyle: ViewStyle = {
  flex: 0,
  justifyContent: "flex-start",
  gap: 4,
  paddingVertical: 24,
  paddingHorizontal: 16,
};

/** The header that opens a settings pane or a group inside one: title, count, actions, description. */
export function SectionHeader(props: {
  title: string;
  count?: string | number;
  description?: string;
  muted?: boolean;
  /** The phone's header row is 28px, fitting its 28px buttons. */
  phone?: boolean;
  /** The header row's height when it differs, e.g. 20 for a bare title in a sheet. */
  rowHeight?: number;
  leading?: JSX.Element;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        flexShrink: 0,
        gap: 2,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View
        style={{
          ...row,
          height: props.rowHeight ?? (props.phone ? 28 : 24),
          gap: 8,
        }}
      >
        {props.leading}
        <View
          style={{
            ...row,
            alignItems: "baseline",
            flex: 1,
            minWidth: 0,
            gap: 8,
          }}
        >
          <Label
            weight={weight.strong}
            lines={1}
            tone={props.muted ? "muted" : "ink"}
          >
            {props.title}
          </Label>
          <If when={props.count !== undefined}>
            <Label variant="small" tone="muted">
              {props.count}
            </Label>
          </If>
        </View>
        <If when={props.children}>
          <View style={{ ...row, gap: 8 }}>{props.children}</View>
        </If>
      </View>
      <If when={props.description}>
        <Label variant="small" tone="muted">
          {props.description}
        </Label>
      </If>
    </View>
  );
}

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
        width: props.width ?? 100,
        height: 20,
        gap: 6,
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
    <View style={{ ...row, height: 16, gap: 6, flexShrink: 0 }}>
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
      iconSize={tablet() ? 14 : 16}
      labelTone={tablet() ? "ink" : "mutedInk"}
      size={16}
      disabled={props.disabled}
      style={{ paddingHorizontal: 0 }}
      onPress={props.onPress}
    />
  );
}

/**
 * A warning line with the design's 12px Warning mark before it: solid in list rows, the outline
 * where the design draws one (an external agent's sign-in, the editor's missing model).
 */
export function WarningLine(props: { text: string; outline?: boolean }) {
  return (
    <View
      style={{ ...row, alignSelf: "stretch", gap: 6, alignItems: "flex-start" }}
    >
      <View style={{ height: 16, justifyContent: "center" }}>
        <Icon
          name={props.outline ? "warning" : "warningFill"}
          size={12}
          tone="warning"
        />
      </View>
      <Label variant="small" tone="warningInk" style={{ flex: 1, minWidth: 0 }}>
        {props.text}
      </Label>
    </View>
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
  const trailingHeight = () => (props.stacked ? 28 : 24);
  return (
    <View
      style={{
        ...row,
        alignItems: "flex-start",
        flexShrink: 0,
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 8,
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
        style={{
          ...row,
          alignItems: "flex-start",
          flex: 1,
          minWidth: 0,
          gap: 10,
          cursor: props.onPress ? "pointer" : undefined,
        }}
      >
        <If when={props.leading}>
          <View
            style={{
              width: props.leadingSize ?? 24,
              height: props.leadingSize ?? 24,
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {props.leading}
          </View>
        </If>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Label
            weight={weight.regular}
            tone={props.titleTone ?? "ink"}
            style={
              props.strike ? { textDecorationLine: "line-through" } : undefined
            }
          >
            {props.title}
          </Label>
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
        <If when={props.lane !== false && !props.stacked}>
          <StatusLane status={props.status} width={props.laneWidth} />
        </If>
      </View>
      <If
        when={props.menu && !props.stacked}
        else={
          <If when={!props.stacked || props.caret}>
            <View
              style={{
                width: 24,
                height: trailingHeight(),
                flexShrink: 0,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <If when={props.caret}>
                <Icon name="right" size={16} tone="mutedInk" />
              </If>
            </View>
          </If>
        }
      >
        <ActionMenu
          label={props.menuLabel ?? props.title}
          triggerStyle={{
            minWidth: 24,
            width: 24,
            height: 24,
            paddingHorizontal: 0,
          }}
        >
          {props.menu}
        </ActionMenu>
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
