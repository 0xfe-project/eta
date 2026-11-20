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
import { pluginText } from "./labels";
import { PluginDetail } from "./plugin-detail";
import { Status } from "./plugin-status";
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
  const source = signal("");
  const remove = signal("");
  const list = () => host.list<PluginView>("plugins");
  const plugin = () => list().find((item) => item.name === config());
  const phone = () => props.layout === "phone";
  const tabletPlugins = () => props.layout === "tablet" && tab() === "Plugins";
  const detail = () =>
    list().find((item) => item.name === selected()) ??
    (tabletPlugins() ? list()[0] : undefined);
  const warningPlugin = () => list().find((item) => item.name === warnings());
  const sourcePlugin = () => list().find((item) => item.name === source());
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
    const items = ["Plugins", "Skills"];
    const label = (item: string) =>
      uiText(item === "Plugins" ? "plugins" : "skillsTab");
    return (
      <View
        style={{
          ...row,
          paddingHorizontal: tablet ? 14 : phone() ? 16 : 24,
          height: tablet ? 40 : undefined,
          paddingTop: tablet ? 0 : 16,
          paddingBottom: tablet ? 0 : 8,
          flexShrink: 0,
          borderBottomWidth: tablet ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <View
          style={{
            ...row,
            alignItems: "stretch",
            flex: tablet ? 1 : undefined,
            height: 28,
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
          }}
        >
          <Each of={items}>
            {(item) => (
              <View
                role="button"
                accessibilityLabel={label(item())}
                accessibilityState={{ selected: tab() === item() }}
                onPress={() => tab.set(item())}
                style={{
                  flex: tablet ? 1 : undefined,
                  alignItems: "center",
                  justifyContent: "center",
                  paddingHorizontal: 12,
                  backgroundColor: tab() === item() ? c().button : undefined,
                  cursor: "pointer",
                }}
              >
                <Label
                  size={12}
                  line={16}
                  tone={tab() === item() ? "buttonInk" : "muted"}
                >
                  {label(item())}
                </Label>
              </View>
            )}
          </Each>
        </View>
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
                    <View style={{ ...row, gap: 12 }}>
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
                    </View>
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
                        paddingTop: 8,
                        paddingBottom: 16,
                        gap: 16,
                      }}
                    >
                      <Label
                        size={12}
                        line={20}
                        tone="muted"
                        style={{ maxWidth: 1000 }}
                      >
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
                          alignItems: "flex-start",
                          gap: 12,
                        }}
                      >
                        <Each of={list()} key={(item) => item.name}>
                          {(item) => (
                            <PluginCard
                              item={item()}
                              layout={props.layout}
                              onSelect={() => selected.set(item().name)}
                              onWarnings={() => warnings.set(item().name)}
                              onSource={() => source.set(item().name)}
                              onUpdate={() => void update(item().name)}
                              onRemove={() => remove.set(item().name)}
                              onConfigure={() => config.set(item().name)}
                            />
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
      <If when={sourcePlugin()}>
        {(item) => (
          <PluginSourceDialog item={item()} onClose={() => source.set("")} />
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

function PluginCard(props: {
  item: PluginView;
  layout: Layout;
  onSelect: () => void;
  onWarnings: () => void;
  onSource: () => void;
  onUpdate: () => void;
  onRemove: () => void;
  onConfigure: () => void;
}) {
  const c = colors();
  const phone = () => props.layout === "phone";
  const git = () =>
    props.item.source.kind === "git" ? props.item.source : undefined;
  return (
    <View
      role={phone() ? "button" : undefined}
      accessibilityLabel={phone() ? props.item.name : undefined}
      onPress={phone() ? props.onSelect : undefined}
      activeStyle={{ backgroundColor: c().selected }}
      style={{
        width: phone() ? "100%" : 267,
        minHeight: phone() ? 108 : undefined,
        padding: 12,
        backgroundColor: c().canvas,
        borderWidth: 1,
        borderColor: c().border,
        gap: 8,
      }}
    >
      <View style={{ ...row, alignItems: "flex-start", gap: 12 }}>
        <View
          style={{
            width: 36,
            height: 36,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c().selected,
          }}
        >
          <Icon name="plugins" size={20} tone="muted" />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Label weight={500} line={18} lines={1}>
            {props.item.name}
          </Label>
          <View style={{ ...row, height: 20, gap: 8 }}>
            <If when={props.item.version}>
              <Label size={12} line={16} tone="muted">
                {props.item.version ?? ""}
              </Label>
            </If>
            <Status item={props.item} />
          </View>
        </View>
      </View>
      <Label
        size={12}
        line={18}
        tone="muted"
        lines={2}
        style={{ height: phone() ? undefined : 36 }}
      >
        {props.item.description}
      </Label>
      <View style={{ gap: 4 }}>
        <View style={{ ...row, height: 28, gap: 4 }}>
          <If
            when={git()}
            else={
              <Label size={12} line={16} tone="muted">
                {uiText("localDirectory")}
              </Label>
            }
          >
            {(source) => (
              <>
                <Label
                  size={12}
                  line={16}
                  tone="muted"
                  lines={1}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {`${source().repo} @ ${source().sha.slice(0, 12)}`}
                </Label>
                <If when={!phone()}>
                  <Button
                    label={uiText("sourceFor", { name: props.item.name })}
                    icon="more"
                    iconOnly
                    tone="ghost"
                    onPress={props.onSource}
                  />
                </If>
              </>
            )}
          </If>
        </View>
        <View style={{ ...row, height: 24, gap: 4 }}>
          <Label size={12} line={16} tone="muted">
            {uiText("skillsMcpServers", {
              length: props.item.skills.length,
              value2: props.item.servers.length,
            })}
          </Label>
        </View>
      </View>
      <If when={props.item.problem}>
        <Label size={12} tone="red">
          {props.item.problem}
        </Label>
      </If>
      <If when={!phone()}>
        <View
          style={{
            ...row,
            height: 36,
            borderTopWidth: 1,
            borderColor: c().border,
            paddingTop: 8,
            gap: 4,
            justifyContent: "flex-end",
          }}
        >
          <If when={pluginWarnings(props.item).length}>
            <Button
              label={uiText("warnings")}
              tone="ghost"
              onPress={props.onWarnings}
            />
          </If>
          <If when={props.item.source.kind === "git"}>
            <Button
              label={uiText("update")}
              tone="ghost"
              onPress={props.onUpdate}
            />
            <Button
              label={uiText("remove2")}
              tone="ghost"
              onPress={props.onRemove}
            />
          </If>
          <If when={props.item.fields.length}>
            <Button label={uiText("configure")} onPress={props.onConfigure} />
          </If>
        </View>
      </If>
    </View>
  );
}

function PluginSourceDialog(props: { item: PluginView; onClose: () => void }) {
  const c = colors();
  const source = () =>
    props.item.source.kind === "git"
      ? `${props.item.source.repo} @ ${props.item.source.sha}`
      : props.item.source.path;
  return (
    <Modal
      title={uiText("sourceFor", { name: props.item.name })}
      width={384}
      blurBackdrop={false}
      onClose={props.onClose}
    >
      <View style={{ padding: 16 }}>
        <Label size={12} line={16} tone="muted" style={{ userSelect: "text" }}>
          {source()}
        </Label>
      </View>
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
          label={pluginText("ok")}
          tone="primary"
          size={28}
          style={{ paddingHorizontal: 14 }}
          onPress={props.onClose}
        />
      </View>
    </Modal>
  );
}
