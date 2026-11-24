import type { ConversationSummary } from "@eta/client-contracts";
import type { JSX, Point } from "nsh";
import type { Layout } from "../components";
import { View } from "nsh";
import { colors, focusRing, Label, row, RowChevron } from "../components";
import { AgentFace } from "../components/agent-face";
import { touchScreen } from "../components/menu";
import { StatusDot } from "../components/status-dot";
import { avatar, control, space } from "../components/tokens";
import { relativeTime, useHost } from "../services/host";
import { RailEntry } from "./rail-controls";

const groupRowHeight = { phone: 64, regular: 52 } as const;
/** A phone's group row: its members' faces, overlapped. */
const facesWidth = 36;

export function GroupRow(props: {
  group: ConversationSummary;
  selected: boolean;
  layout: Layout;
  collapsed?: boolean;
  onPress: () => void;
  /** A right click, or a long press on a touch screen, asked for its menu here (in the row). */
  onMenu?: (at: Point) => void;
  /** Drawn over the row, such as its menu. */
  children?: JSX.Element;
}) {
  const host = useHost();
  const menu = {
    onContextMenu: (event: { position: Point }) =>
      props.onMenu?.(event.position),
    onLongPress: touchScreen
      ? (event: { position: Point }) => props.onMenu?.(event.position)
      : undefined,
  };
  const c = colors();
  const phone = () => props.layout === "phone";
  const people = () => props.group.participants.slice(0, 3);
  const project = () =>
    host.projects().find((project) => project.id === props.group.projectId);
  const time = () =>
    relativeTime(
      Math.max(props.group.lastMessageAt ?? 0, props.group.updatedAt),
    );
  const detailed = () => (
    <View
      role="button"
      accessibilityLabel={props.group.name}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onPress()}
      {...menu}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={focusRing(c())}
      style={{
        minHeight: phone() ? groupRowHeight.phone : groupRowHeight.regular,
        flexShrink: 0,
        paddingLeft: space[16],
        paddingRight: phone() ? space[12] : space[16],
        paddingTop: phone() ? 0 : space[8],
        paddingBottom: phone() ? 0 : space[8],
        gap: phone() ? space[12] : space[2],
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
        backgroundColor: props.selected ? c().selected : "transparent",
        ...(phone() ? row : {}),
      }}
    >
      <If when={phone()}>
        <View
          style={{
            ...row,
            width: facesWidth,
            paddingLeft: space[2],
            flexShrink: 0,
          }}
        >
          <Each of={people()}>
            {(person, index) => (
              <View style={{ marginLeft: index() ? -space[4] : 0 }}>
                <AgentFace id={person().agentId} size={avatar.sm} />
              </View>
            )}
          </Each>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
          <Label lines={1}>{props.group.name}</Label>
          <Label variant="caption" tone="muted" lines={1}>
            {props.group.preview}
          </Label>
        </View>
        <If when={props.group.unread > 0}>
          <StatusDot color={c().blue} />
        </If>
        <Label
          variant="caption"
          tone="muted"
          style={{ width: control.md, textAlign: "right", flexShrink: 0 }}
        >
          {time()}
        </Label>
        <RowChevron />
      </If>
      <If when={!phone()}>
        <View style={{ ...row, gap: space[4] }}>
          <View style={row}>
            <Each of={people()}>
              {(person) => <AgentFace id={person().agentId} size={avatar.sm} />}
            </Each>
          </View>
          <Label variant="subtitle" lines={1} style={{ flex: 1 }}>
            {props.group.name}
          </Label>
          <Label variant="caption" tone="muted">
            {time()}
          </Label>
        </View>
        <Label variant="caption" tone="muted" lines={1}>
          {project()?.display ?? ""}
        </Label>
      </If>
    </View>
  );
  return (
    <View style={{ flexShrink: 0 }}>
      <If when={props.collapsed} else={detailed()}>
        <RailEntry
          {...menu}
          label={props.group.name}
          selected={props.selected}
          active={props.group.participants.some(
            (person) => person.status !== "idle",
          )}
          onPress={props.onPress}
        >
          <View style={{ ...row, height: avatar.sm }}>
            <Each of={people()} key={(person) => person.agentId}>
              {(person, index) => (
                <View style={{ marginLeft: index() ? -space[4] : 0 }}>
                  <AgentFace id={person().agentId} size={avatar.sm} />
                </View>
              )}
            </Each>
          </View>
        </RailEntry>
      </If>
      {props.children}
    </View>
  );
}
