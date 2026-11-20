import type { AgentView, ConversationSummary } from "@eta/client-contracts";
import type { Layout } from "../components";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../components";
import { AgentFace } from "../components/agent-face";
import { StatusDot } from "../components/status-dot";
import { uiText } from "../i18n";
import { relativeTime, useHost } from "../services/host";
import { RailEntry } from "./rail-controls";

export function GroupRow(props: {
  group: ConversationSummary;
  selected: boolean;
  layout: Layout;
  collapsed?: boolean;
  onPress: () => void;
}) {
  const host = useHost();
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
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        minHeight: phone() ? 64 : 53,
        flexShrink: 0,
        paddingLeft: phone() ? 16 : 14,
        paddingRight: phone() ? 12 : 14,
        paddingTop: phone() ? 0 : 8,
        paddingBottom: phone() ? 0 : 6,
        gap: phone() ? 12 : 2,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
        backgroundColor: props.selected ? c().selected : "transparent",
        ...(phone() ? row : {}),
      }}
    >
      <If when={phone()}>
        <View style={{ ...row, width: 36, paddingLeft: 2, flexShrink: 0 }}>
          <Each of={people()}>
            {(person, index) => (
              <View style={{ marginLeft: index() ? -4 : 0 }}>
                <AgentFace id={person().agentId} size={16} />
              </View>
            )}
          </Each>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Label line={20} lines={1}>
            {props.group.name}
          </Label>
          <Label size={11} line={14} tone="muted" lines={1}>
            {props.group.preview}
          </Label>
        </View>
        <If when={props.group.unread > 0}>
          <StatusDot color={c().blue} />
        </If>
        <Label
          size={11}
          line={14}
          tone="muted"
          style={{ width: 28, textAlign: "right", flexShrink: 0 }}
        >
          {time()}
        </Label>
        <RowChevron />
      </If>
      <If when={!phone()}>
        <View style={{ ...row, gap: 6 }}>
          <View style={row}>
            <Each of={people()}>
              {(person) => <AgentFace id={person().agentId} size={16} />}
            </Each>
          </View>
          <Label size={16} line={22} lines={1} style={{ flex: 1 }}>
            {props.group.name}
          </Label>
          <Label size={10} line={14} tone="muted">
            {time()}
          </Label>
        </View>
        <Label size={10} line={14} tone="muted" lines={1}>
          {project()?.display ?? ""}
        </Label>
      </If>
    </View>
  );
  return (
    <If when={props.collapsed} else={detailed()}>
      <RailEntry
        label={props.group.name}
        selected={props.selected}
        status={
          props.group.participants.some((person) => person.status !== "idle")
            ? "active"
            : undefined
        }
        onPress={props.onPress}
      >
        <View style={{ ...row, height: 14 }}>
          <Each of={people()} key={(person) => person.agentId}>
            {(person, index) => (
              <View style={{ marginLeft: index() ? -3 : 0 }}>
                <AgentFace id={person().agentId} size={14} />
              </View>
            )}
          </Each>
        </View>
      </RailEntry>
    </If>
  );
}

export function AgentRow(props: {
  agent: AgentView;
  phone: boolean;
  collapsed?: boolean;
  onPress: () => void;
}) {
  const c = colors();
  const detailed = () => (
    <View
      role="button"
      accessibilityLabel={props.agent.name}
      onPress={() => props.onPress()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: props.phone ? 52 : 33,
        paddingLeft: 16,
        paddingRight: props.phone ? 12 : 16,
        flexShrink: 0,
        gap: props.phone ? 12 : 8,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View
        style={{
          width: props.phone ? 36 : 20,
          paddingLeft: props.phone ? 2 : 0,
          flexShrink: 0,
        }}
      >
        <AgentFace id={props.agent.id} size={20} />
      </View>
      <Label line={20} lines={1} style={{ flex: 1 }}>
        {props.agent.name}
      </Label>
      <If when={props.phone}>
        <Label
          size={11}
          line={14}
          tone="muted"
          lines={1}
          style={{ minWidth: 32, textAlign: "right", flexShrink: 0 }}
        >
          {props.agent.status === "working"
            ? uiText("working2")
            : uiText("idle")}
        </Label>
        <RowChevron />
      </If>
      <If when={!props.phone}>
        <StatusDot
          color={props.agent.status === "working" ? c().blue : c().muted}
          opacity={props.agent.status === "working" ? 1 : 0.4}
        />
      </If>
    </View>
  );
  return (
    <If when={props.collapsed} else={detailed()}>
      <RailEntry
        label={props.agent.name}
        agent
        status={
          props.agent.status === "working"
            ? "active"
            : props.agent.status === "waiting_for_input"
              ? "waiting"
              : "idle"
        }
        onPress={props.onPress}
      >
        <AgentFace id={props.agent.id} size={24} />
      </RailEntry>
    </If>
  );
}

/** The 14px foreground caret at 45% in a 16px slot that ends phone list rows. */
function RowChevron() {
  return (
    <View style={{ width: 16, alignItems: "center", flexShrink: 0 }}>
      <View style={{ opacity: 0.45 }}>
        <Icon name="right" size={14} />
      </View>
    </View>
  );
}
