import type {
  AcpAgentView,
  AcpMachineList,
  AcpTestResult,
  AgentView,
  BoardTaskDetail,
  BoardTaskView,
  ConversationSummary,
  EmailAccountView,
  EtaModelConfig,
  LlmAccounts,
  MachineInstallView,
  MachineResults,
  MachineView,
  McpServerView,
  ProviderCheck,
  ProviderCheckResult,
  ProviderRefreshResult,
  ProviderSummary,
  ProvidersView,
  TaskBoardSettings,
} from "@eta/client-contracts";
import type { AppearanceProps } from "./appearance";
import type { IconName } from "./icons";
import type { Message } from "./locale";
import type { SourceChoice } from "./models";
import type { Layout } from "./ui";
import {
  DEFAULT_TASK_ARCHIVE_DAYS,
  modelSource,
  TASK_ARCHIVE_DAYS,
} from "@eta/client-contracts";
import {
  Clipboard,
  Image,
  Overlay,
  Scroll,
  signal,
  View,
  windowSize,
} from "nsh";
import { Switch } from "nsh/base";
import qrCode from "qrcode-generator";
import { Appearance } from "./appearance";
import { AgentEditor } from "./dialogs";
import { follow, relativeTime, useHost } from "./host";
import { formatLocale, uiText, useText } from "./locale";
import { MailboxEditor } from "./mailbox-editor";
import { McpSettings } from "./mcp-settings";
import { GatewayAccounts, ModelSources } from "./models";
import {
  ActionItem,
  ActionMenu,
  Button,
  Caption,
  colors,
  Empty,
  Field,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
} from "./ui";
import { UpdateSettings } from "./update-settings";

const sections = [
  ["Agents", "context", "agents"],
  ["Model services", "plugins", "modelServices"],
  ["Machines", "panel", "machines"],
  ["MCP servers", "plugins", "mcpServers"],
  ["External agents", "context", "externalAgents"],
  ["Email", "email", "email"],
  ["Archived", "archive", "archived"],
  ["Appearance", "settings", "appearance"],
  ["Update", "arrowUp", "update"],
] as const satisfies readonly (readonly [string, IconName, Message])[];
export type SettingsSection = (typeof sections)[number][0];

const acpStatus = {
  available: "externalAgentAvailable",
  unauthenticated: "externalAgentUnauthenticated",
  missing: "externalAgentMissing",
  error: "needsAttention",
} as const satisfies Record<
  AcpAgentView["status"],
  Parameters<typeof uiText>[0]
>;

export function Settings(
  props: AppearanceProps & {
    initial: SettingsSection;
    layout: Layout;
    onConnect: () => void;
    onTask: (id: string) => void;
    onClose: () => void;
  },
) {
  const host = useHost();
  const c = colors();
  const text = useText();
  const sectionTitle = (name: SettingsSection) =>
    text(sections.find(([key]) => key === name)![2]);
  const section = signal<SettingsSection | undefined>(
    props.layout === "phone" && props.initial === "Agents"
      ? undefined
      : props.initial,
  );
  const agent = signal<string | undefined>(undefined);
  const sourceChoice = signal<SourceChoice | undefined>(undefined);
  const provider = signal<ProviderSummary | "new" | undefined>(undefined);
  const sources = signal(false);
  const acpAgent = signal<{ machineId: string; id: string } | undefined>(
    undefined,
  );
  const mailbox = signal<EmailAccountView | "new" | undefined>(undefined);
  const phone = () => props.layout === "phone";
  const showingProvider = () =>
    section() === "Model services" && provider() && provider() !== "new";
  const providers = () => host.section<ProvidersView>("providers", "config");
  const machines = () => host.list<MachineView>("machines");
  const email = () => host.list<EmailAccountView>("email", "accounts");
  const acp = () =>
    host.section<Record<string, AcpMachineList>>("acp", "machines") ?? {};
  const externalAgents = () =>
    Object.entries(acp()).flatMap(([machineId, value]) =>
      (value.agents ?? []).map((agent) => ({ machineId, agent })),
    );
  const selectedAcp = () => {
    const selected = acpAgent();
    return externalAgents().find(
      (item) =>
        item.machineId === selected?.machineId && item.agent.id === selected.id,
    );
  };
  follow(() => "machines");
  follow(() => "mcp");
  follow(() => "acp");
  follow(() => "email");
  const summary = (
    name: SettingsSection,
  ): { text: string; tone?: "amber" | "red" } => {
    switch (name) {
      case "Agents":
        return { text: String(host.people().length) };
      case "Model services": {
        const sources = providers()?.providers ?? [];
        const count = sources.filter((source) => !source.models.length).length;
        return count
          ? {
              text: uiText("settingsNeedsAttentionCount", { count }),
              tone: "amber",
            }
          : { text: String(sources.length) };
      }
      case "Machines":
        return {
          text: uiText("machinesOnlineCount", {
            count: machines().filter((item) => item.status === "online").length,
          }),
        };
      case "MCP servers": {
        const servers = host.list<McpServerView>("mcp");
        const needsLogin = new Set(
          servers
            .filter((item) => item.auth === "needs_login")
            .map((item) => item.server),
        ).size;
        return needsLogin
          ? {
              text: uiText("settingsNeedsSignInCount", { count: needsLogin }),
              tone: "amber",
            }
          : { text: String(new Set(servers.map((item) => item.server)).size) };
      }
      case "External agents":
        return { text: String(externalAgents().length) };
      case "Email": {
        const errors = email().filter((item) => item.status === "error").length;
        return errors
          ? {
              text: uiText("mailboxConnectionErrors", {
                count: errors,
                suffix: errors === 1 || formatLocale() === "zh-CN" ? "" : "s",
              }),
              tone: "red",
            }
          : { text: String(email().length) };
      }
      case "Archived":
        return {
          text: String(
            host.conversations().filter((item) => item.archived).length +
              host.list<BoardTaskView>("tasks", "archived").length,
          ),
        };
      case "Appearance":
        return {
          text: text(props.theme),
        };
      case "Update": {
        const check = host.upgradeCheck();
        return {
          text: check
            ? check.available
              ? `${check.latest ?? check.version} available`
              : check.version
            : "",
        };
      }
    }
  };
  const info = (text: string) => <Empty title={text} />;
  const content = () => (
    <>
      <View style={{ ...row, ...grow, alignItems: "stretch" }}>
        <If when={!phone() || !section()}>
          <Scroll
            style={
              phone()
                ? grow
                : {
                    width: 158,
                    flexShrink: 0,
                    borderRightWidth: 1,
                    borderColor: c().border,
                  }
            }
            scrollbar={false}
          >
            <View style={{ padding: phone() ? 0 : 6 }}>
              <Each of={sections}>
                {(item) => (
                  <View
                    role="button"
                    accessibilityLabel={text(item()[2])}
                    onPress={() => {
                      mailbox.set(undefined);
                      section.set(item()[0]);
                    }}
                    hoverStyle={{ backgroundColor: c().selected }}
                    style={{
                      ...row,
                      height: phone() ? 48 : 32,
                      paddingHorizontal: phone() ? 16 : 10,
                      gap: 10,
                      borderBottomWidth: phone() ? 1 : 0,
                      borderColor: c().border,
                      backgroundColor:
                        section() === item()[0] ? c().selected : c().canvas,
                      cursor: "pointer",
                    }}
                  >
                    <Icon name={item()[1]} />
                    <Label>{text(item()[2])}</Label>
                    <If when={phone()}>
                      <View style={{ flex: 1 }} />
                      <If when={summary(item()[0]).tone}>
                        <View
                          style={{
                            width: 5,
                            height: 5,
                            backgroundColor: c()[summary(item()[0]).tone!],
                          }}
                        />
                      </If>
                      <Label
                        size={11}
                        tone={summary(item()[0]).tone ?? "muted"}
                      >
                        {summary(item()[0]).text}
                      </Label>
                      <Icon name="right" tone="faint" size={10} />
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </Scroll>
        </If>
        <If when={section()}>
          {(current) => (
            <View style={grow}>
              <If
                when={
                  phone() &&
                  (current() === "Appearance" || current() === "Update")
                }
              >
                <Header
                  title={text("settings")}
                  layout={props.layout}
                  onBack={() => section.set(undefined)}
                  inset={current() === "Update" ? 16 : 8}
                />
              </If>
              <If
                when={
                  current() !== "Update" &&
                  current() !== "Machines" &&
                  current() !== "MCP servers" &&
                  !(current() === "Email" && mailbox()) &&
                  (!phone() || !showingProvider())
                }
              >
                <Header
                  title={sectionTitle(current())}
                  layout={
                    phone() && current() === "Appearance"
                      ? "desktop"
                      : props.layout
                  }
                  inset={current() === "Appearance" ? 16 : undefined}
                  onBack={
                    phone() && current() !== "Appearance"
                      ? () => section.set(undefined)
                      : undefined
                  }
                >
                  <If when={current() === "Agents"}>
                    <Button
                      label={uiText("new")}
                      icon="plus"
                      onPress={() => agent.set("new")}
                    />
                  </If>
                  <If when={current() === "Model services"}>
                    <Button
                      label={uiText("addSource")}
                      icon="plus"
                      onPress={() => sources.set(true)}
                    />
                  </If>
                  <If when={current() === "Email"}>
                    <Button
                      label={uiText("connectMailbox")}
                      icon="plus"
                      onPress={() => mailbox.set("new")}
                    />
                  </If>
                </Header>
              </If>
              <If when={current() === "Agents"}>
                <If
                  when={host.people().length}
                  else={info(uiText("settingsNoAgents"))}
                >
                  <Scroll style={grow} scrollbar={false}>
                    <Each of={host.people()} key={(item) => item.id}>
                      {(item) => (
                        <AgentSetting
                          agent={item()}
                          onPress={() => agent.set(item().id)}
                        />
                      )}
                    </Each>
                  </Scroll>
                </If>
              </If>
              <If when={current() === "Model services"}>
                <If
                  when={provider() && provider() !== "new"}
                  else={
                    <If
                      when={
                        providers()?.providers.length ||
                        host.section<LlmAccounts>("llm", "accounts")
                          ?.connections.length
                      }
                      else={info(uiText("settingsNoModelServices"))}
                    >
                      <Scroll style={grow} scrollbar={false}>
                        <GatewayAccounts />
                        <Each
                          of={providers()?.providers ?? []}
                          key={(item) => item.id}
                        >
                          {(item) => (
                            <SettingRow
                              icon="plugins"
                              title={item().name ?? item().id}
                              detail={uiText("models", {
                                length: item().models.length,
                                baseUrl: item().baseUrl,
                              })}
                              onPress={() => provider.set(item())}
                            />
                          )}
                        </Each>
                      </Scroll>
                    </If>
                  }
                >
                  <ProviderDetail
                    id={(provider() as ProviderSummary).id}
                    phone={phone()}
                    onClose={() => provider.set(undefined)}
                  />
                </If>
              </If>
              <If when={current() === "Machines"}>
                <Machines
                  machines={machines()}
                  layout={props.layout}
                  onTask={props.onTask}
                  onBack={() => section.set(undefined)}
                />
              </If>
              <If when={current() === "MCP servers"}>
                <McpSettings
                  layout={props.layout}
                  onBack={() => section.set(undefined)}
                />
              </If>
              <If when={current() === "External agents"}>
                <If
                  when={externalAgents().length}
                  else={info(uiText("settingsNoExternalAgents"))}
                >
                  <Scroll style={grow} scrollbar={false}>
                    <Each
                      of={externalAgents()}
                      key={(item) => `${item.machineId}:${item.agent.id}`}
                    >
                      {(item) => (
                        <SettingRow
                          icon="context"
                          title={item().agent.label}
                          detail={`${item().agent.command} · ${uiText(acpStatus[item().agent.status])}`}
                          onPress={() =>
                            acpAgent.set({
                              machineId: item().machineId,
                              id: item().agent.id,
                            })
                          }
                        />
                      )}
                    </Each>
                  </Scroll>
                </If>
              </If>
              <If when={current() === "Email"}>
                <If
                  when={mailbox()}
                  else={
                    <If
                      when={email().length}
                      else={info("No mailbox connected")}
                    >
                      <Scroll style={grow} scrollbar={false}>
                        <Each of={email()} key={(item) => item.id}>
                          {(item) => (
                            <SettingRow
                              icon="email"
                              title={item().name}
                              detail={`${item().address} · ${item().status}`}
                              onPress={() => mailbox.set(item())}
                            />
                          )}
                        </Each>
                      </Scroll>
                    </If>
                  }
                >
                  {(value) => (
                    <MailboxEditor
                      item={
                        value() === "new"
                          ? undefined
                          : (value() as EmailAccountView)
                      }
                      layout={props.layout}
                      onClose={() => mailbox.set(undefined)}
                    />
                  )}
                </If>
              </If>
              <If when={current() === "Archived"}>
                <ArchiveSettings />
              </If>
              <If when={current() === "Appearance"}>
                <Appearance
                  phone={phone()}
                  theme={props.theme}
                  onTheme={props.onTheme}
                  chatWidth={props.chatWidth}
                  onChatWidth={props.onChatWidth}
                  chatRail={props.chatRail}
                  onChatRail={props.onChatRail}
                  onFonts={props.onFonts}
                />
              </If>
              <If when={current() === "Update"}>
                <UpdateSettings
                  onConnect={props.onConnect}
                  layout={props.layout}
                />
              </If>
            </View>
          )}
        </If>
      </View>
      <If when={agent()}>
        {(value) => (
          <AgentEditor
            id={value() === "new" ? undefined : value()}
            phone={phone()}
            tablet={props.layout === "tablet"}
            onClose={() => agent.set(undefined)}
            onModelServices={() => {
              agent.set(undefined);
              section.set("Model services");
            }}
          />
        )}
      </If>
      <If when={sources()}>
        <ModelSources
          phone={phone()}
          onCustom={(source) => {
            sourceChoice.set(source);
            provider.set("new");
          }}
          onClose={() => sources.set(false)}
        />
      </If>
      <If when={provider() === "new"}>
        <ProviderEditor
          source={sourceChoice()}
          revision={providers()?.revision ?? ""}
          phone={phone()}
          onClose={() => provider.set(undefined)}
        />
      </If>
      <If when={selectedAcp()}>
        {(item) => (
          <ExternalAgentDetail
            agent={item().agent}
            machineId={item().machineId}
            machine={machines().find(
              (machine) => machine.id === item().machineId,
            )}
            phone={phone()}
            onClose={() => acpAgent.set(undefined)}
          />
        )}
      </If>
    </>
  );
  return (
    <If
      when={props.layout !== "tablet"}
      else={
        <View style={{ ...grow, backgroundColor: c().canvas }}>
          <Header
            title={text("settings")}
            layout="tablet"
            onBack={props.onClose}
            inset={12}
          />
          {content()}
        </View>
      }
    >
      <Modal
        title={text("settings")}
        phone={phone()}
        phonePage={phone()}
        hideHeader={phone() && section() !== undefined}
        width={770}
        height={phone() ? "100%" : 578}
        onClose={props.onClose}
      >
        {content()}
      </Modal>
    </If>
  );
}

function ExternalAgentDetail(props: {
  agent: AcpAgentView;
  machineId: string;
  machine?: MachineView;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const testing = signal(false);
  const removing = signal(false);
  const confirm = signal(false);
  const result = signal<AcpTestResult | undefined>(undefined);
  const status = () => result()?.status ?? props.agent.status;
  const machineName = () =>
    props.machine
      ? `${props.machine.name}${props.machine.kind === "primary" ? " (primary)" : ""}`
      : "Host";
  async function test() {
    if (testing()) return;
    testing.set(true);
    const { id, label, command, args, env } = props.agent;
    const answer = await host.action(() =>
      host.call<AcpTestResult>("acp", "test", {
        machineId: props.machineId,
        agent: { id, label, command, args, env },
      }),
    );
    if (answer) result.set(answer);
    testing.set(false);
  }
  async function remove() {
    if (removing()) return;
    removing.set(true);
    const answer = await host.action(() =>
      host.call("acp", "delete", {
        machineId: props.machineId,
        id: props.agent.id,
      }),
    );
    removing.set(false);
    if (answer) props.onClose();
  }
  return (
    <Modal
      title={props.agent.label}
      phone={props.phone}
      phonePage={props.phone}
      height={props.phone ? "100%" : undefined}
      onClose={props.onClose}
    >
      <View style={{ ...grow, minHeight: props.phone ? undefined : 240 }}>
        <View
          style={{
            ...row,
            minHeight: 44,
            paddingHorizontal: 16,
            borderBottomWidth: 1,
            borderColor: c().border,
            gap: 6,
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              backgroundColor: status() === "available" ? c().green : c().amber,
            }}
          />
          <Label size={12}>{uiText(acpStatus[status()])}</Label>
        </View>
        <Each
          of={[
            ["Runtime", props.agent.runtime],
            ["Machine", machineName()],
            ["Command", [props.agent.command, ...props.agent.args].join(" ")],
          ]}
        >
          {(item) => (
            <View
              style={{
                ...row,
                paddingHorizontal: 16,
                minHeight: 44,
                borderBottomWidth: 1,
                borderColor: c().border,
                gap: 8,
              }}
            >
              <Label style={{ width: 82, flexShrink: 0 }}>{item()[0]}</Label>
              <Label
                size={12}
                tone="muted"
                lines={2}
                style={{ flex: 1, minWidth: 0, textAlign: "right" }}
              >
                {item()[1]}
              </Label>
            </View>
          )}
        </Each>
        <If
          when={
            result()?.detail ||
            props.agent.detail ||
            status() === "unauthenticated"
          }
        >
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label
              size={12}
              tone={status() === "available" ? "muted" : "amber"}
            >
              {result()?.detail ??
                props.agent.detail ??
                uiText("signInToOnThenChoose", {
                  label: props.agent.label,
                  machineName: machineName(),
                })}
            </Label>
          </View>
        </If>
        <If when={host.can("acp.delete")}>
          <View
            style={{
              ...row,
              minHeight: 44,
              paddingHorizontal: 16,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label style={{ flex: 1 }}>{uiText("removeAgent")}</Label>
            <Button
              label={uiText("remove2")}
              icon="archive"
              disabled={testing()}
              onPress={() => confirm.set(true)}
            />
          </View>
        </If>
        <View style={{ flex: 1 }} />
        <If when={host.can("acp.test")}>
          <View
            style={{ padding: 16, borderTopWidth: 1, borderColor: c().border }}
          >
            <Button
              label={testing() ? uiText("testing") : uiText("test")}
              tone="primary"
              size={36}
              disabled={testing()}
              style={{ width: "100%", justifyContent: "center" }}
              onPress={() => void test()}
            />
          </View>
        </If>
      </View>
      <If when={confirm()}>
        <Modal
          title={uiText("removeExternalAgent")}
          phone={props.phone}
          onClose={() => confirm.set(false)}
        >
          <View style={{ padding: 16, gap: 10 }}>
            <Label>
              {uiText("removeFromWithCount", {
                label: props.agent.label,
                machineName: machineName(),
              })}
            </Label>
            <Button
              label={removing() ? uiText("removing") : uiText("remove2")}
              tone="danger"
              disabled={removing()}
              onPress={() => void remove()}
            />
          </View>
        </Modal>
      </If>
    </Modal>
  );
}

function SettingRow(props: {
  icon: IconName;
  title: string;
  detail?: string;
  onPress?: () => void;
}) {
  const c = colors();
  return (
    <View
      role={props.onPress ? "button" : undefined}
      onPress={props.onPress}
      hoverStyle={props.onPress ? { backgroundColor: c().selected } : undefined}
      style={{
        ...row,
        minHeight: 55,
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 7,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Icon name={props.icon} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label weight={500}>{props.title}</Label>
        <Label size={12} tone="muted" lines={2}>
          {props.detail}
        </Label>
      </View>
      <If when={props.onPress}>
        <Icon name="right" size={10} tone="muted" />
      </If>
    </View>
  );
}

function AgentSetting(props: { agent: AgentView; onPress: () => void }) {
  const c = colors();
  return (
    <View
      role="button"
      onPress={() => props.onPress()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        minHeight: 55,
        gap: 10,
        alignItems: "flex-start",
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: c().strong,
        }}
      >
        <Label size={12} weight={600}>
          {props.agent.name.slice(0, 1).toUpperCase()}
        </Label>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label weight={500}>{props.agent.name}</Label>
        <Label size={12} tone="muted" lines={1}>
          {props.agent.model ?? props.agent.runtime}
        </Label>
      </View>
      <View style={{ ...row, width: 104, gap: 6 }}>
        <View
          style={{
            width: 6,
            height: 6,
            backgroundColor:
              props.agent.status === "working" ? c().blue : c().faint,
          }}
        />
        <Label size={12} tone="muted">
          {props.agent.status === "idle"
            ? uiText("idle")
            : props.agent.status === "working"
              ? uiText("working2")
              : uiText("waitingForInput")}
        </Label>
      </View>
      <Icon name="more" size={12} tone="faint" />
    </View>
  );
}

function ProviderDetail(props: {
  id: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const config = () => host.section<ProvidersView>("providers", "config");
  const provider = () =>
    config()?.providers.find((item) => item.id === props.id);
  const catalog = signal<EtaModelConfig[]>(provider()?.models ?? []);
  const query = signal("");
  const busy = signal("");
  const check = signal<ProviderCheck | undefined>(undefined);
  const section = signal<"Models" | "Connection">("Models");
  const connection = signal(false);
  const removing = signal(false);
  const candidates = () => {
    const found = new Map(catalog().map((model) => [model.id, model]));
    for (const model of provider()?.models ?? []) found.set(model.id, model);
    const term = query().trim().toLowerCase();
    return [...found.values()].filter((model) =>
      `${model.name ?? ""} ${model.id}`.toLowerCase().includes(term),
    );
  };
  const configured = (id: string) =>
    provider()?.models.some((model) => model.id === id) ?? false;
  async function refresh() {
    if (busy()) return;
    busy.set("refresh");
    const result = await host.action(() =>
      host.call<ProviderRefreshResult>("providers", "refresh", {
        id: props.id,
      }),
    );
    if (result) catalog.set(result.models);
    busy.set("");
  }
  async function test() {
    if (busy()) return;
    busy.set("check");
    const result = await host.action(() =>
      host.call<ProviderCheckResult>("providers", "check", { id: props.id }),
    );
    if (result) check.set(result.checks[props.id]);
    busy.set("");
  }
  async function toggle(model: EtaModelConfig, enabled: boolean) {
    const current = provider();
    const state = config();
    if (busy() || !current || !state) return;
    if (enabled === configured(model.id)) return;
    busy.set("toggle");
    await host.action(() =>
      host.call("providers", "save", {
        revision: state.revision,
        provider: {
          id: current.id,
          name: current.name,
          baseUrl: current.baseUrl,
          kind: current.kind,
          headers: current.headers,
          models: enabled
            ? [...current.models, model]
            : current.models.filter((entry) => entry.id !== model.id),
        },
      }),
    );
    busy.set("");
  }
  async function remove() {
    const state = config();
    if (!state || busy()) return;
    busy.set("remove");
    const result = await host.action(() =>
      host.call("providers", "delete", {
        revision: state.revision,
        id: props.id,
      }),
    );
    busy.set("");
    if (result) props.onClose();
  }
  return (
    <View style={grow}>
      <Header
        title={provider()?.name ?? props.id}
        layout={props.phone ? "phone" : "desktop"}
        onBack={props.onClose}
        subtitle={
          check()
            ? check()?.state === "ok"
              ? uiText("working2")
              : uiText("needsAttention")
            : undefined
        }
        subtitleTone={check()?.state === "ok" ? "green" : "amber"}
      />
      <View style={{ ...row, borderBottomWidth: 1, borderColor: c().border }}>
        <Each of={["Models", "Connection"] as const}>
          {(tab) => (
            <Button
              label={uiText(tab() === "Models" ? "modelsTab" : "connectionTab")}
              size={40}
              tone="ghost"
              selected={section() === tab()}
              style={{
                flex: 1,
                borderBottomWidth: section() === tab() ? 2 : 0,
              }}
              onPress={() => section.set(tab())}
            />
          )}
        </Each>
      </View>
      <If
        when={section() === "Models"}
        else={
          <View style={{ padding: 16, gap: 8 }}>
            <Caption text={uiText("sourceConnection")} />
            <Label size={13}>{provider()?.baseUrl}</Label>
            <Label size={12} tone="muted">
              {provider()?.hasApiKey
                ? uiText("apiKeySavedOnTheHost")
                : uiText("noApiKeySaved")}
            </Label>
            <Button
              label={uiText("editConnection")}
              onPress={() => connection.set(true)}
            />
            <Button
              label={uiText("removeThisSource")}
              tone="danger"
              onPress={() => removing.set(true)}
            />
          </View>
        }
      >
        <View
          style={{
            ...row,
            gap: 8,
            paddingHorizontal: 16,
            minHeight: 44,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label weight={600}>{uiText("models2")}</Label>
          <Label size={12} tone="muted" style={{ flex: 1 }}>
            {provider()?.models.length ?? 0}
          </Label>
          <Button
            label={busy() === "check" ? uiText("checking") : uiText("check")}
            disabled={!!busy()}
            onPress={() => void test()}
          />
          <Button
            label={
              busy() === "refresh"
                ? uiText("refreshing")
                : uiText("refreshList")
            }
            icon="refresh"
            disabled={!!busy()}
            onPress={() => void refresh()}
          />
        </View>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Field
            label={uiText("searchModels")}
            placeholder={uiText("searchModels")}
            value={query()}
            onChange={query.set}
          />
          <If when={check()?.error}>
            <Label tone="red" size={12}>
              {check()?.error}
            </Label>
          </If>
        </View>
        <Scroll style={grow} scrollbar={false}>
          <Each of={candidates()} key={(model) => model.id}>
            {(model) => (
              <View
                style={{
                  ...row,
                  minHeight: 54,
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 7,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label tone={configured(model().id) ? "ink" : "muted"}>
                    {model().name ?? model().id}
                  </Label>
                  <Label size={11} tone={model().delisted ? "amber" : "muted"}>
                    {[
                      model().contextWindow
                        ? `${Math.round(model().contextWindow! / 1000)}K context`
                        : "",
                      model().reasoning ? "Reasoning" : "",
                      model().input?.includes("image") ? "Images" : "",
                      model().delisted
                        ? "Delisted"
                        : model().deprecated
                          ? "Deprecated"
                          : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Label>
                </View>
                <Switch
                  accessibilityLabel={model().name ?? model().id}
                  checked={configured(model().id)}
                  disabled={!!busy()}
                  onChange={({ checked }) => void toggle(model(), checked)}
                  style={{
                    width: 36,
                    height: 20,
                    borderWidth: 1,
                    borderColor: c().strong,
                    backgroundColor: configured(model().id)
                      ? c().button
                      : c().canvas,
                    justifyContent: "center",
                    alignItems: configured(model().id)
                      ? "flex-end"
                      : "flex-start",
                    paddingHorizontal: 2,
                  }}
                >
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      backgroundColor: configured(model().id)
                        ? c().buttonInk
                        : c().strong,
                    }}
                  />
                </Switch>
              </View>
            )}
          </Each>
          <If when={!candidates().length}>
            <Label size={12} tone="muted" style={{ padding: 16 }}>
              {query()
                ? uiText("noMatchingModels")
                : uiText("refreshTheListToFindModels")}
            </Label>
          </If>
        </Scroll>
      </If>
      <If when={connection() && provider()}>
        <ProviderEditor
          item={provider()}
          revision={config()?.revision ?? ""}
          phone={props.phone}
          onClose={() => connection.set(false)}
        />
      </If>
      <If when={removing()}>
        <Modal
          title={uiText("removeThisSource2")}
          phone={props.phone}
          sheet={props.phone}
          onClose={() => removing.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label>{uiText("agentsUsingTheseModelsWillNeed")}</Label>
            <View style={{ ...row, gap: 8, justifyContent: "flex-end" }}>
              <Button
                label={uiText("cancel")}
                disabled={!!busy()}
                onPress={() => removing.set(false)}
              />
              <Button
                label={uiText("removeSource")}
                tone="danger"
                disabled={!!busy()}
                onPress={() => void remove()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </View>
  );
}

export function ProviderEditor(props: {
  item?: ProviderSummary;
  source?: SourceChoice;
  revision: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const item = props.item;
  const kind = () => item?.kind ?? props.source?.kind ?? "openai-compatible";
  const preset = () => modelSource(kind());
  const name = signal(
    item?.name ??
      item?.id ??
      (props.source?.local ? "Local models" : (preset()?.name ?? "")),
  );
  const url = signal(
    item?.baseUrl ??
      preset()?.baseUrl ??
      (props.source?.local ? "http://127.0.0.1:11434/v1" : ""),
  );
  const key = signal("");
  const models = signal(item?.models.map((model) => model.id).join(", ") ?? "");
  const discovered = signal<ProviderSummary["models"]>(item?.models ?? []);
  const busy = signal(false);
  const valid = () =>
    name().trim() &&
    /^https?:\/\//i.test(url().trim()) &&
    models().trim() &&
    (preset()?.auth !== "key" || item?.hasApiKey || key().trim());
  async function discover() {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<{ models: ProviderSummary["models"] }>(
        "providers",
        "discover",
        {
          kind: kind(),
          baseUrl: url().trim(),
          apiKey: key() || undefined,
          id: item?.id,
          revision: props.revision,
        },
      ),
    );
    busy.set(false);
    if (result) {
      discovered.set(result.models);
      models.set(result.models.map((model) => model.id).join(", "));
    }
  }
  async function save() {
    if (!valid() || busy()) return;
    busy.set(true);
    const id =
      item?.id ??
      name()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const values = [
      ...new Set(
        models()
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean),
      ),
    ];
    const result = await host.action(() =>
      host.call("providers", "save", {
        revision: props.revision,
        provider: {
          id,
          name: name().trim(),
          kind: kind(),
          baseUrl: url().trim(),
          apiKey: key() || undefined,
          models: values.map(
            (id) =>
              discovered().find((model) => model.id === id) ?? {
                id,
                name: id,
                contextWindow: 128000,
              },
          ),
        },
      }),
    );
    busy.set(false);
    if (result) props.onClose();
  }
  return (
    <Modal
      title={item ? (item.name ?? item.id) : uiText("addModelSource")}
      phone={props.phone}
      width={520}
      onClose={props.onClose}
    >
      <View style={{ padding: 16, gap: 8 }}>
        <Caption text={preset()?.name ?? uiText("openaiCompatibleSource")} />
        <Field
          label={uiText("sourceName")}
          placeholder={uiText("name")}
          value={name()}
          onChange={name.set}
        />
        <Field
          label={uiText("endpoint")}
          placeholder="https://example.com/v1"
          value={url()}
          onChange={url.set}
        />
        <Field
          label="API key"
          placeholder={item?.hasApiKey ? uiText("apiKeySaved") : "API key"}
          value={key()}
          masked
          onChange={key.set}
        />
        <Field
          label={uiText("models2")}
          placeholder={uiText("modelIdsSeparatedByCommas")}
          value={models()}
          onChange={models.set}
        />
        <View style={{ ...row, gap: 8, justifyContent: "flex-end" }}>
          <Button
            label={uiText("discoverModels")}
            disabled={!url().trim() || busy()}
            onPress={() => void discover()}
          />
          <Button
            label={uiText("saveSource")}
            tone="primary"
            disabled={!valid() || busy()}
            onPress={() => void save()}
          />
        </View>
      </View>
    </Modal>
  );
}

function PhonePairing(props: { phone: boolean; onClose: () => void }) {
  const host = useHost();
  const c = colors();
  const qr = signal<{ link: string; url: string; image: string } | undefined>(
    undefined,
  );
  const address = signal("");
  const error = signal("");
  const busy = signal(false);
  const copied = signal(false);
  const wide = () => windowSize().width >= 1380 && !props.phone;

  async function generate(url?: string) {
    busy.set(true);
    error.set("");
    qr.set(undefined);
    copied.set(false);
    try {
      const link = await host.call<{ link: string; url: string }>(
        "machines",
        "phoneLink",
        url ? { url } : {},
      );
      if (
        /^(?:localhost|\[::1\]|127(?:\.\d+){3})$/.test(
          new URL(link.url).hostname,
        )
      ) {
        error.set("Enter a host address that your phone can reach.");
        return;
      }
      const image = qrCode(0, "M");
      image.addData(link.link);
      image.make();
      qr.set({
        ...link,
        image: `data:image/svg+xml;base64,${btoa(image.createSvgTag(4, 16))}`,
      });
    } catch {
      error.set(
        "The code couldn't be generated. Check the host address and retry.",
      );
    } finally {
      busy.set(false);
    }
  }

  void generate();
  const body = () => (
    <View style={{ gap: 12, padding: 14 }}>
      <If when={wide()}>
        <View style={{ ...row, justifyContent: "space-between" }}>
          <Label size={12} line={16} weight={600}>
            {uiText("scanWithYourPhone")}
          </Label>
          <Button
            label={uiText("close")}
            icon="close"
            iconOnly
            tone="ghost"
            size={16}
            onPress={props.onClose}
          />
        </View>
      </If>
      <If when={qr()}>
        <View
          role="button"
          accessibilityLabel={
            copied() ? uiText("connectLinkCopied") : uiText("copyConnectLink")
          }
          tooltip={uiText("copyConnectLink")}
          onPress={() => {
            const link = qr()?.link;
            if (link)
              void host.action(async () => {
                await Clipboard.writeText(link);
                copied.set(true);
              });
          }}
          style={{
            alignSelf: "center",
            backgroundColor: "#ffffff",
            borderWidth: 1,
            borderColor: c().border,
            padding: 10,
            cursor: "pointer",
          }}
        >
          <Image
            src={qr()!.image}
            style={{ width: 140, height: 140 }}
            fadeDuration={0}
            accessibilityLabel={uiText("etaPairingCode")}
          />
        </View>
        <Label size={10} line={16} tone="mutedInk">
          {copied()
            ? uiText("connectLinkCopiedItContainsYour")
            : uiText("inEtaOnYourPhoneTap")}
        </Label>
      </If>
      <If when={!qr()}>
        <Label size={12} line={16} tone={error() ? "red" : "muted"}>
          {error() || uiText("generatingTheCode")}
        </Label>
        <If when={error()}>
          <Field
            label={uiText("phoneHostAddress")}
            value={address()}
            placeholder={uiText("hostAddress")}
            onChange={address.set}
            onSubmit={() => void generate(address().trim())}
          />
          <Button
            label={uiText("generateCode")}
            disabled={busy() || !address().trim()}
            onPress={() => void generate(address().trim())}
          />
        </If>
      </If>
    </View>
  );

  return (
    <If
      when={wide()}
      else={
        <Modal
          title={uiText("scanWithYourPhone")}
          phone={props.phone}
          width={280}
          onClose={props.onClose}
        >
          {body()}
        </Modal>
      }
    >
      <Overlay
        anchor={{
          x: (windowSize().width + 770) / 2 + 25,
          y: Math.max(0, (windowSize().height - 578) / 2),
        }}
        placement="right"
        align="start"
        onCancel={props.onClose}
        onPressOutside={props.onClose}
        style={{ width: 280 }}
      >
        <View
          role="dialog"
          accessibilityLabel={uiText("scanWithYourPhone")}
          style={{
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
          }}
        >
          {body()}
        </View>
      </Overlay>
    </If>
  );
}

function machineStatus(item: MachineView) {
  if (item.status === "pending") return uiText("machinePending");
  if (item.status === "revoked") return uiText("machineRevoked");
  if (item.status === "offline") return uiText("machineOffline");
  if (item.build === "outdated") return uiText("machineNeedsUpdate");
  if (item.build === "updating") return uiText("updating");
  return uiText("machineOnline");
}

function MachineRow(props: {
  item: MachineView;
  phone: boolean;
  open: () => void;
}) {
  const host = useHost();
  const c = colors();
  const renaming = signal(false);
  const name = signal("");
  const saving = signal(false);
  const metadata = () =>
    [
      props.item.kind === "primary" && uiText("machinePrimary"),
      props.item.status === "offline" &&
        props.item.lastSeenAt &&
        uiText("machineLastSeen", {
          time: relativeTime(props.item.lastSeenAt),
        }),
      machineSystem(props.item.os) ?? props.item.platform,
      props.item.home,
      uiText("machineCapacity", { count: props.item.maxActiveRuns }),
    ]
      .filter(Boolean)
      .join(" · ");
  const status = () => (
    <View
      style={{
        ...row,
        height: props.phone ? 16 : 20,
        width: props.phone ? undefined : 100,
        gap: 6,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          backgroundColor:
            props.item.status === "offline"
              ? c().muted
              : props.item.status === "pending" ||
                  props.item.build === "outdated" ||
                  props.item.build === "updating"
                ? c().amber
                : c().green,
        }}
      />
      <Label size={12} line={16} tone="muted">
        {machineStatus(props.item)}
      </Label>
    </View>
  );
  async function rename() {
    if (saving() || !name().trim()) return;
    saving.set(true);
    const result = await host.action(() =>
      host.call("machines", "rename", {
        machineId: props.item.id,
        name: name().trim(),
      }),
    );
    saving.set(false);
    if (result) renaming.set(false);
  }
  return (
    <>
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          paddingHorizontal: 16,
          paddingVertical: 8,
          gap: 10,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <View
          role="button"
          accessibilityLabel={props.item.name}
          onPress={props.open}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            alignItems: "flex-start",
            flex: 1,
            minWidth: 0,
            gap: 10,
            cursor: "pointer",
          }}
        >
          <View
            style={{
              width: props.phone ? 28 : 24,
              height: props.phone ? 28 : 24,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="monitor" size={16} tone="muted" />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label size={14} line={20} weight={500}>
              {props.item.name}
            </Label>
            <If when={props.phone}>{status()}</If>
            <Label size={12} line={16} tone="muted">
              {metadata()}
            </Label>
          </View>
          <If when={!props.phone}>{status()}</If>
        </View>
        <ActionMenu
          label={uiText("machineActions", { name: props.item.name })}
          triggerStyle={{
            minWidth: 24,
            width: 24,
            height: props.phone ? 28 : 24,
            paddingHorizontal: 0,
          }}
        >
          <ActionItem label={uiText("machineDetails")} onSelect={props.open} />
          <If when={host.can("machines.rename")}>
            <ActionItem
              label={uiText("machineRename")}
              onSelect={() => {
                name.set(props.item.name);
                renaming.set(true);
              }}
            />
          </If>
        </ActionMenu>
      </View>
      <If when={renaming()}>
        <Modal
          title={uiText("machineRename")}
          phone={props.phone}
          sheet={props.phone}
          onClose={() => renaming.set(false)}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <Field
              label={uiText("machineName")}
              value={name()}
              onChange={name.set}
            />
            <Button
              label={uiText("save")}
              tone="primary"
              disabled={saving() || !name().trim()}
              onPress={() => void rename()}
            />
          </View>
        </Modal>
      </If>
    </>
  );
}

function Machines(props: {
  machines: MachineView[];
  layout: Layout;
  onTask: (id: string) => void;
  onBack: () => void;
}) {
  const host = useHost();
  const text = useText();
  const adding = signal(false);
  const pairing = signal(false);
  const machineId = signal("");
  const phone = () => props.layout === "phone";
  const visible = () =>
    props.machines.filter((item) => item.status !== "revoked");
  const machine = () => visible().find((item) => item.id === machineId());
  return (
    <>
      <If when={!adding() || phone()}>
        <If when={phone()}>
          <Header
            title={text("settings")}
            layout="phone"
            onBack={props.onBack}
          />
        </If>
        <Header
          title={text("machines")}
          count={visible().length}
          layout={props.layout}
          dialog
          inset={16}
        >
          <If when={host.can("machines.phoneLink")}>
            <Button
              label={uiText("connectPhone")}
              onPress={() => pairing.set(true)}
            />
          </If>
          <If when={host.can("machines.enroll")}>
            <Button
              label={uiText("addMachine")}
              icon="plus"
              onPress={() => adding.set(true)}
            />
          </If>
        </Header>
        <Scroll style={grow} scrollbar={false}>
          <Each of={visible()} key={(item) => item.id}>
            {(item) => (
              <MachineRow
                item={item()}
                phone={phone()}
                open={() => machineId.set(item().id)}
              />
            )}
          </Each>
        </Scroll>
      </If>
      <If when={pairing()}>
        <PhonePairing phone={phone()} onClose={() => pairing.set(false)} />
      </If>
      <If when={adding()}>
        <AddMachine phone={phone()} onClose={() => adding.set(false)} />
      </If>
      <If when={machine()}>
        {(item) => (
          <MachineDetail
            item={item()}
            phone={phone()}
            onTask={props.onTask}
            onClose={() => machineId.set("")}
          />
        )}
      </If>
    </>
  );
}

function AddMachine(props: { phone: boolean; onClose: () => void }) {
  const host = useHost();
  const c = colors();
  const mode = signal<"command" | "ssh">("command");
  const name = signal("");
  const address = signal("");
  const destination = signal("");
  const password = signal("");
  const enrollment = signal<MachineResults["enroll"] | undefined>(undefined);
  const commandOptions = signal(false);
  const installId = signal("");
  const busy = signal(false);
  const copied = signal(false);
  const install = () =>
    host
      .list<MachineInstallView>("machines", "installs")
      .find((item) => item.id === installId());
  const stages = {
    connect: "machineInstallConnecting",
    send: "machineInstallSending",
    register: "machineInstallRegistering",
    service: "machineInstallService",
    done: "machineInstallConnected",
    failed: "machineInstallFailed",
  } as const satisfies Record<
    MachineInstallView["step"],
    Parameters<typeof uiText>[0]
  >;
  const installing = () =>
    Boolean(installId()) && !["done", "failed"].includes(install()?.step ?? "");
  async function create() {
    if (busy() || installing()) return;
    busy.set(true);
    const args = {
      name: name().trim() || undefined,
      url: address().trim() || host.address()?.origin,
    };
    try {
      if (mode() === "command") {
        const result = await host.action(() =>
          host.call<MachineResults["enroll"]>("machines", "enroll", args),
        );
        if (result) {
          enrollment.set(result);
          commandOptions.set(false);
          copied.set(false);
        }
      } else if (destination().trim()) {
        const result = await host.action(() =>
          host.call<MachineResults["install"]>("machines", "install", {
            ...args,
            host: destination().trim(),
            password: password() || undefined,
          }),
        );
        if (result) installId.set(result.installId);
      }
    } finally {
      password.set("");
      busy.set(false);
    }
  }
  const command = () => mode() === "command";
  const warning = () => uiText("agentsRunOnThatMachineWith");
  const title = () => uiText("addMachine");
  const method = () => uiText(command() ? "runACommand" : "installOverSsh");

  function control() {
    return (
      <Button
        label={uiText(command() ? "machineGenerateCommand" : "startSshInstall")}
        tone="primary"
        size={props.phone ? 32 : 24}
        style={{ paddingHorizontal: 12 }}
        disabled={
          busy() || installing() || (!command() && !destination().trim())
        }
        onPress={() => void create()}
      />
    );
  }

  const content = () => (
    <Scroll style={grow} scrollbar={false}>
      <If when={props.phone}>
        <View
          style={{ padding: 16, borderBottomWidth: 1, borderColor: c().border }}
        >
          <Label>{warning()}</Label>
        </View>
      </If>
      <If when={!command() || props.phone || enrollment()}>
        <View style={{ padding: 16, gap: 10 }}>
          <If
            when={command()}
            else={
              <>
                <Field
                  label={uiText("sshDestination")}
                  placeholder={uiText("userHostOrSshAlias")}
                  value={destination()}
                  onChange={destination.set}
                />
                <Field
                  label={uiText("sshPassword")}
                  placeholder={uiText("optionalWhenSshUsesAPassword")}
                  value={password()}
                  onChange={password.set}
                  masked
                />
              </>
            }
          >
            <Label>{uiText("runTheCommandInThatMachines")}</Label>
          </If>
          <If
            when={
              !command() || (props.phone && !enrollment()) || commandOptions()
            }
          >
            <Field
              label={uiText("machineName")}
              placeholder={uiText("nameOptional")}
              value={name()}
              onChange={name.set}
            />
            <Field
              label={uiText("hostAddress")}
              placeholder={host.address()?.origin ?? ""}
              value={address()}
              onChange={address.set}
            />
          </If>
          <If when={command() ? enrollment() : undefined}>
            {(item) => (
              <>
                <View
                  style={{
                    gap: 8,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <Label size={12} line={19}>
                    {item().command}
                  </Label>
                  <Button
                    label={uiText(copied() ? "copied" : "copyInstallCommand")}
                    size={props.phone ? 32 : 24}
                    onPress={() =>
                      void host.action(async () => {
                        await Clipboard.writeText(item().command);
                        copied.set(true);
                      })
                    }
                  />
                </View>
                <Label size={12} tone="muted">
                  {uiText("thisOneTimeCommandIsValid", {
                    toLocaleString: new Date(item().expiresAt).toLocaleString(
                      formatLocale(),
                    ),
                  })}
                </Label>
                <Label size={12} tone="muted">
                  {uiText("machineWaitingForCommand")}
                </Label>
                <If when={!props.phone}>
                  <Button
                    label={uiText("machineCommandOptions")}
                    selected={commandOptions()}
                    end={commandOptions() ? "down" : "right"}
                    style={{ alignSelf: "flex-start" }}
                    onPress={() => commandOptions.set(!commandOptions())}
                  />
                </If>
              </>
            )}
          </If>
          <If when={!command() && installId()}>
            <Label tone={install()?.step === "failed" ? "red" : "muted"}>
              {uiText(stages[install()?.step ?? "connect"])}
            </Label>
            <If when={install()?.error}>
              <Label size={12} tone="red">
                {install()?.error}
              </Label>
            </If>
          </If>
        </View>
      </If>
    </Scroll>
  );

  const footer = () => (
    <If when={!command() || !enrollment() || commandOptions()}>
      <View
        style={{
          ...(props.phone ? {} : { ...row, justifyContent: "flex-end" }),
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        {control()}
      </View>
    </If>
  );

  return (
    <If
      when={props.phone}
      else={
        <View style={grow}>
          <View
            style={{
              borderBottomWidth: 1,
              borderColor: c().border,
              paddingHorizontal: 16,
              paddingVertical: 8,
              gap: 4,
            }}
          >
            <View style={{ ...row, gap: 10, height: 22 }}>
              <Button
                label={uiText("machineBack")}
                icon="back"
                tone="ghost"
                iconOnly
                size={16}
                style={{ paddingHorizontal: 0 }}
                onPress={props.onClose}
              />
              <Label size={14} line={20} weight={600}>
                {title()}
              </Label>
            </View>
            <Label size={12} line={16} tone="muted">
              {warning()}
            </Label>
          </View>
          <View
            style={{
              ...row,
              minHeight: 40,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label style={{ flex: 1 }}>{uiText("machineMethod")}</Label>
            <ActionMenu
              label={uiText("machineMethod")}
              value={method()}
              triggerStyle={{
                width: 160,
                height: 24,
                paddingLeft: 10,
                paddingRight: 8,
              }}
            >
              <ActionItem
                label={uiText("runACommand")}
                checked={command()}
                onSelect={() => mode.set("command")}
              />
              <If when={host.can("machines.install")}>
                <ActionItem
                  label={uiText("installOverSsh")}
                  checked={!command()}
                  onSelect={() => mode.set("ssh")}
                />
              </If>
            </ActionMenu>
          </View>
          {content()}
          {footer()}
        </View>
      }
    >
      <Modal
        title={title()}
        phone
        phonePage
        height="100%"
        onClose={props.onClose}
      >
        <View style={{ ...row, borderBottomWidth: 1, borderColor: c().border }}>
          <Button
            label={uiText("runACommand")}
            size={40}
            tone="ghost"
            selected={command()}
            style={{ flex: 1, borderBottomWidth: command() ? 2 : 0 }}
            onPress={() => mode.set("command")}
          />
          <If when={host.can("machines.install")}>
            <Button
              label={uiText("installOverSsh")}
              size={40}
              tone="ghost"
              selected={!command()}
              style={{ flex: 1, borderBottomWidth: command() ? 0 : 2 }}
              onPress={() => mode.set("ssh")}
            />
          </If>
        </View>
        {content()}
        {footer()}
      </Modal>
    </If>
  );
}

function MachineDetail(props: {
  item: MachineView;
  phone: boolean;
  onTask: (id: string) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const fingerprint = signal("");
  const limit = signal("");
  const editing = signal(false);
  const removing = signal(false);
  const busy = signal(false);
  const pending = () => props.item.status === "pending";
  const candidates = () =>
    host.tasks().filter((item) => item.status === "in_progress");
  const statusTone = () =>
    props.item.status === "online" ? "green" : pending() ? "amber" : "muted";
  const statusLabel = () =>
    props.item.status === "online"
      ? uiText("machineOnline")
      : machineStatus(props.item);
  const active = () =>
    candidates().filter((item) =>
      host
        .section<BoardTaskDetail>(`tasks.${item.id}`, "task")
        ?.runs.some(
          (run) =>
            run.machineId === props.item.id &&
            (run.status === "starting" || run.status === "running"),
        ),
    );
  const rowStyle = () => ({
    ...row,
    minHeight: 44,
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderColor: c().border,
  });
  const upgrade = () =>
    props.item.kind === "daemon" &&
    props.item.install === "service" &&
    props.item.status === "online" &&
    (props.item.build === "outdated" || !!props.item.updateError);
  async function act(action: () => Promise<unknown>, onSuccess?: () => void) {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(action);
    busy.set(false);
    if (result !== undefined) onSuccess?.();
  }
  return (
    <Modal
      title={props.item.name}
      subtitle={statusLabel()}
      subtitleTone={statusTone()}
      phone={props.phone}
      phonePage={props.phone}
      height={props.phone ? "100%" : 490}
      onClose={props.onClose}
    >
      <Scroll style={grow} scrollbar={false}>
        <If
          when={pending()}
          else={
            <>
              <Each
                of={[
                  [
                    uiText("machineSystem"),
                    machineSystem(props.item.os) ?? props.item.platform,
                  ],
                  [uiText("machineFolder"), props.item.home],
                  [
                    uiText("machineBuild"),
                    [
                      props.item.version,
                      props.item.build === "outdated"
                        ? uiText("machineNeedsUpdate")
                        : props.item.build === "updating"
                          ? uiText("updating")
                          : null,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  ],
                ]}
              >
                {(field) => (
                  <If when={field()[1]}>
                    <View style={rowStyle()}>
                      <Label style={{ flexShrink: 0 }}>{field()[0]}</Label>
                      <Label
                        size={12}
                        lines={2}
                        style={{ flex: 1, minWidth: 0, textAlign: "right" }}
                      >
                        {field()[1]}
                      </Label>
                    </View>
                  </If>
                )}
              </Each>
              <View style={rowStyle()}>
                <Label style={{ flex: 1 }}>{uiText("taskRunsAtOnce")}</Label>
                <Button
                  label={`${active().length} / ${props.item.maxActiveRuns}`}
                  tone="ghost"
                  end="right"
                  onPress={() => {
                    limit.set(String(props.item.maxActiveRuns));
                    editing.set(true);
                  }}
                />
              </View>
              <View style={rowStyle()}>
                <Label weight={600}>{uiText("runningOnThisMachine")}</Label>
                <Label size={12} tone="muted">
                  {active().length}
                </Label>
              </View>
              <Each of={active()} key={(item) => item.id}>
                {(item) => (
                  <SettingRow
                    icon="tasks"
                    title={item().title}
                    detail={uiText("workingWithCount", {
                      number: item().number,
                    })}
                    onPress={() => props.onTask(item().id)}
                  />
                )}
              </Each>
            </>
          }
        >
          <View
            style={{
              padding: 16,
              gap: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label>
              {uiText("wantsToConnectPasteTheFingerprint", {
                name: props.item.name,
              })}
            </Label>
            <Field
              label={uiText("machineFingerprint")}
              placeholder={uiText("pasteTheFingerprintFromTheTerminal")}
              value={fingerprint()}
              onChange={fingerprint.set}
            />
            <Label size={12} tone="muted">
              {uiText("agentsRunOnThatMachineWith")}
            </Label>
          </View>
        </If>
        <Each of={pending() ? [] : candidates()} key={(item) => item.id}>
          {(item) => <MachineTaskSubscription id={item().id} />}
        </Each>
        <If
          when={
            props.item.kind !== "primary" && props.item.status !== "revoked"
          }
        >
          <View style={rowStyle()}>
            <Label style={{ flex: 1 }}>{uiText("removeMachine")}</Label>
            <Button
              label={uiText("remove2")}
              onPress={() => removing.set(true)}
            />
          </View>
        </If>
        <If when={props.item.updateError}>
          <Label tone="red" size={12} style={{ padding: 16 }}>
            {props.item.updateError}
          </Label>
        </If>
      </Scroll>
      <If when={pending() || upgrade()}>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <If
            when={pending()}
            else={
              <Button
                label={uiText("updateMachine")}
                tone="primary"
                disabled={busy()}
                onPress={() =>
                  void act(() =>
                    host.call("machines", "upgrade", {
                      machineId: props.item.id,
                    }),
                  )
                }
              />
            }
          >
            <Button
              label={uiText("approve")}
              tone="primary"
              disabled={busy() || !fingerprint().trim()}
              onPress={() =>
                void act(
                  () =>
                    host.call("machines", "approve", {
                      machineId: props.item.id,
                      fingerprint: fingerprint().trim(),
                    }),
                  () => fingerprint.set(""),
                )
              }
            />
          </If>
        </View>
      </If>
      <If when={editing()}>
        <Modal
          title={uiText("taskRunsAtOnce")}
          phone={props.phone}
          sheet={props.phone}
          onClose={() => editing.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label size={12} tone="muted">
              {uiText("chooseHowManyTaskRunsCan")}
            </Label>
            <Field
              label={uiText("maximumTaskRuns")}
              value={limit()}
              onChange={limit.set}
            />
            <Button
              label={uiText("saveLimit")}
              tone="primary"
              disabled={busy() || !/^(?:[1-9]|1\d|20)$/.test(limit().trim())}
              onPress={() =>
                void act(
                  () =>
                    host.call("machines", "setMaxActiveRuns", {
                      machineId: props.item.id,
                      maxActiveRuns: Number(limit().trim()),
                    }),
                  () => editing.set(false),
                )
              }
            />
          </View>
        </Modal>
      </If>
      <If when={removing()}>
        <Modal
          title={uiText("removeMachine2")}
          phone={props.phone}
          sheet={props.phone}
          onClose={() => removing.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label>
              {uiText("willNoLongerBeAbleTo", { name: props.item.name })}
            </Label>
            <Button
              label={uiText("removeMachine")}
              tone="danger"
              disabled={busy()}
              onPress={() =>
                void act(
                  () =>
                    host.call("machines", "revoke", {
                      machineId: props.item.id,
                    }),
                  props.onClose,
                )
              }
            />
          </View>
        </Modal>
      </If>
    </Modal>
  );
}

function machineSystem(os: string | null) {
  if (os === "darwin") return "macOS";
  if (os === "linux") return "Linux";
  if (os === "win32" || os === "windows") return "Windows";
  return os;
}

function MachineTaskSubscription(props: { id: string }) {
  follow(() => `tasks.${props.id}`);
  return null;
}

function ArchiveSettings() {
  const host = useHost();
  const c = colors();
  const saving = signal(false);
  const days = () => {
    const stored = host.section<TaskBoardSettings>("tasks", "settings");
    return stored ? stored.archiveAfterDays : DEFAULT_TASK_ARCHIVE_DAYS;
  };
  const dayLabel = (value: number | null) =>
    value === null ? "Never" : `${value} days`;
  async function setDays(value: TaskBoardSettings["archiveAfterDays"]) {
    if (saving() || value === days()) return;
    saving.set(true);
    await host.action(() =>
      host.call("tasks", "setSettings", { archiveAfterDays: value }),
    );
    saving.set(false);
  }
  const conversations = () =>
    host.conversations().filter((item) => item.archived);
  const tasks = () => host.list<BoardTaskView>("tasks", "archived");
  return (
    <View style={grow}>
      <If when={host.can("tasks.setSettings")}>
        <View
          style={{
            padding: 16,
            gap: 7,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label weight={600}>{uiText("autoArchive")}</Label>
          <View style={{ ...row, gap: 8 }}>
            <Label size={12} tone="muted" style={{ flex: 1 }}>
              {uiText("archiveFinishedTasksAfterTheyAre")}
            </Label>
            <ActionMenu
              label={uiText("autoArchiveQuietPeriod")}
              value={saving() ? "Saving…" : dayLabel(days())}
            >
              <Each of={[...TASK_ARCHIVE_DAYS, null]}>
                {(choice) => (
                  <ActionItem
                    label={dayLabel(choice())}
                    checked={choice() === days()}
                    onSelect={() => void setDays(choice())}
                  />
                )}
              </Each>
            </ActionMenu>
          </View>
        </View>
      </If>
      <If
        when={conversations().length + tasks().length}
        else={<Empty title={uiText("nothingArchived")} />}
      >
        <Scroll style={grow}>
          <View style={{ padding: 12, gap: 8 }}>
            <If when={conversations().length}>
              <Caption
                text={uiText("archivedGroups", {
                  length: conversations().length,
                })}
              />
            </If>
            <Each
              of={conversations()}
              key={(item: ConversationSummary) => item.id}
            >
              {(item) => (
                <View style={{ ...row, gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Label>{item().name}</Label>
                    <Label size={11} tone="muted">
                      {host
                        .projects()
                        .find((project) => project.id === item().projectId)
                        ?.display ?? ""}
                    </Label>
                  </View>
                  <Button
                    label={uiText("restore")}
                    onPress={() =>
                      void host.action(() =>
                        host.call("conversations", "update", {
                          conversationId: item().id,
                          archived: false,
                        }),
                      )
                    }
                  />
                </View>
              )}
            </Each>
            <If when={tasks().length}>
              <Caption
                text={uiText("archivedTasks", { length: tasks().length })}
              />
            </If>
            <Each of={tasks()} key={(item) => item.id}>
              {(item) => (
                <View style={{ ...row, gap: 8 }}>
                  <Label style={{ flex: 1 }}>
                    {`#${item().number} ${item().title}`}
                  </Label>
                  <Button
                    label={uiText("restore")}
                    onPress={() =>
                      void host.action(() =>
                        host.call("tasks", "unarchive", { taskId: item().id }),
                      )
                    }
                  />
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </If>
    </View>
  );
}
