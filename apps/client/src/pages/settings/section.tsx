import type { JSX, ViewStyle } from "nsh";
import { View } from "nsh";
import { ActionMenu, colors, Icon, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";

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
      <View style={{ ...row, height: 24, gap: 8 }}>
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
            weight={600}
            line={20}
            lines={1}
            tone={props.muted ? "muted" : "ink"}
          >
            {props.title}
          </Label>
          <If when={props.count !== undefined}>
            <Label size={12} line={16} tone="muted">
              {props.count}
            </Label>
          </If>
        </View>
        <If when={props.children}>
          <View style={{ ...row, gap: 8 }}>{props.children}</View>
        </If>
      </View>
      <If when={props.description}>
        <Label size={12} line={16} tone="muted">
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
            <Label size={12} line={16} tone="mutedInk" lines={1}>
              {status().label}
            </Label>
          </>
        )}
      </If>
    </View>
  );
}

/** A 12px warning line under an entity's name. */
export function WarningLine(props: { text: string }) {
  return (
    <Label size={12} line={16} tone="amber">
      {props.text}
    </Label>
  );
}

/**
 * One thing in a settings list: a 24px leading slot, the name and its meta, the status lane, and a
 * 24px trailing slot holding the row's menu or a caret.
 */
export function EntityRow(props: {
  title: string;
  leading?: JSX.Element;
  meta?: JSX.Element | string;
  titleTone?: "ink" | "muted";
  strike?: boolean;
  lane?: boolean;
  laneWidth?: number;
  status?: EntityStatus;
  menuLabel?: string;
  menu?: JSX.Element;
  caret?: boolean;
  onPress?: () => void;
}) {
  const c = colors();
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
        role={props.onPress ? "button" : undefined}
        accessibilityLabel={props.onPress ? props.title : undefined}
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
              width: 24,
              height: 24,
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
            weight={500}
            line={20}
            tone={props.titleTone ?? "ink"}
            style={
              props.strike ? { textDecorationLine: "line-through" } : undefined
            }
          >
            {props.title}
          </Label>
          <If when={typeof props.meta === "string"}>
            <Label size={12} line={16} tone="muted">
              {props.meta as string}
            </Label>
          </If>
          <If when={props.meta !== undefined && typeof props.meta !== "string"}>
            {props.meta}
          </If>
        </View>
        <If when={props.lane !== false}>
          <StatusLane status={props.status} width={props.laneWidth} />
        </If>
      </View>
      <If
        when={props.menu}
        else={
          <View
            style={{
              width: 24,
              height: 24,
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <If when={props.caret}>
              <Icon name="right" size={16} tone="mutedInk" />
            </If>
          </View>
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

/** The 24px box with an entity's first letter, standing in for a logo or avatar. */
export function LetterBox(props: { name: string }) {
  const c = colors();
  return (
    <View
      style={{
        width: 24,
        height: 24,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: c().strong,
      }}
    >
      <Label size={12} line={16} weight={600}>
        {props.name.slice(0, 1).toUpperCase()}
      </Label>
    </View>
  );
}
