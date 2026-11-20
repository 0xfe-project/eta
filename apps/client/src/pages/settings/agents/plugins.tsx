import type { PluginView } from "@eta/client-contracts";
import type { AgentForm } from "./form";
import { View } from "nsh";
import { colors, Label, row } from "../../../components";
import { CheckControl } from "../../../components/check-control";
import { localizedText, uiText } from "../../../i18n";

import { useHost } from "../../../services/host";

export function AgentPlugins(props: { form: AgentForm }) {
  const { plugins } = props.form;
  const host = useHost();
  const c = colors();
  const activePlugins = () => host.list<PluginView>("plugins");
  return (
    <View>
      <View style={{ padding: 16, gap: 4 }}>
        <Label
          size={13}
          weight={600}
        >{`${uiText("plugins")}  ${activePlugins().length}`}</Label>
        <Label size={11} tone="muted">
          {localizedText(
            "Pick the plugins this agent may use.",
            "选择这个智能体可以使用的插件。",
          )}
        </Label>
      </View>
      <Each of={activePlugins()} key={(item) => item.name}>
        {(item) => {
          const checked = () => plugins().includes(item().name);
          const ready = () => item().state === "ready";
          return (
            <CheckControl
              label={item().name}
              checked={checked()}
              disabled={!ready() && !checked()}
              onChange={(enabled) =>
                plugins.update((list) =>
                  enabled
                    ? [...new Set([...list, item().name])]
                    : list.filter((entry) => entry !== item().name),
                )
              }
              size={15}
              indicatorStyle={{ marginTop: 1 }}
              style={{
                ...row,
                alignItems: "flex-start",
                paddingHorizontal: 16,
                paddingVertical: 9,
                gap: 8,
                minHeight: 45,
                borderTopWidth: 1,
                borderColor: c().border,
                cursor: ready() || checked() ? "pointer" : "default",
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Label size={12} weight={600}>
                  {item().name}
                </Label>
                <Label size={10} lines={1} tone="muted">
                  {localizedText(
                    `${item().skills.length} skills · ${item().servers.length} MCP servers`,
                    `${item().skills.length} 项技能 · ${item().servers.length} 个 MCP 服务器`,
                  )}
                </Label>
                <If when={checked() && !ready()}>
                  <Label size={10} tone="amber">
                    {localizedText(
                      "Its configuration no longer fits. Sessions skip it.",
                      "其配置已不适用，会话会跳过此插件。",
                    )}
                  </Label>
                </If>
              </View>
              <Label size={10} tone={ready() ? "muted" : "amber"}>
                {ready() ? uiText("canBeEnabled") : uiText("needsConfiguring")}
              </Label>
            </CheckControl>
          );
        }}
      </Each>
    </View>
  );
}
