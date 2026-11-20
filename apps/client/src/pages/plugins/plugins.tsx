import type { PluginResults, PluginView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  Caption,
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
import { PluginGlyph, Status } from "./plugin-status";
import { Skills } from "./skills/list";
import { PluginTablet } from "./tablet-list";
import { pluginWarnings, PluginWarningsDialog } from "./warnings";

export function Plugins(props: { layout: Layout; onBack?: () => void }) {
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
  const needsConfig = () =>
    list().filter((item) => item.state === "needs_config");
  const installed = () =>
    list().filter((item) => item.state !== "needs_config");
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
          paddingTop: tablet ? 0 : phone() ? 12 : 16,
          paddingBottom: tablet ? 0 : phone() ? 4 : 8,
          flexShrink: 0,
          borderBottomWidth: tablet ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <View
          style={{
            ...row,
            alignItems: "stretch",
            flex: tablet || phone() ? 1 : undefined,
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
                  flex: tablet || phone() ? 1 : undefined,
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
  const desktopList = () => (
    <Scroll style={grow} scrollbar={false}>
      <View
        style={{
          paddingHorizontal: 24,
          paddingTop: 8,
          paddingBottom: 16,
          gap: 16,
        }}
      >
        <Label size={12} line={20} tone="muted" style={{ maxWidth: 1000 }}>
          {uiText("pluginsGiveAgentsSkillsAndMcp")}
        </Label>
        <If when={!list().length}>
          <Label tone="muted">{uiText("noPluginsInstalled")}</Label>
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
                <If when={phone() && tab() === "Plugins"}>
                  <Header
                    title={uiText("plugins")}
                    layout="phone"
                    onBack={props.onBack}
                  />
                </If>
                <If when={!phone() && tab() === "Plugins"}>
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
                </If>
                <If when={tab() === "Plugins"}>{tabs()}</If>
                <If
                  when={tab() === "Plugins"}
                  else={
                    <Skills
                      layout={props.layout}
                      onBack={props.onBack}
                      tabs={() => tabs(props.layout === "tablet")}
                    />
                  }
                >
                  <If when={phone()} else={desktopList()}>
                    <Scroll style={grow} scrollbar={false}>
                      <Label
                        size={12}
                        line={16}
                        tone="muted"
                        style={{ paddingHorizontal: 16, paddingVertical: 12 }}
                      >
                        {uiText("pluginsIntroPhone")}
                      </Label>
                      <If when={!list().length}>
                        <Label tone="muted" style={{ paddingHorizontal: 16 }}>
                          {uiText("noPluginsInstalled")}
                        </Label>
                      </If>
                      <If when={needsConfig().length}>
                        <PluginRows
                          caption={uiText("pluginsNeedAttention")}
                          items={needsConfig()}
                          first
                          onSelect={selected.set}
                        />
                      </If>
                      <If when={installed().length}>
                        <PluginRows
                          caption={uiText("pluginsInstalledCount", {
                            count: installed().length,
                          })}
                          items={installed()}
                          first={!needsConfig().length}
                          onSelect={selected.set}
                        />
                      </If>
                    </Scroll>
                  </If>
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
  onWarnings: () => void;
  onSource: () => void;
  onUpdate: () => void;
  onRemove: () => void;
  onConfigure: () => void;
}) {
  const c = colors();
  const git = () =>
    props.item.source.kind === "git" ? props.item.source : undefined;
  return (
    <View
      style={{
        width: 267,
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
      <Label size={12} line={18} tone="muted" lines={2} style={{ height: 36 }}>
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
                <Button
                  label={uiText("sourceFor", { name: props.item.name })}
                  icon="more"
                  iconOnly
                  tone="ghost"
                  onPress={props.onSource}
                />
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

function PluginRows(props: {
  caption: string;
  items: PluginView[];
  first?: boolean;
  onSelect: (name: string) => void;
}) {
  const c = colors();
  return (
    <>
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: props.first ? 8 : 16,
          paddingBottom: 6,
        }}
      >
        <Caption text={props.caption} />
      </View>
      <View style={{ borderBottomWidth: 1, borderColor: c().border }}>
        <Each of={props.items} key={(item) => item.name}>
          {(item) => (
            <View
              role="button"
              accessibilityLabel={item().name}
              onPress={() => props.onSelect(item().name)}
              activeStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                height: item().state === "needs_config" ? 64 : 60,
                gap: 12,
                paddingLeft: 16,
                paddingRight: 12,
                borderTopWidth: 1,
                borderColor: c().border,
                backgroundColor: c().canvas,
              }}
            >
              <PluginGlyph size={32} />
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Label size={14} line={20} lines={1}>
                  {item().name}
                </Label>
                <Label size={11} line={14} tone="muted" lines={1}>
                  {[
                    item().version,
                    uiText("skillsMcpServers", {
                      length: item().skills.length,
                      value2: item().servers.length,
                    }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Label>
              </View>
              <If when={item().state === "needs_config"}>
                <Status item={item()} />
              </If>
              <View style={{ width: 16, alignItems: "center" }}>
                <Icon name="right" size={14} />
              </View>
            </View>
          )}
        </Each>
      </View>
    </>
  );
}
