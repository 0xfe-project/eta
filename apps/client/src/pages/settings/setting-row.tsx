import type { AgentView } from "@eta/client-contracts";
import type { IconName } from "../../components/icons";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";

export function SettingRow(props: {
  icon: IconName;
  title: string;
  detail?: string;
  onPress?: () => void;
}) {
  const c = colors();
  return (
    <View
      role={props.onPress ? "button" : undefined}
      onPress={props.onPress}
      hoverStyle={props.onPress ? { backgroundColor: c().selected } : undefined}
      style={{
        ...row,
        minHeight: 55,
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 7,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Icon name={props.icon} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label weight={500}>{props.title}</Label>
        <Label size={12} tone="muted" lines={2}>
          {props.detail}
        </Label>
      </View>
      <If when={props.onPress}>
        <Icon name="right" size={10} tone="muted" />
      </If>
    </View>
  );
}

export function AgentSetting(props: { agent: AgentView; onPress: () => void }) {
  const c = colors();
  return (
    <View
      role="button"
      onPress={() => props.onPress()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        minHeight: 55,
        gap: 10,
        alignItems: "flex-start",
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
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
        <Label size={12} weight={600}>
          {props.agent.name.slice(0, 1).toUpperCase()}
        </Label>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label weight={500}>{props.agent.name}</Label>
        <Label size={12} tone="muted" lines={1}>
          {props.agent.model ?? props.agent.runtime}
        </Label>
      </View>
      <View style={{ ...row, width: 104, gap: 6 }}>
        <StatusDot
          color={props.agent.status === "working" ? c().blue : c().faint}
        />
        <Label size={12} tone="muted">
          {props.agent.status === "idle"
            ? uiText("idle")
            : props.agent.status === "working"
              ? uiText("working2")
              : uiText("waitingForInput")}
        </Label>
      </View>
      <Icon name="more" size={12} tone="faint" />
    </View>
  );
}
