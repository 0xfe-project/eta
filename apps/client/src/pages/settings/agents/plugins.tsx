import type { PluginView } from "@eta/client-contracts";
import type { AgentForm } from "./form";
import { View } from "nsh";
import { colors, Empty, Label, row } from "../../../components";
import { CheckControl } from "../../../components/check-control";
import { localizedText, uiText } from "../../../i18n";

import { useHost } from "../../../services/host";
import { emptyStyle, SectionHeader, StatusLane, WarningLine } from "../section";

export function AgentPlugins(props: { form: AgentForm }) {
  const { plugins } = props.form;
  const host = useHost();
  const c = colors();
  const activePlugins = () => host.list<PluginView>("plugins");
  const transports = { stdio: "stdio", "streamable-http": "HTTP", sse: "SSE" };
  const meta = (item: PluginView) => {
    const servers = item.servers
      .map((server) => `${transports[server.transport]} ${server.name}`)
      .join(", ");
    return [
      localizedText(
        `${item.skills.length} skill${item.skills.length === 1 ? "" : "s"}`,
        `${item.skills.length} 项技能`,
      ),
      localizedText(
        `${item.servers.length} MCP server${item.servers.length === 1 ? "" : "s"}`,
        `${item.servers.length} 个 MCP 服务器`,
      ) + (servers ? ` (${servers})` : ""),
    ].join(" · ");
  };
  return (
    <View>
      <SectionHeader
        title={uiText("plugins")}
        count={activePlugins().length}
        description={uiText("pluginsHint")}
      />
      <If
        when={activePlugins().length}
        else={<Empty title={uiText("noPluginsInstalled")} style={emptyStyle} />}
      >
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
                size={16}
                markSize={12}
                indicatorStyle={{ margin: 4 }}
                style={{
                  ...row,
                  alignItems: "flex-start",
                  paddingHorizontal: 16,
                  paddingVertical: 8,
                  gap: 10,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  cursor: ready() || checked() ? "pointer" : "default",
                }}
              >
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Label line={20} weight={500}>
                    {item().name}
                  </Label>
                  <If
                    when={checked() && !ready()}
                    else={
                      <Label size={12} line={16} tone="muted">
                        {meta(item())}
                      </Label>
                    }
                  >
                    <WarningLine
                      text={localizedText(
                        "Its configuration no longer fits. Sessions skip it.",
                        "其配置已不适用，会话会跳过此插件。",
                      )}
                    />
                  </If>
                </View>
                <StatusLane
                  width={108}
                  status={{
                    label: ready()
                      ? uiText("pluginCanEnable")
                      : uiText("pluginNeedsSetup"),
                    color: ready() ? c().faint : c().amber,
                  }}
                />
              </CheckControl>
            );
          }}
        </Each>
      </If>
    </View>
  );
}
