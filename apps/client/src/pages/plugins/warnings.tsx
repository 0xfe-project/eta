import type { PluginView } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import { Button, colors, Icon, Label, Modal, row } from "../../components";
import { formatLocale, uiText } from "../../i18n";

import { pluginText as text } from "./labels";
export function pluginWarnings(item: PluginView) {
  const zh = formatLocale().startsWith("zh");
  const names = item.agents.map((agent) => agent.name).join(", ");
  return [
    ...new Set([
      ...(item.problem ? [item.problem] : []),
      ...item.fields.flatMap((field) => {
        if (
          field.issue?.code !== "required" &&
          (!field.required || field.set || field.default !== undefined)
        )
          return [];
        return [
          zh
            ? `缺少必填项“${field.title}”。`
            : `Required field "${field.title}" is missing.`,
        ];
      }),
      ...(item.state === "needs_config" && names
        ? [
            zh
              ? `${names} 已启用这个插件。修好配置后才会继续使用。`
              : `${names} enabled this plugin. It is skipped until its configuration is fixed.`,
          ]
        : []),
      ...item.machines.flatMap((machine) =>
        machine.checked && machine.missing.length
          ? [
              zh
                ? `${machine.name} 缺少 ${machine.missing.join(", ")}。`
                : `${machine.name} is missing ${machine.missing.join(", ")}.`,
            ]
          : [],
      ),
      ...item.reports,
      ...item.servers.flatMap((server) =>
        server.problem ? [server.problem] : [],
      ),
    ]),
  ];
}

function WarningsText(props: { item: PluginView }) {
  const warnings = () => pluginWarnings(props.item);
  return (
    <If
      when={warnings().length}
      else={<Label tone="muted">{uiText("noWarnings")}</Label>}
    >
      <Each of={warnings()} key={(warning) => warning}>
        {(warning, index) => (
          <Label size={12} line={18} tone={index() === 0 ? "ink" : "mutedInk"}>
            {warning()}
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
      onClose={props.onClose}
    >
      <Scroll style={{ maxHeight: 300 }} scrollbar={false}>
        <View style={{ padding: 14, gap: 5 }}>
          <WarningsText item={props.item} />
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={text("ok")}
          tone="primary"
          size={28}
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
          gap: 7,
          minHeight: 31,
          paddingHorizontal: 10,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Icon name="info" size={13} />
        <Label weight={600} size={12}>
          {uiText("warningsFor", { name: props.item.name })}
        </Label>
      </View>
      <View style={{ padding: 10, gap: 6 }}>
        <WarningsText item={props.item} />
        <Button
          label={checking() ? uiText("checking") : uiText("checkAgain")}
          disabled={checking()}
          icon="refresh"
          style={{ alignSelf: "flex-start" }}
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
