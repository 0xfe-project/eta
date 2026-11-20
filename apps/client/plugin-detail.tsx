import type { PluginAuditView, PluginView } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { Clipboard, Scroll, signal, View } from "nsh";
import { Select } from "nsh/base";
import { relativeTime, useHost } from "./host";
import { formatLocale, uiText } from "./locale";
import { AgentFace } from "./shell";
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
} from "./ui";

const copy = {
  source: ["Source", "来源"],
  runs: ["Runs", "运行"],
  env: ["Environment set", "已设置环境变量"],
  headers: ["Headers set", "已设置标头"],
  audit: ["Reads by agents", "智能体读取记录"],
  deletedAgent: ["Deleted agent", "已删除的智能体"],
  copySource: ["Copy source", "复制来源"],
  sourceCopied: ["Source copied", "已复制来源"],
  updateDetail: ["Pull the latest from the source", "从来源拉取最新版本"],
  removeDetail: ["Asks to confirm first", "先确认是否移除"],
  ok: ["OK", "确定"],
  select: ["Select a plugin", "选择插件"],
} as const;

function text(key: keyof typeof copy) {
  return copy[key][formatLocale().startsWith("zh") ? 1 : 0];
}

export function pluginWarnings(item: PluginView) {
  const zh = formatLocale().startsWith("zh");
  const names = item.agents.map((agent) => agent.name).join(", ");
  return [
    ...new Set([
      ...(item.problem ? [item.problem] : []),
      ...item.fields.flatMap((field) => {
        if (
          field.issue?.code !== "required" &&
          (!field.required || field.set || field.default !== undefined)
        )
          return [];
        return [
          zh
            ? `缺少必填项“${field.title}”。`
            : `Required field "${field.title}" is missing.`,
        ];
      }),
      ...(item.state === "needs_config" && names
        ? [
            zh
              ? `${names} 已启用这个插件。修好配置后才会继续使用。`
              : `${names} enabled this plugin. It is skipped until its configuration is fixed.`,
          ]
        : []),
      ...item.machines.flatMap((machine) =>
        machine.checked && machine.missing.length
          ? [
              zh
                ? `${machine.name} 缺少 ${machine.missing.join(", ")}。`
                : `${machine.name} is missing ${machine.missing.join(", ")}.`,
            ]
          : [],
      ),
      ...item.reports,
      ...item.servers.flatMap((server) =>
        server.problem ? [server.problem] : [],
      ),
    ]),
  ];
}

function WarningsText(props: { item: PluginView }) {
  const warnings = () => pluginWarnings(props.item);
  return (
    <If
      when={warnings().length}
      else={<Label tone="muted">{uiText("noWarnings")}</Label>}
    >
      <Each of={warnings()} key={(warning) => warning}>
        {(warning, index) => (
          <Label size={12} line={18} tone={index() === 0 ? "ink" : "mutedInk"}>
            {warning()}
          </Label>
        )}
      </Each>
    </If>
  );
}

export function PluginWarningsDialog(props: {
  item: PluginView;
  onClose: () => void;
}) {
  const c = colors();
  return (
    <Modal
      title={uiText("warningsFor", { name: props.item.name })}
      width={384}
      blurBackdrop={false}
      overPhoneNavigation
      onClose={props.onClose}
    >
      <Scroll style={{ maxHeight: 300 }} scrollbar={false}>
        <View style={{ padding: 14, gap: 5 }}>
          <WarningsText item={props.item} />
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={text("ok")}
          tone="primary"
          size={28}
          onPress={props.onClose}
        />
      </View>
    </Modal>
  );
}

function PluginWarnings(props: {
  item: PluginView;
  onRefresh: () => Promise<void>;
}) {
  const c = colors();
  const checking = signal(false);
  return (
    <View style={{ borderWidth: 1, borderColor: c().border }}>
      <View
        style={{
          ...row,
          gap: 7,
          minHeight: 31,
          paddingHorizontal: 10,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Icon name="info" size={13} />
        <Label weight={600} size={12}>
          {uiText("warningsFor", { name: props.item.name })}
        </Label>
      </View>
      <View style={{ padding: 10, gap: 6 }}>
        <WarningsText item={props.item} />
        <Button
          label={checking() ? uiText("checking") : uiText("checkAgain")}
          disabled={checking()}
          icon="refresh"
          style={{ alignSelf: "flex-start" }}
          onPress={() => {
            if (checking()) return;
            checking.set(true);
            void props.onRefresh().finally(() => checking.set(false));
          }}
        />
      </View>
    </View>
  );
}

function PluginGlyph(props: { size: number }) {
  const c = colors();
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c().selected,
        borderWidth: 1,
        borderColor: c().border,
        flexShrink: 0,
      }}
    >
      <Icon
        name="plugins"
        size={Math.round(props.size * 0.52)}
        tone="mutedInk"
      />
    </View>
  );
}

function Status(props: { item: PluginView; phone?: boolean }) {
  const c = colors();
  const missing = () => props.item.state === "needs_config";
  return (
    <Label
      size={10}
      line={16}
      lines={1}
      tone={missing() ? "amber" : "muted"}
      style={{
        alignSelf: props.phone ? "flex-start" : "center",
        paddingHorizontal: missing() ? 5 : 0,
        borderWidth: missing() ? 1 : 0,
        borderColor: c().amber,
      }}
    >
      {missing() ? uiText("needsConfiguring") : uiText("canBeEnabled")}
    </Label>
  );
}

function excerpt(source: PluginView["source"]) {
  if (source.kind === "local")
    return { label: source.path, clipboard: source.path };
  let repository = source.repo;
  try {
    const url = new URL(repository);
    // A formatted source line and its clipboard text need only the repository address.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    repository = url.href;
  } catch {}
  const path = source.path && source.path !== "." ? ` / ${source.path}` : "";
  const rev = source.sha ? source.sha.slice(0, 12) : source.rev;
  const label = repository.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  return {
    label: `${label}${path}${rev ? ` @ ${rev}` : ""}`,
    clipboard: repository,
  };
}

interface DetailProps {
  item: PluginView;
  phone?: boolean;
  onBack?: () => void;
  onConfigure: () => void;
  onUpdate: () => Promise<boolean>;
  onRemove: () => void;
  onRefresh: () => Promise<void>;
}

export function PluginDetail(props: DetailProps) {
  const host = useHost();
  const c = colors();
  const actions = signal(false);
  const updating = signal(false);
  const copied = signal("");
  const git = () => props.item.source.kind === "git";
  const source = () => excerpt(props.item.source);
  const reads = () =>
    host
      .list<PluginAuditView>("plugins", "audit")
      .filter((entry) => entry.plugin === props.item.name)
      .slice()
      .sort((a, b) => b.at - a.at);
  const configure = () => props.item.fields.length > 0;
  const needsConfig = () => props.item.state === "needs_config";
  function update() {
    if (updating()) return;
    updating.set(true);
    void props
      .onUpdate()
      .then((ok) => {
        if (ok) actions.set(false);
      })
      .finally(() => updating.set(false));
  }
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <If
        when={props.phone}
        else={
          <View
            style={{
              ...row,
              height: 40,
              flexShrink: 0,
              gap: 10,
              paddingHorizontal: 14,
              borderBottomWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
            }}
          >
            <View style={{ ...row, flex: 1, minWidth: 0, gap: 8 }}>
              <Label size={14} weight={600} lines={1} style={{ flexShrink: 1 }}>
                {props.item.name}
              </Label>
              <Label size={11} tone="muted" lines={1}>
                {props.item.version ?? ""}
              </Label>
              <Status item={props.item} />
            </View>
            <If when={git()}>
              <Button
                label={updating() ? uiText("updating") : uiText("update")}
                disabled={updating()}
                tone="ghost"
                labelSize={11}
                onPress={update}
              />
              <Button
                label={uiText("remove2")}
                tone="ghost"
                labelSize={11}
                onPress={props.onRemove}
              />
            </If>
            <If when={configure()}>
              <Button
                label={uiText("configure")}
                tone={needsConfig() ? "primary" : "plain"}
                labelSize={11}
                onPress={props.onConfigure}
              />
            </If>
          </View>
        }
      >
        <Header
          title={props.item.name}
          layout="phone"
          onBack={props.onBack}
          inset={16}
        >
          <View style={{ flex: 1 }} />
          <If when={git()}>
            <Button
              label={uiText("pluginActions")}
              icon="more"
              iconOnly
              tone="ghost"
              onPress={() => actions.set(true)}
            />
          </If>
        </Header>
      </If>
      <Scroll style={grow} scrollbar={false}>
        <View
          style={{ padding: props.phone ? 16 : 20, gap: props.phone ? 14 : 16 }}
        >
          <If when={props.phone}>
            <View style={{ ...row, gap: 12 }}>
              <PluginGlyph size={40} />
              <View style={{ gap: 3, flex: 1 }}>
                <View style={{ ...row, gap: 8 }}>
                  <Label
                    size={16}
                    weight={600}
                    lines={1}
                    style={{ flexShrink: 1 }}
                  >
                    {props.item.name}
                  </Label>
                  <Label size={12} tone="muted" lines={1}>
                    {props.item.version ?? ""}
                  </Label>
                </View>
                <Status item={props.item} phone />
              </View>
            </View>
          </If>
          <If when={props.item.description}>
            <Label size={13} line={18} tone="mutedInk">
              {props.item.description}
            </Label>
          </If>
          <If when={props.phone && configure()}>
            <Button
              label={uiText("configure")}
              tone={needsConfig() ? "primary" : "plain"}
              size={40}
              onPress={props.onConfigure}
            />
          </If>
          <If when={pluginWarnings(props.item).length}>
            <PluginWarnings item={props.item} onRefresh={props.onRefresh} />
          </If>
          <View style={{ gap: 4 }}>
            <Caption text={text("source")} />
            <View
              style={{
                ...row,
                gap: 8,
                minHeight: 34,
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Icon name={git() ? "clip" : "folder"} size={13} tone="muted" />
              <Label size={12} line={16} style={{ flex: 1, minWidth: 0 }}>
                {source().label}
              </Label>
              <Button
                label={
                  copied() === source().clipboard
                    ? text("sourceCopied")
                    : text("copySource")
                }
                icon={copied() === source().clipboard ? "check" : "panel"}
                iconOnly
                size={24}
                tone="ghost"
                onPress={() => {
                  const value = source().clipboard;
                  void host.action(async () => {
                    await Clipboard.writeText(value);
                    copied.set(value);
                  });
                }}
              />
            </View>
          </View>
          <View style={{ gap: 4 }}>
            <Caption text={text("runs")} />
            <View style={{ borderWidth: 1, borderColor: c().border }}>
              <Each of={props.item.servers} key={(server) => server.name}>
                {(server) => (
                  <View
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      minHeight: 36,
                      borderBottomWidth: 1,
                      borderColor: c().border,
                      gap: 3,
                    }}
                  >
                    <View style={{ ...row, flexWrap: "wrap", gap: 8 }}>
                      <Icon name="artifact" size={12} tone="muted" />
                      <Label size={12} line={17}>
                        {server().name}
                      </Label>
                      <Label
                        size={10}
                        line={14}
                        tone="muted"
                        style={{
                          paddingHorizontal: 4,
                          borderWidth: 1,
                          borderColor: c().strong,
                        }}
                      >
                        {server().transport}
                      </Label>
                      <View style={{ flex: 1 }} />
                      <If when={server().env.length}>
                        <Label
                          size={10}
                          line={14}
                          tone="muted"
                        >{`${text("env")}: ${server().env.join(", ")}`}</Label>
                      </If>
                      <If when={server().headers.length}>
                        <Label
                          size={10}
                          line={14}
                          tone="muted"
                        >{`${text("headers")}: ${server().headers.join(", ")}`}</Label>
                      </If>
                    </View>
                  </View>
                )}
              </Each>
              <Label
                size={11}
                line={16}
                tone="muted"
                style={{ paddingHorizontal: 10, paddingVertical: 7 }}
              >
                {uiText("skillsMcpServers", {
                  length: props.item.skills.length,
                  value2: props.item.servers.length,
                })}
              </Label>
            </View>
          </View>
          <If when={reads().length}>
            <View style={{ gap: 4 }}>
              <Caption text={text("audit")} />
              <View style={{ borderWidth: 1, borderColor: c().border }}>
                <Each of={reads()} key={(entry) => entry.id}>
                  {(entry, index) => (
                    <View
                      style={{
                        ...row,
                        gap: 8,
                        minHeight: 30,
                        paddingHorizontal: 10,
                        borderTopWidth: index() ? 1 : 0,
                        borderColor: c().border,
                      }}
                    >
                      <AgentFace id={entry().agentId} size={14} />
                      <Label size={12} lines={1} style={{ flex: 1 }}>
                        {`${entry().agentName ?? text("deletedAgent")} · ${entry().field}`}
                      </Label>
                      <Label size={10} tone="muted">
                        {relativeTime(entry().at)}
                      </Label>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </Scroll>
      <If when={props.phone && actions() && git()}>
        <Modal
          title={props.item.name}
          phone
          sheet
          blurBackdrop={false}
          overPhoneNavigation
          onClose={() => actions.set(false)}
        >
          <ActionRow
            label={updating() ? uiText("updating") : uiText("update")}
            hint={text("updateDetail")}
            icon="refresh"
            disabled={updating()}
            onPress={update}
          />
          <ActionRow
            label={uiText("remove2")}
            hint={text("removeDetail")}
            icon="archive"
            disabled={updating()}
            onPress={() => {
              actions.set(false);
              props.onRemove();
            }}
          />
        </Modal>
      </If>
    </View>
  );
}

function ActionRow(props: {
  label: string;
  hint: string;
  icon: "refresh" | "archive";
  disabled: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        gap: 12,
        minHeight: 48,
        borderBottomWidth: 1,
        borderColor: c().border,
        paddingHorizontal: 16,
        cursor: "pointer",
      }}
    >
      <Icon name={props.icon} size={15} />
      <View style={{ flex: 1 }}>
        <Label size={14}>{props.label}</Label>
        <Label size={11} line={14} tone="muted">
          {props.hint}
        </Label>
      </View>
    </View>
  );
}

export function PluginTablet(props: {
  items: PluginView[];
  current?: PluginView;
  tabs: JSX.Element;
  onSelect: (name: string) => void;
  onRefresh: () => Promise<void>;
  onAdd: () => void;
  detail: JSX.Element;
}) {
  const c = colors();
  return (
    <View style={{ ...row, ...grow, alignItems: "stretch" }}>
      <View
        style={{ width: 320, borderRightWidth: 1, borderColor: c().border }}
      >
        <Header
          title={uiText("plugins")}
          count={props.items.length}
          layout="tablet"
          inset={14}
        >
          <View style={{ flex: 1 }} />
          <Button
            label={uiText("refreshPlugins")}
            icon="refresh"
            iconOnly
            onPress={() => void props.onRefresh()}
          />
          <Button
            label={uiText("addFromGit")}
            icon="plus"
            labelSize={11}
            onPress={props.onAdd}
          />
        </Header>
        {props.tabs}
        <Scroll style={grow} scrollbar={false}>
          <Each of={props.items} key={(item) => item.name}>
            {(item) => (
              <View
                role="button"
                accessibilityLabel={item().name}
                accessibilityState={{
                  selected: props.current?.name === item().name,
                }}
                onPress={() => props.onSelect(item().name)}
                hoverStyle={{ backgroundColor: c().selected }}
                focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
                style={{
                  ...row,
                  gap: 10,
                  height: 60,
                  paddingHorizontal: 14,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  backgroundColor:
                    props.current?.name === item().name
                      ? c().selected
                      : c().canvas,
                  cursor: "pointer",
                }}
              >
                <PluginGlyph size={28} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Label size={13} line={18} lines={1}>
                    {item().name}
                  </Label>
                  <Label size={10} line={14} tone="muted" lines={1}>
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
                <Status item={item()} />
              </View>
            )}
          </Each>
          <If when={!props.items.length}>
            <Label size={12} tone="muted" style={{ padding: 14 }}>
              {uiText("noPluginsInstalled")}
            </Label>
          </If>
        </Scroll>
        <View
          style={{
            borderTopWidth: 1,
            borderColor: c().border,
            minHeight: 66,
            paddingHorizontal: 14,
            paddingVertical: 11,
          }}
        >
          <Label size={10} line={14} tone="muted">
            {uiText("pluginsGiveAgentsSkillsAndMcp")}
          </Label>
        </View>
      </View>
      <If
        when={props.current}
        else={
          <Label tone="muted" style={{ padding: 20 }}>
            {text("select")}
          </Label>
        }
      >
        {props.detail}
      </If>
    </View>
  );
}

const pluginConfigCopy = {
  fields: [
    "Fill in the fields this plugin declares. These values go to its MCP servers.",
    "填写插件声明的字段。这些值会提供给插件的 MCP 服务器。",
  ],
  required: ["Required", "必填"],
  optional: ["(optional)", "（选填）"],
  access: ["Agent access", "智能体访问权限"],
  none: ["None (plugin process only)", "无（仅插件进程）"],
  read: ["Read", "读取"],
  file: ["File", "文件"],
  value: ["Value", "值"],
  encrypted: [
    "The configuration is stored encrypted on the Host, and secrets are not shown again.",
    "配置在 Host 上加密保存，密钥不会再次显示。",
  ],
  missing: [
    "Something required is missing; it will still need configuring.",
    "仍有必填项缺失，插件还需要配置。",
  ],
  blank: ["Select a value", "请选择"],
} as const;

export function pluginConfigText(key: keyof typeof pluginConfigCopy) {
  return pluginConfigCopy[key][formatLocale().startsWith("zh") ? 1 : 0];
}

export function PluginSelect(props: {
  label: string;
  items: { value: string; title: string }[];
  value: string | null;
  disabled?: boolean;
  compact?: boolean;
  onChange: (value: string) => void;
}) {
  const c = colors();
  return (
    <Select
      accessibilityLabel={props.label}
      items={props.items}
      value={props.value}
      cover={false}
      offset={2}
      disabled={props.disabled}
      popupStyle={{
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      itemStyle={{
        minHeight: 28,
        paddingHorizontal: 8,
        color: c().ink,
        fontSize: 12,
      }}
      trigger={
        <View
          style={{
            ...row,
            gap: 8,
            minHeight: props.compact ? 24 : 28,
            paddingHorizontal: 8,
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
            cursor: "pointer",
          }}
        >
          <Label size={props.compact ? 11 : 12} lines={1} style={{ flex: 1 }}>
            {props.items.find((item) => item.value === props.value)?.title ??
              pluginConfigText("blank")}
          </Label>
          <Icon name="down" size={9} tone="muted" />
        </View>
      }
      onChange={({ value }) => {
        if (value !== null && value !== props.value) props.onChange(value);
      }}
    />
  );
}
