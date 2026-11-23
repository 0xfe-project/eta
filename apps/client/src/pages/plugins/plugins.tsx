import type { PluginResults, PluginView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { signal, View } from "nsh";
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
  SmoothScroll,
} from "../../components";
import { avatar, control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { AddPlugin, ConfigurePlugin, sheetEdge } from "./configure";
import { pluginText } from "./labels";
import { PluginDetail } from "./plugin-detail";
import { NoPlugins, PluginGlyph, Status } from "./plugin-status";
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

  const hoveredTab = signal("");
  function tabs(tablet = false) {
    const items = ["Plugins", "Skills"];
    const label = (item: string) =>
      uiText(item === "Plugins" ? "plugins" : "skillsTab");
    return (
      <View
        style={{
          ...row,
          paddingHorizontal: tablet
            ? space[16]
            : phone()
              ? space[16]
              : space[24],
          height: tablet ? space[40] : undefined,
          paddingTop: tablet ? 0 : phone() ? space[12] : space[16],
          paddingBottom: tablet ? 0 : phone() ? space[4] : space[8],
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
            height: control.md,
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
                // An inactive tab only darkens its label on hover, with no fill.
                onMouseEnter={() => hoveredTab.set(item())}
                onMouseLeave={() => hoveredTab.set("")}
                style={{
                  flex: tablet || phone() ? 1 : undefined,
                  alignItems: "center",
                  justifyContent: "center",
                  paddingHorizontal: space[12],
                  backgroundColor: tab() === item() ? c().button : undefined,
                  cursor: "pointer",
                }}
              >
                <Label
                  variant="small"
                  tone={
                    tab() === item()
                      ? "buttonInk"
                      : hoveredTab() === item()
                        ? "ink"
                        : "muted"
                  }
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
    <SmoothScroll style={grow} scrollbar={false}>
      <View
        style={{
          paddingHorizontal: space[24],
          paddingTop: space[8],
          paddingBottom: space[16],
          gap: space[16],
        }}
      >
        <Label variant="small" tone="muted" style={{ maxWidth: 1000 }}>
          {uiText("pluginsGiveAgentsSkillsAndMcp")}
        </Label>
        <If when={!list().length}>
          <NoPlugins width={300} />
        </If>
        <View
          style={{
            ...row,
            flexWrap: "wrap",
            alignItems: "flex-start",
            gap: space[12],
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
    </SmoothScroll>
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
                  >
                    {/* Touch-sized outline buttons, 8pt apart. */}
                    <View style={{ ...row, gap: space[8] }}>
                      <Button
                        label={uiText("refreshPlugins")}
                        icon="refresh"
                        iconOnly
                        iconSize={icon.md}
                        size={control.lg}
                        onPress={() => void refreshPlugins()}
                      />
                      <Button
                        label={uiText("addFromGit")}
                        icon="plus"
                        iconSize={icon.md}
                        size={control.lg}
                        style={{ gap: space[4], paddingHorizontal: space[12] }}
                        onPress={() => add.set(true)}
                      />
                    </View>
                  </Header>
                </If>
                <If when={!phone() && tab() === "Plugins"}>
                  <Header
                    title={uiText("plugins")}
                    layout={props.layout}
                    inset={10}
                  >
                    <View style={{ flex: 1 }} />
                    <View style={{ ...row, gap: space[12] }}>
                      <Button
                        label={uiText("refreshPlugins")}
                        icon="refresh"
                        iconOnly
                        iconSize={icon.md}
                        size={16}
                        style={{ paddingHorizontal: 0 }}
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
                    <SmoothScroll style={grow} scrollbar={false}>
                      <Label
                        variant="small"
                        tone="muted"
                        style={{
                          paddingHorizontal: space[16],
                          paddingVertical: space[12],
                        }}
                      >
                        {uiText("pluginsIntroPhone")}
                      </Label>
                      <If when={!list().length}>
                        <NoPlugins width={240} />
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
                    </SmoothScroll>
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
          title={uiText("removePluginTitle", { name: remove() })}
          phone={phone()}
          sheet={phone()}
          plainSheetHeader={phone()}
          panelStyle={phone() ? sheetEdge : undefined}
          compact={!phone()}
          titleWeight={weight.regular}
          width={480}
          overPhoneNavigation={phone()}
          onClose={() => remove.set("")}
        >
          {/* Phone: a bottom sheet with 14/20 copy and two 44pt buttons
              sharing the row. */}
          <View
            style={
              phone()
                ? { paddingHorizontal: space[16], paddingBottom: space[24] }
                : undefined
            }
          >
            <Label
              variant="small"
              tone="muted"
              style={phone() ? undefined : { paddingTop: space[8] }}
            >
              {uiText("removePluginDescription")}
            </Label>
            <View
              style={{
                ...row,
                justifyContent: "flex-end",
                gap: space[8],
                paddingTop: space[20],
              }}
            >
              <Button
                label={uiText("cancel")}
                size={phone() ? control.touch : control.md}
                style={phone() ? { flex: 1 } : undefined}
                onPress={() => remove.set("")}
              />
              <Button
                label={uiText("remove2")}
                tone="primary"
                size={phone() ? control.touch : control.md}
                labelWeight={phone() ? weight.regular : undefined}
                style={phone() ? { flex: 1 } : undefined}
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
        padding: space[12],
        backgroundColor: c().canvas,
        borderWidth: 1,
        borderColor: c().border,
        gap: space[8],
      }}
    >
      <View style={{ ...row, alignItems: "flex-start", gap: space[12] }}>
        <View
          style={{
            width: 36,
            height: 36,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c().selected,
          }}
        >
          <Icon name="plugins" size={icon.lg} tone="muted" />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
          <Label weight={weight.regular} lines={1}>
            {props.item.name}
          </Label>
          <View style={{ ...row, height: space[20], gap: space[8] }}>
            <If when={props.item.version}>
              <Label variant="small" tone="muted">
                {props.item.version ?? ""}
              </Label>
            </If>
            <Status item={props.item} />
          </View>
        </View>
      </View>
      <Label variant="small" tone="muted" lines={2} style={{ height: 36 }}>
        {props.item.description}
      </Label>
      <View style={{ gap: space[4] }}>
        <View style={{ ...row, height: control.md, gap: space[4] }}>
          <If
            when={git()}
            else={
              <Label variant="small" tone="muted">
                {uiText("localDirectory")}
              </Label>
            }
          >
            {(source) => (
              <>
                <Label
                  variant="small"
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
        <View style={{ ...row, height: space[24], gap: space[4] }}>
          <Label variant="small" tone="muted">
            {uiText("skillsMcpServers", {
              length: props.item.skills.length,
              value2: props.item.servers.length,
            })}
          </Label>
          <If when={pluginWarnings(props.item).length}>
            <Button
              label={uiText("warningsFor", { name: props.item.name })}
              icon="warning"
              iconOnly
              iconSize={icon.md}
              tone="ghost"
              labelTone={
                props.item.problem || props.item.state === "needs_config"
                  ? "red"
                  : undefined
              }
              onPress={props.onWarnings}
            />
          </If>
        </View>
      </View>
      <View
        style={{
          ...row,
          height: 36,
          borderTopWidth: 1,
          borderColor: c().border,
          paddingTop: space[8],
          gap: space[4],
          justifyContent: "flex-end",
        }}
      >
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
      <View style={{ padding: space[16] }}>
        <Label variant="small" tone="muted" style={{ userSelect: "text" }}>
          {source()}
        </Label>
      </View>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          paddingHorizontal: space[16],
          paddingVertical: space[12],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={pluginText("ok")}
          tone="primary"
          size={control.md}
          style={{ paddingHorizontal: space[16] }}
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
          paddingHorizontal: space[16],
          paddingTop: props.first ? space[8] : space[16],
          paddingBottom: space[8],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Caption text={props.caption} />
      </View>
      <View>
        <Each of={props.items} key={(item) => item.name}>
          {(item) => (
            <View
              role="button"
              accessibilityLabel={item().name}
              onPress={() => props.onSelect(item().name)}
              activeStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                height: item().state === "needs_config" ? 63 : 60,
                gap: space[12],
                paddingLeft: space[16],
                paddingRight: space[12],
                borderBottomWidth: 1,
                borderColor: c().border,
                backgroundColor: c().canvas,
              }}
            >
              <PluginGlyph size={avatar.lg} />
              <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                <Label lines={1}>{item().name}</Label>
                <Label variant="caption" tone="muted" lines={1}>
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
              <View style={{ width: space[16], alignItems: "center" }}>
                <Icon name="right" size={icon.md} />
              </View>
            </View>
          )}
        </Each>
      </View>
    </>
  );
}
