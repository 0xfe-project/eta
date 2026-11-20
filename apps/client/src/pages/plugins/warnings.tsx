import type { PluginView } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import { Button, colors, Icon, Label, Modal, row } from "../../components";
import { CloseButton } from "../../components/navigation-buttons";
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
      else={<Label tone="muted">{uiText("noWarnings")}</Label>}
    >
      <Each of={warnings()} key={(warning) => warning.text}>
        {(warning) => (
          <Label
            size={12}
            line={16}
            tone={warningTone(warning(), props.inline)}
          >
            {warning().text}
          </Label>
        )}
      </Each>
    </If>
  );
}

export function PluginWarningsDialog(props: {
  item: PluginView;
  onClose: () => void;
}) {
  const c = colors();
  return (
    <Modal
      title={uiText("warningsFor", { name: props.item.name })}
      width={384}
      blurBackdrop={false}
      overPhoneNavigation
      hideHeader
      panelStyle={{ gap: 12 }}
      onClose={props.onClose}
    >
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 16,
          paddingTop: 16,
        }}
      >
        <Label weight={500} lines={1} style={{ flexShrink: 1 }}>
          {uiText("warningsFor", { name: props.item.name })}
        </Label>
        <CloseButton
          onPress={props.onClose}
          style={{ marginVertical: -2, marginRight: -6 }}
        />
      </View>
      <Scroll style={{ maxHeight: 300 }} scrollbar={false}>
        <View style={{ paddingHorizontal: 16, gap: 6 }}>
          <WarningsText item={props.item} />
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={text("ok")}
          tone="primary"
          size={28}
          style={{ paddingHorizontal: 14 }}
          onPress={props.onClose}
        />
      </View>
    </Modal>
  );
}

export function PluginWarnings(props: {
  item: PluginView;
  onRefresh: () => Promise<void>;
}) {
  const c = colors();
  const checking = signal(false);
  return (
    <View style={{ borderWidth: 1, borderColor: c().border }}>
      <View
        style={{
          ...row,
          gap: 8,
          height: 32,
          paddingHorizontal: 10,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Icon name="info" size={14} />
        <Label weight={600} size={12} line={16}>
          {uiText("warningsFor", { name: props.item.name })}
        </Label>
      </View>
      <View style={{ padding: 10, gap: 8 }}>
        <WarningsText item={props.item} inline />
        <Button
          label={checking() ? uiText("checking") : uiText("checkAgain")}
          disabled={checking()}
          icon="refresh"
          labelSize={11}
          style={{ alignSelf: "flex-start", marginTop: 2 }}
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
