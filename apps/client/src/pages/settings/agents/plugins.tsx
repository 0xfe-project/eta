import type { PluginView } from "@eta/client-contracts";
import type { AgentForm } from "./form";
import { View } from "nsh";
import { colors, Label, row } from "../../../components";
import { EmptyState } from "../../../components/empty-state";
import { icon, opacity, space, weight } from "../../../components/tokens";
import { localizedText, uiText } from "../../../i18n";

import { useHost } from "../../../services/host";
import { useLoadState } from "../../../services/load-status";
import { CheckControl } from "../../../ui";
import { useComposioPlugins } from "../../plugins/composio-plugins";
import { SectionHeader, StatusLane, StatusLine, WarningLine } from "../section";

/** A plugin's status column: room for "Needs setup" and its dot. */
const pluginLaneWidth = 108;

export function AgentPlugins(props: { form: AgentForm }) {
  const { plugins, phoneEditor } = props.form;
  const host = useHost();
  const c = colors();
  const activePlugins = () => host.list<PluginView>("plugins");
  /** The connected Composio toolkits, as plugins of their own after the installed ones. */
  const composio = useComposioPlugins();
  const shown = () => activePlugins().length + composio.list().length;
  const load = useLoadState({ targets: () => ["plugins"] });
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
  /** What the row of a toolkit switched off for every agent says: the words and the mark of an installed plugin's. */
  const off = () => ({ label: uiText("pluginOffForAll"), color: c().faint });
  return (
    <View>
      <If when={!phoneEditor()}>
        <SectionHeader
          title={uiText("plugins")}
          count={shown()}
          description={uiText("pluginsHint")}
        />
      </If>
      <If
        when={shown()}
        else={
          <EmptyState
            size="card"
            status={load.shown()}
            loading={uiText("loadingPlugins")}
            error={{
              title: uiText("pluginsDidNotLoad"),
              retry: load.retry,
              retrying: load.retrying(),
            }}
            empty={{
              art: "plugins",
              title: uiText("noPluginsInstalled"),
              description: uiText("noPluginsInstalledHint"),
            }}
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
                  opacity: item().enabled ? 1 : opacity.muted,
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
        <Each of={composio.list()} key={(item) => item.name}>
          {(item) => {
            const checked = () => plugins().includes(item().name);
            /** Only a toolkit that checked out. */
            const usable = () => item().state === "ready";
            return (
              <CheckControl
                label={item().name}
                checked={checked()}
                disabled={!usable() && !checked()}
                onChange={(enabled) =>
                  plugins.update((list) =>
                    enabled
                      ? [...new Set([...list, item().name])]
                      : list.filter((entry) => entry !== item().name),
                  )
                }
                size={icon.md}
                // design-value: 10px mark in the phone's larger checkbox, between icon sizes
                markSize={phoneEditor() ? 10 : icon.sm}
                // design-value: 6px inset of the phone's larger checkbox, not on the space scale
                indicatorStyle={{ margin: phoneEditor() ? 6 : space[4] }}
                style={{
                  ...row,
                  alignItems: "flex-start",
                  paddingHorizontal: space[16],
                  paddingVertical: space[8],
                  gap: 10, // design-value: 10px between the checkbox and the text, not on the space scale
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  cursor: usable() || checked() ? "pointer" : "default",
                  opacity: item().enabled ? 1 : 0.55, // design-value: a switched-off row, fainter than muted and not disabled
                }}
              >
                <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                  <Label weight={500}>{item().name}</Label>
                  {/* The same mark and words as an installed plugin's row: the phone's status line under the name; otherwise the lane, at the right end of the line of the name (below). */}
                  <If when={phoneEditor() && !item().enabled}>
                    <View testID="composio-plugin-off">
                      <StatusLine status={off()} />
                    </View>
                  </If>
                  <Label variant="small" tone="muted">
                    {uiText("composioToolkit")}
                  </Label>
                  <If when={item().state !== "ready"}>
                    <View testID="composio-plugin-error">
                      <WarningLine text={uiText("composioPluginError")} />
                    </View>
                  </If>
                </View>
                <If when={!phoneEditor() && !item().enabled}>
                  <View testID="composio-plugin-off" style={{ flexShrink: 0 }}>
                    {/* design-value: the status lane's own width, as on the installed plugin row */}
                    <StatusLane width={108} status={off()} />
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
