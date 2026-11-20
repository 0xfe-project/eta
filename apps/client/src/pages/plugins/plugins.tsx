import type { PluginResults, PluginView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  colors,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { AddPlugin, ConfigurePlugin } from "./configure";
import { PluginDetail } from "./plugin-detail";
import { Skills } from "./skills/list";
import { PluginTablet } from "./tablet-list";
import { pluginWarnings, PluginWarningsDialog } from "./warnings";

export function Plugins(props: { layout: Layout }) {
  const host = useHost();
  const c = colors();
  const tab = signal("Plugins");
  const add = signal(false);
  const config = signal("");
  const selected = signal("");
  const warnings = signal("");
  const remove = signal("");
  const list = () => host.list<PluginView>("plugins");
  const plugin = () => list().find((item) => item.name === config());
  const phone = () => props.layout === "phone";
  const tabletPlugins = () => props.layout === "tablet" && tab() === "Plugins";
  const detail = () =>
    list().find((item) => item.name === selected()) ??
    (tabletPlugins() ? list()[0] : undefined);
  const warningPlugin = () => list().find((item) => item.name === warnings());
  async function refreshPlugins() {
    await host.action(() => host.call("plugins", "recheck", {}));
  }
  async function update(name: string) {
    return (
      (await host.action(() =>
        host.call<PluginResults["update"]>("plugins", "update", { name }),
      )) !== undefined
    );
  }
  follow(() => "plugins");

  function tabs(tablet = false) {
    return (
      <View
        style={{
          ...row,
          paddingHorizontal: tablet ? 14 : phone() ? 16 : 24,
          paddingTop: tablet ? 6 : 16,
          paddingBottom: tablet ? 5 : 8,
          flexShrink: 0,
          borderBottomWidth: tablet ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <Each of={["Plugins", "Skills"]}>
          {(item) => (
            <Button
              label={uiText(item() === "Plugins" ? "plugins" : "skillsTab")}
              size={28}
              tone={tab() === item() ? "primary" : "plain"}
              style={{ flex: tablet ? 1 : undefined }}
              onPress={() => tab.set(item())}
            />
          )}
        </Each>
      </View>
    );
  }

  const detailView = () => (
    <If when={detail()}>
      {(item) => (
        <PluginDetail
          item={item()}
          phone={phone()}
          onBack={() => selected.set("")}
          onConfigure={() => config.set(item().name)}
          onUpdate={() => update(item().name)}
          onRemove={() => remove.set(item().name)}
          onRefresh={refreshPlugins}
        />
      )}
    </If>
  );
  return (
    <View style={grow}>
      <If
        when={tabletPlugins()}
        else={
          <If
            when={phone() && detail()}
            else={
              <>
                <If when={tab() === "Plugins"}>
                  <Header
                    title={uiText("plugins")}
                    layout={props.layout}
                    inset={10}
                  >
                    <View style={{ flex: 1 }} />
                    <Button
                      label={uiText("refreshPlugins")}
                      icon="refresh"
                      iconOnly
                      tone="ghost"
                      onPress={() => void refreshPlugins()}
                    />
                    <Button
                      label={uiText("addFromGit")}
                      icon="plus"
                      onPress={() => add.set(true)}
                    />
                  </Header>
                  {tabs()}
                </If>
                <If
                  when={tab() === "Plugins"}
                  else={
                    <Skills
                      layout={props.layout}
                      tabs={() => tabs(props.layout === "tablet")}
                    />
                  }
                >
                  <Scroll style={grow} scrollbar={false}>
                    <View
                      style={{
                        paddingHorizontal: phone() ? 16 : 24,
                        paddingBottom: 16,
                        gap: 16,
                      }}
                    >
                      <Label size={12} line={19} tone="muted">
                        {uiText("pluginsGiveAgentsSkillsAndMcp")}
                      </Label>
                      <If when={!list().length}>
                        <Label tone="muted">
                          {uiText("noPluginsInstalled")}
                        </Label>
                      </If>
                      <View
                        style={{
                          ...row,
                          flexWrap: "wrap",
                          alignItems: "stretch",
                          gap: 12,
                        }}
                      >
                        <Each of={list()} key={(item) => item.name}>
                          {(item) => (
                            <View
                              role={phone() ? "button" : undefined}
                              accessibilityLabel={
                                phone() ? item().name : undefined
                              }
                              onPress={
                                phone()
                                  ? () => selected.set(item().name)
                                  : undefined
                              }
                              activeStyle={{ backgroundColor: c().selected }}
                              style={{
                                width: phone()
                                  ? "100%"
                                  : props.layout === "tablet"
                                    ? "31.9%"
                                    : "24.1%",
                                minHeight: phone() ? 108 : 220,
                                padding: 12,
                                backgroundColor: c().canvas,
                                borderWidth: 1,
                                borderColor: c().border,
                                gap: 9,
                              }}
                            >
                              <View style={{ ...row, gap: 12 }}>
                                <View
                                  style={{
                                    width: 36,
                                    height: 36,
                                    alignItems: "center",
                                    justifyContent: "center",
                                    backgroundColor: c().selected,
                                  }}
                                >
                                  <Icon name="plugins" size={19} tone="muted" />
                                </View>
                                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                                  <Label weight={600} lines={1}>
                                    {item().name}
                                  </Label>
                                  <View
                                    style={{ ...row, flexWrap: "wrap", gap: 8 }}
                                  >
                                    <Label size={12} tone="muted">
                                      {item().version ?? ""}
                                    </Label>
                                    <Label
                                      size={10}
                                      tone={
                                        item().state === "ready"
                                          ? "muted"
                                          : "amber"
                                      }
                                    >
                                      {item().state === "ready"
                                        ? uiText("canBeEnabled")
                                        : uiText("needsConfiguring")}
                                    </Label>
                                  </View>
                                </View>
                              </View>
                              <Label size={12} tone="muted" line={18}>
                                {item().description}
                              </Label>
                              <Label size={12} tone="muted" lines={1}>
                                {"repo" in item().source
                                  ? (item().source as { repo: string }).repo
                                  : uiText("localDirectory")}
                              </Label>
                              <Label size={12} tone="muted">
                                {uiText("skillsMcpServers", {
                                  length: item().skills.length,
                                  value2: item().servers.length,
                                })}
                              </Label>
                              <If when={item().problem}>
                                <Label size={12} tone="red">
                                  {item().problem}
                                </Label>
                              </If>
                              <If when={!phone()}>
                                <View style={{ flex: 1 }} />
                                <View
                                  style={{
                                    ...row,
                                    borderTopWidth: 1,
                                    borderColor: c().border,
                                    paddingTop: 10,
                                    gap: 5,
                                    justifyContent: "flex-end",
                                  }}
                                >
                                  <If when={pluginWarnings(item()).length}>
                                    <Button
                                      label={uiText("warnings")}
                                      tone="ghost"
                                      onPress={() => warnings.set(item().name)}
                                    />
                                  </If>
                                  <If when={item().source.kind === "git"}>
                                    <Button
                                      label={uiText("update")}
                                      tone="ghost"
                                      onPress={() => void update(item().name)}
                                    />
                                    <Button
                                      label={uiText("remove2")}
                                      tone="ghost"
                                      onPress={() => remove.set(item().name)}
                                    />
                                  </If>
                                  <If when={item().fields.length}>
                                    <Button
                                      label={uiText("configure")}
                                      onPress={() => config.set(item().name)}
                                    />
                                  </If>
                                </View>
                              </If>
                            </View>
                          )}
                        </Each>
                      </View>
                    </View>
                  </Scroll>
                </If>
              </>
            }
          >
            {detailView()}
          </If>
        }
      >
        <PluginTablet
          items={list()}
          current={detail()}
          tabs={tabs(true)}
          onSelect={selected.set}
          onRefresh={refreshPlugins}
          onAdd={() => add.set(true)}
          detail={detailView()}
        />
      </If>
      <If when={warningPlugin()}>
        {(item) => (
          <PluginWarningsDialog
            item={item()}
            onClose={() => warnings.set("")}
          />
        )}
      </If>
      <If when={add()}>
        <AddPlugin phone={phone()} onClose={() => add.set(false)} />
      </If>
      <If when={plugin()}>
        {(item) => (
          <ConfigurePlugin
            item={item()}
            phone={phone()}
            tablet={props.layout === "tablet"}
            onClose={() => config.set("")}
          />
        )}
      </If>
      <If when={remove()}>
        <Modal
          title={uiText("removePlugin")}
          phone={phone()}
          overPhoneNavigation={phone()}
          onClose={() => remove.set("")}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <Label>{uiText("removeFromThisHost", { remove: remove() })}</Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button label={uiText("cancel")} onPress={() => remove.set("")} />
              <Button
                label={uiText("remove2")}
                tone="danger"
                onPress={() =>
                  void host.action(async () => {
                    const name = remove();
                    await host.call("plugins", "remove", { name });
                    if (selected() === name) selected.set("");
                    remove.set("");
                  })
                }
              />
            </View>
          </View>
        </Modal>
      </If>
    </View>
  );
}
