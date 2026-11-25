import type { PluginView } from "@eta/client-contracts";
import type { ViewStyle } from "nsh";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { CloseButton } from "../../components/navigation-buttons";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";

import { pluginText as text } from "./labels";
export interface PluginWarning {
  text: string;
  blocking: boolean;
  /** The line about agents that enabled the plugin, quieter than the problem it follows. */
  agents?: boolean;
}

// Blocking lines keep the plugin from being used; the rest are advisory.
export function pluginWarnings(item: PluginView): PluginWarning[] {
  const agents = item.agents.map((agent) => agent.name).join(", ");
  const skipped =
    item.state === "needs_config" && agents
      ? uiText("pluginSkipped", { agents })
      : "";
  const blocking = [
    ...(item.problem ? [item.problem] : []),
    ...item.fields.flatMap((field) =>
      field.issue?.code !== "required" &&
      (!field.required || field.set || field.default !== undefined)
        ? []
        : [uiText("pluginRequiredMissing", { title: field.title })],
    ),
    ...(skipped ? [skipped] : []),
  ];
  const advisory = [
    ...item.machines.flatMap((machine) =>
      machine.checked && machine.missing.length
        ? [
            uiText("pluginMachineMissing", {
              machine: machine.name,
              commands: machine.missing.join(", "),
            }),
          ]
        : [],
    ),
    ...item.reports,
    ...item.servers.flatMap((server) =>
      server.problem ? [server.problem] : [],
    ),
  ];
  const seen = new Set<string>();
  return [
    ...blocking.map((text) => ({
      text,
      blocking: true,
      agents: text === skipped,
    })),
    ...advisory.map((text) => ({ text, blocking: false })),
  ].filter((warning) => !seen.has(warning.text) && seen.add(warning.text));
}

// The dialog has two tones; the inline block on a plugin's page sets each kind apart.
function warningTone(warning: PluginWarning, inline = false) {
  if (!inline) return warning.blocking ? "ink" : "muted";
  if (warning.agents) return "muted";
  return warning.blocking ? "ink" : "mutedInk";
}

function WarningsText(props: { item: PluginView; inline?: boolean }) {
  const warnings = () => pluginWarnings(props.item);
  return (
    <If
      when={warnings().length}
      else={
        <EmptyState
          size="row"
          status="empty"
          loading={null}
          error={null}
          empty={{ title: uiText("noWarnings") }}
          style={{ paddingHorizontal: 0 }}
        />
      }
    >
      <Each of={warnings()} key={(warning) => warning.text}>
        {(warning) => (
          <Label variant="small" tone={warningTone(warning(), props.inline)}>
            {warning().text}
          </Label>
        )}
      </Each>
    </If>
  );
}

/** How far the dialog's list of warnings grows before it scrolls. */
const listHeight = 300;

export function PluginWarningsDialog(props: {
  item: PluginView;
  onClose: () => void;
}) {
  const c = colors();
  return (
    <Modal
      title={uiText("warningsFor", { name: props.item.name })}
      width={dialogWidth.md}
      modalFocus
      overPhoneNavigation
      hideHeader
      panelStyle={{ gap: space[12] }}
      onClose={props.onClose}
    >
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          gap: space[8],
          paddingHorizontal: space[16],
          paddingTop: space[16],
        }}
      >
        <Label weight={weight.regular} lines={1} style={{ flexShrink: 1 }}>
          {uiText("warningsFor", { name: props.item.name })}
        </Label>
        <CloseButton
          onPress={props.onClose}
          iconSize={icon.md}
          style={{ marginVertical: -space[2], marginRight: -space[8] }}
        />
      </View>
      <SmoothScroll style={{ maxHeight: listHeight }} scrollbar={false}>
        <View style={{ paddingHorizontal: space[16], gap: space[4] }}>
          <WarningsText item={props.item} />
        </View>
      </SmoothScroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          paddingHorizontal: space[16],
          paddingVertical: space[12],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={text("ok")}
          tone="primary"
          size={control.md}
          labelWeight={weight.regular}
          style={{ paddingHorizontal: space[16] }}
          onPress={props.onClose}
        />
      </View>
    </Modal>
  );
}

export function PluginWarnings(props: {
  item: PluginView;
  phone?: boolean;
  style?: ViewStyle;
  onRefresh: () => Promise<void>;
}) {
  const c = colors();
  const checking = signal(false);
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c().border,
        ...(props.phone
          ? { paddingLeft: space[12], paddingBottom: space[4], gap: space[8] }
          : {}),
        ...props.style,
      }}
    >
      <View
        style={{
          ...row,
          borderBottomWidth: 1,
          borderColor: c().border,
          ...(props.phone
            ? { gap: space[4], paddingTop: space[2], paddingBottom: space[8] }
            : {
                gap: space[8],
                height: space[32],
                paddingHorizontal: space[12],
              }),
        }}
      >
        <Icon name="warning" size={icon.md} />
        <Label weight={weight.strong} variant="small">
          {uiText("warningsFor", { name: props.item.name })}
        </Label>
      </View>
      <View
        style={
          props.phone
            ? { gap: space[8] }
            : { padding: space[12], gap: space[8] }
        }
      >
        <WarningsText item={props.item} inline />
        <Button
          label={uiText("checkAgain")}
          busy={checking()}
          icon="refresh"
          spinIcon
          size={props.phone ? control.md : undefined}
          labelVariant="caption"
          style={
            props.phone
              ? {
                  alignSelf: "flex-start",
                  gap: space[4],
                  paddingHorizontal: space[12],
                }
              : { alignSelf: "flex-start", marginTop: space[2] }
          }
          onPress={() => {
            if (checking()) return;
            checking.set(true);
            void props.onRefresh().finally(() => checking.set(false));
          }}
        />
      </View>
    </View>
  );
}
