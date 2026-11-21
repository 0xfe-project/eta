import type { PluginView } from "@eta/client-contracts";
import type { AgentForm } from "./form";
import { View } from "nsh";
import { colors, Empty, Label, row } from "../../../components";
import { CheckControl } from "../../../components/check-control";
import { localizedText, uiText } from "../../../i18n";

import { useHost } from "../../../services/host";
import {
  emptyStyle,
  SectionHeader,
  StatusLane,
  StatusLine,
  WarningLine,
} from "../section";

export function AgentPlugins(props: { form: AgentForm }) {
  const { plugins, phoneEditor, external, runtimeLabel, runtime } = props.form;
  /** The runtime says it takes no MCP servers: a plugin's servers never reach this agent. */
  const noServers = () =>
    external()?.capabilities?.refused?.mcpServers !== undefined;
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
  /** The phone lists the counts and the servers on lines of their own. */
  const counts = (item: PluginView) =>
    localizedText(
      `${item.skills.length} skills · ${item.servers.length} MCP servers`,
      `${item.skills.length} 项技能 · ${item.servers.length} 个 MCP 服务器`,
    );
  const serverLine = (item: PluginView) =>
    item.servers
      .map((server) => `${transports[server.transport]} · ${server.name}`)
      .join(", ");
  const status = (item: PluginView) =>
    item.state === "ready"
      ? {
          label: phoneEditor()
            ? uiText("pluginCanBeEnabled")
            : uiText("pluginCanEnable"),
          color: c().faint,
        }
      : {
          label: phoneEditor()
            ? uiText("pluginNeedsConfiguring")
            : uiText("pluginNeedsSetup"),
          color: c().amber,
        };
  return (
    <View>
      <If when={!phoneEditor()}>
        <SectionHeader
          title={uiText("plugins")}
          count={activePlugins().length}
          description={uiText("pluginsHint")}
        />
      </If>
      <If when={noServers()}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
          <WarningLine
            text={localizedText(
              `${runtimeLabel(runtime())} takes no MCP servers, so this agent gets none of the plugins' servers.`,
              `${runtimeLabel(runtime())} 不接受 MCP 服务器，这个智能体拿不到插件里的服务器。`,
            )}
          />
        </View>
      </If>
      <If
        when={activePlugins().length}
        else={
          <Empty
            title={uiText("noPluginsInstalled")}
            descriptionWidth={320}
            style={emptyStyle}
          />
        }
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
                markSize={phoneEditor() ? 10 : 12}
                indicatorStyle={{ margin: phoneEditor() ? 6 : 4 }}
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
                <If
                  when={phoneEditor()}
                  else={
                    <>
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Label weight={500}>{item().name}</Label>
                        <If
                          when={checked() && !ready()}
                          else={
                            <Label variant="small" tone="muted">
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
                      <StatusLane width={108} status={status(item())} />
                    </>
                  }
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Label weight={500}>{item().name}</Label>
                    <StatusLine status={status(item())} />
                    <Label variant="small" tone="muted">
                      {counts(item())}
                    </Label>
                    <If when={serverLine(item())}>
                      <Label variant="small" tone="muted">
                        {serverLine(item())}
                      </Label>
                    </If>
                    <If when={checked() && !ready()}>
                      <WarningLine text={uiText("pluginConfigurationStale")} />
                    </If>
                  </View>
                </If>
              </CheckControl>
            );
          }}
        </Each>
      </If>
    </View>
  );
}
