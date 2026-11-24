import type { PluginView } from "@eta/client-contracts";
import type { AgentForm } from "./form";
import { View } from "nsh";
import { colors, Empty, emptyWidth, Label, row } from "../../../components";
import { CheckControl } from "../../../components/check-control";
import { icon, opacity, space, weight } from "../../../components/tokens";
import { localizedText, uiText } from "../../../i18n";

import { useHost } from "../../../services/host";
import {
  emptyStyle,
  SectionHeader,
  StatusLane,
  StatusLine,
  WarningLine,
} from "../section";

/** A plugin's status column: room for "Needs setup" and its dot. */
const pluginLaneWidth = 108;

export function AgentPlugins(props: { form: AgentForm }) {
  const { plugins, phoneEditor } = props.form;
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
  /** Nothing for a ready plugin: "can enable" adds nothing. */
  const status = (item: PluginView) =>
    !item.enabled
      ? { label: uiText("pluginOffForAll"), color: c().faint }
      : item.state === "ready"
        ? undefined
        : {
            label: phoneEditor()
              ? uiText("pluginNeedsConfiguring")
              : uiText("pluginNeedsSetup"),
            color: c().warning,
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
      <If
        when={activePlugins().length}
        else={
          <Empty
            title={uiText("noPluginsInstalled")}
            descriptionWidth={emptyWidth.narrow}
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
                size={icon.md}
                markSize={icon.sm}
                indicatorStyle={{ margin: phoneEditor() ? space[8] : space[4] }}
                style={{
                  ...row,
                  alignItems: "flex-start",
                  paddingHorizontal: space[16],
                  paddingVertical: space[8],
                  gap: space[8],
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  cursor: ready() || checked() ? "pointer" : "default",
                  opacity: item().enabled ? 1 : opacity.disabled,
                }}
              >
                <If
                  when={phoneEditor()}
                  else={
                    <>
                      <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                        <Label weight={weight.regular}>{item().name}</Label>
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
                      <If when={status(item())}>
                        {(shown) => (
                          <StatusLane
                            width={pluginLaneWidth}
                            status={shown()}
                          />
                        )}
                      </If>
                    </>
                  }
                >
                  <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                    <Label weight={weight.regular}>{item().name}</Label>
                    <If when={status(item())}>
                      {(shown) => <StatusLine status={shown()} />}
                    </If>
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
