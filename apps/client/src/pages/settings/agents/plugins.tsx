import type { PluginView } from "@eta/client-contracts";
import type { AgentForm } from "./form";
import { signal, View } from "nsh";
import { Button, colors, Label, row } from "../../../components";
import { EmptyState } from "../../../components/empty-state";
import {
  control,
  icon,
  opacity,
  space,
  weight,
} from "../../../components/tokens";
import { localizedText, uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { useLoadState } from "../../../services/load-status";
import { CheckControl } from "../../../ui";
import { useComposioPlugins } from "../../plugins/composio-plugins";
import { ConfigurePlugin } from "../../plugins/configure";
import { ServersDialog } from "../../plugins/servers-panel";
import { SectionHeader, StatusLane, StatusLine, WarningLine } from "../section";

/** A plugin's status column: room for "Needs setup" and its dot. */
const pluginLaneWidth = 108;

/** Pick which inline setup modal resolves a `needs_config` plugin (fields vs stdio `missingEnv`). */
export function pluginSetupModal(item: PluginView): "configure" | "servers" {
  const needsFields = item.fields.some(
    (field) => (field.required && !field.set) || field.issue !== null,
  );
  if (needsFields) return "configure";
  const needsEnv = item.servers.some(
    (server) => (server.missingEnv?.length ?? 0) > 0,
  );
  if (needsEnv || item.fields.length === 0) return "servers";
  return "configure";
}

export function AgentPlugins(props: {
  form: AgentForm;
  onOpenMarket?: () => void;
  onOpenPlugins?: (plugin?: string) => void;
}) {
  const { plugins, phoneEditor } = props.form;
  const host = useHost();
  const c = colors();
  const phone = () => Boolean(props.form.phone);
  const tablet = () => Boolean(props.form.tablet);
  const activePlugins = () => host.list<PluginView>("plugins");
  /** The connected Composio toolkits, as plugins of their own after the installed ones. */
  const composio = useComposioPlugins();
  const shown = () => activePlugins().length + composio.list().length;
  const load = useLoadState({ targets: () => ["plugins"] });
  const configuring = signal<string | undefined>(undefined);
  const servers = signal<string | undefined>(undefined);
  const configuringItem = () =>
    activePlugins().find((item) => item.name === configuring());
  const serversItem = () =>
    activePlugins().find((item) => item.name === servers());

  function openSetup(item: PluginView) {
    if (pluginSetupModal(item) === "configure") configuring.set(item.name);
    else servers.set(item.name);
  }

  const transports = { stdio: "stdio", "streamable-http": "HTTP", sse: "SSE" };
  const meta = (item: PluginView) => {
    const serversText = item.servers
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
      ) + (serversText ? ` (${serversText})` : ""),
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
        >
          <If when={props.onOpenMarket}>
            <Button
              label={uiText("browseMarket")}
              tone="ghost"
              size={control.sm}
              style={{ paddingHorizontal: space[8] }}
              onPress={() => props.onOpenMarket?.()}
            />
          </If>
        </SectionHeader>
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
              actions: props.onOpenMarket
                ? [
                    {
                      label: uiText("browseMarket"),
                      onPress: () => props.onOpenMarket?.(),
                    },
                  ]
                : undefined,
            }}
          />
        }
      >
        <Each of={activePlugins()} key={(item) => item.name}>
          {(item) => {
            const checked = () => plugins().includes(item().name);
            const ready = () => item().state === "ready";
            const needsSetup = () =>
              item().enabled && item().state === "needs_config";
            return (
              <View
                style={{
                  ...row,
                  alignItems: "flex-start",
                  paddingHorizontal: space[16],
                  paddingVertical: space[8],
                  gap: space[8],
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  opacity: item().enabled ? 1 : opacity.muted,
                }}
              >
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
                  indicatorStyle={{
                    margin: phoneEditor() ? space[8] : space[4],
                  }}
                  style={{
                    ...row,
                    flex: 1,
                    minWidth: 0,
                    alignItems: "flex-start",
                    gap: space[8],
                    cursor: ready() || checked() ? "pointer" : "default",
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
                          {(shownStatus) => (
                            <StatusLane
                              width={pluginLaneWidth}
                              status={shownStatus()}
                            />
                          )}
                        </If>
                      </>
                    }
                  >
                    <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                      <Label weight={weight.regular}>{item().name}</Label>
                      <If when={status(item())}>
                        {(shownStatus) => <StatusLine status={shownStatus()} />}
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
                        <WarningLine
                          text={uiText("pluginConfigurationStale")}
                        />
                      </If>
                    </View>
                  </If>
                </CheckControl>
                <If when={needsSetup()}>
                  <Button
                    label={uiText("configure")}
                    size={control.sm}
                    style={{ paddingHorizontal: space[8], flexShrink: 0 }}
                    onPress={() => openSetup(item())}
                  />
                </If>
              </View>
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
                    <StatusLane width={pluginLaneWidth} status={off()} />
                  </View>
                </If>
              </CheckControl>
            );
          }}
        </Each>
        <If when={phoneEditor() && props.onOpenMarket}>
          <View
            style={{
              paddingHorizontal: space[16],
              paddingVertical: space[12],
            }}
          >
            <Button
              label={uiText("browseMarket")}
              size={control.md}
              style={{ paddingHorizontal: space[12] }}
              onPress={() => props.onOpenMarket?.()}
            />
          </View>
        </If>
      </If>
      <If when={configuringItem()}>
        {(item) => (
          <ConfigurePlugin
            item={item()}
            phone={phone()}
            tablet={tablet()}
            onClose={() => configuring.set(undefined)}
            onServers={() => {
              const pluginName = item().name;
              configuring.set(undefined);
              servers.set(pluginName);
            }}
          />
        )}
      </If>
      <If when={serversItem()}>
        {(item) => (
          <ServersDialog
            item={item()}
            phone={phone()}
            onClose={() => servers.set(undefined)}
          />
        )}
      </If>
    </View>
  );
}
