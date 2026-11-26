import type { AgentUsage, AgentView } from "@eta/client-contracts";
import type { IconName } from "../../components/icons";
import { isExternalRuntime } from "@eta/client-contracts";
import { ActionItem, colors, Icon, Label } from "../../components";
import { AgentFace } from "../../components/agent-face";
import { useModels } from "../../components/model-select";
import { avatar } from "../../components/tokens";
import { formatLocale, uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { ListRow } from "../../ui";
import { EntityRow, leadingBoxWidth, WarningLine } from "./section";

/** 48,213 → "48k": a token count the way a row's meta line says it. */
export function tokens(count: number) {
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
  return (
    <ListRow
      title={props.title}
      detail={props.detail}
      leading={<Icon name={props.icon} />}
      onPress={props.onPress}
    />
  );
}

export function AgentSetting(props: {
  agent: AgentView;
  /** The avatar's side: the tablet draws it at 28, the dialog at 24. */
  avatar?: number;
  /** The phone stacks the status under the name and says what the agent wears. */
  phone?: boolean;
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
  const brief = () =>
    (isExternalRuntime(props.agent.runtime) ? "" : props.agent.persona) ||
    props.agent.instructions.split("\n")[0] ||
    uiText("agentNoInstructions");
  const meta = () =>
    [
      model()?.name ?? props.agent.model ?? props.agent.runtime,
      props.phone
        ? brief()
        : usage()
          ? uiText("agentModelUsage", { usage: tokens(usage()!) })
          : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <EntityRow
      title={props.agent.name}
      leading={
        <AgentFace id={props.agent.id} size={props.avatar ?? avatar.md} />
      }
      leadingSize={props.phone ? leadingBoxWidth : props.avatar}
      stacked={props.phone}
      caret={props.phone}
      meta={
        <If
          when={missing()}
          else={
            <Label variant="small" tone="muted" lines={1}>
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
