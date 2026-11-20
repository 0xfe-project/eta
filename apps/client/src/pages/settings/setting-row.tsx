import type { AgentUsage, AgentView } from "@eta/client-contracts";
import type { IconName } from "../../components/icons";
import { View } from "nsh";
import { ActionItem, colors, Icon, Label, row } from "../../components";
import { useModels } from "../../components/model-select";
import { formatLocale, uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { EntityRow, LetterBox, WarningLine } from "./section";

/** 48,213 → "48k": a token count the way a row's meta line says it. */
function tokens(count: number) {
  return new Intl.NumberFormat(formatLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(count)
    .toLowerCase();
}

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

export function AgentSetting(props: {
  agent: AgentView;
  /** The avatar's side: the tablet draws it at 28, the dialog at 24. */
  avatar?: number;
  onPress: () => void;
}) {
  const host = useHost();
  const c = colors();
  const models = useModels();
  follow(() => "usage");
  const model = () => models().find((entry) => entry.id === props.agent.model);
  const missing = () =>
    props.agent.runtime === "eta" && !!props.agent.model && !model();
  const usage = () =>
    host
      .section<readonly AgentUsage[]>("usage", "agents")
      ?.find((entry) => entry.agentId === props.agent.id)?.windows["7d"].total;
  const meta = () =>
    [
      model()?.name ?? props.agent.model ?? props.agent.runtime,
      usage() ? uiText("agentModelUsage", { usage: tokens(usage()!) }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <EntityRow
      title={props.agent.name}
      leading={<LetterBox name={props.agent.name} size={props.avatar} />}
      leadingSize={props.avatar}
      meta={
        <If
          when={missing()}
          else={
            <Label size={12} line={16} tone="muted" lines={1}>
              {meta()}
            </Label>
          }
        >
          <WarningLine text={props.agent.model ?? ""} />
        </If>
      }
      status={{
        label:
          props.agent.status === "idle"
            ? uiText("idle")
            : props.agent.status === "working"
              ? uiText("working2")
              : uiText("waitingForInput"),
        color: props.agent.status === "working" ? c().blue : c().faint,
      }}
      menuLabel={props.agent.name}
      menu={
        <ActionItem label={uiText("settingsEdit")} onSelect={props.onPress} />
      }
      onPress={props.onPress}
    />
  );
}
