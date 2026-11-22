import type {
  AcpMachineList,
  EmailAccountView,
  ProviderSummary,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { Layout } from "../../components";
import type { AppearanceProps } from "./appearance";
import type { SettingsSection } from "./overview";
import { signal, View } from "nsh";
import {
  ActionItem,
  Button,
  colors,
  Empty,
  grow,
  Header,
  Icon,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { CloseButton } from "../../components/navigation-buttons";
import { uiText, useText } from "../../i18n";
import { useHost } from "../../services/host";
import { AgentEditor } from "./agents/editor";
import { Appearance } from "./appearance";
import { ArchiveSettings } from "./archive";
import { ExternalAgentDetail } from "./external-agent";
import {
  acpMachines,
  acpWritable,
  ExternalAgentForm,
} from "./external-agent-form";
import { ExternalAgentList } from "./external-agent-list";
import { Machines } from "./machines/machines";
import { MailboxEditor, mailboxProvider } from "./mailbox-editor";
import { McpSettings } from "./mcp/server-list";
import { AddSource } from "./models/add-source";
import { ProviderDetail } from "./models/provider-detail";
import { ModelSourceList, useModelSources } from "./models/source-list";
import { SubscriptionDetail } from "./models/subscription-detail";
import { SettingsNavigation } from "./navigation";
import { sections, useSettingsOverview } from "./overview";
import { PluginSettings } from "./plugins";
import { RuntimeList } from "./runtimes/runtime-list";
import { emptyStyle, EntityRow, SectionHeader } from "./section";
import { AgentSetting } from "./setting-row";
import { TaskSettings } from "./tasks";
import { UpdateSettings } from "./updates/update";

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
  const provider = signal<ProviderSummary | undefined>(undefined);
  /** The add-source dialog: open on its first step (`true`) or on a preset's connect step. */
  const sources = signal<boolean | string>(false);
  const connector = signal<string>();
  let returnTo: string | undefined;
  function sourceRef(id: string, node: ViewRef) {
    if (id !== returnTo) return;
    returnTo = undefined;
    queueMicrotask(() => node.focus());
  }
  const acpAgent = signal<{ machineId: string; id: string } | undefined>(
    undefined,
  );
  /** The external-agent form: adding (no `agentId`) or editing that agent on `machineId`. */
  const acpForm = signal<{ machineId: string; agentId?: string } | undefined>(
    undefined,
  );
  const mailbox = signal<EmailAccountView | "new" | undefined>(undefined);
  const phone = () => props.layout === "phone";
  const showingProvider = () =>
    section() === "Model services" && (connector() || provider());
  const { machines, email, externalAgents, runtimes, summary } =
    useSettingsOverview(() => props.theme);
  const selectedAcp = () => {
    const selected = acpAgent();
    return externalAgents().find(
      (item) =>
        item.machineId === selected?.machineId && item.agent.id === selected.id,
    );
  };
  const info = (text: string) => (
    <Empty title={text} descriptionWidth={320} style={emptyStyle} />
  );
  const { count: sourceCount } = useModelSources();
  const acpLists = () =>
    host.section<Record<string, AcpMachineList>>("acp", "machines") ?? {};
  /** Where a new external agent goes unless another is chosen: the first machine that can take one. */
  const acpTarget = () =>
    acpMachines(machines()).find((item) => acpWritable(item, acpLists()));
  const editAcp = (machineId: string, agentId: string) =>
    acpForm.set({ machineId, agentId });
  const offlineMachines = () =>
    machines().filter((item) => item.status === "offline");
  const sectionCount = (name: SettingsSection) =>
    (name === "Agents"
      ? host.people().length
      : name === "Model services"
        ? sourceCount()
        : name === "External agents"
          ? externalAgents().length
          : name === "Email"
            ? email().length
            : undefined) || undefined;
  const sectionHint = (name: SettingsSection) =>
    name === "External agents"
      ? uiText("externalAgentsHint")
      : name === "Runtimes"
        ? uiText("runtimesHint")
        : name === "Email"
          ? uiText("settingsEmailHint")
          : undefined;
  /** Panes that draw their own header instead of the section header. */
  const ownHeader = (name: SettingsSection) =>
    name === "Machines" ||
    name === "MCP servers" ||
    (name === "Email" && !!mailbox()) ||
    !!showingProvider();
  /** The phone and the tablet page draw the section header's row and buttons 28px tall. */
  const tall = () => phone() || props.layout === "tablet";
  const actionSize = () => (tall() ? 28 : undefined);
  const actionStyle = () =>
    tall() ? { paddingHorizontal: 10, gap: 6 } : undefined;
  const actions = (name: SettingsSection) => (
    <>
      <If when={name === "Agents"}>
        <Button
          label={uiText("new")}
          size={actionSize()}
          style={actionStyle()}
          icon="plus"
          onPress={() => agent.set("new")}
        />
      </If>
      <If when={name === "Model services"}>
        <Button
          label={uiText("addSource")}
          size={actionSize()}
          style={actionStyle()}
          icon="plus"
          onPress={() => sources.set(true)}
        />
      </If>
      <If when={name === "External agents" && host.can("acp.save")}>
        <Button
          label={uiText("acpAddAgent")}
          size={actionSize()}
          style={actionStyle()}
          icon="plus"
          disabled={!acpTarget()}
          onPress={() => {
            const target = acpTarget();
            if (target) acpForm.set({ machineId: target.id });
          }}
        />
      </If>
      <If when={name === "Email"}>
        <Button
          label={uiText("connectMailbox")}
          size={actionSize()}
          style={actionStyle()}
          icon="plus"
          onPress={() => mailbox.set("new")}
        />
      </If>
    </>
  );
  const content = () => (
    <>
      <View style={{ ...row, ...grow, alignItems: "stretch" }}>
        <If when={!phone() || !section()}>
          <SettingsNavigation
            current={section()}
            phone={phone()}
            summary={summary}
            onSelect={(next) => {
              mailbox.set(undefined);
              section.set(next);
            }}
          />
        </If>
        <If when={section()}>
          {(current) => (
            <View style={grow}>
              <If when={phone() && !ownHeader(current())}>
                <Header
                  title={text("settings")}
                  layout={props.layout}
                  onBack={() => section.set(undefined)}
                  backIconSize={16}
                />
              </If>
              <If
                when={
                  !ownHeader(current()) &&
                  current() !== "Update" &&
                  current() !== "Archived"
                }
              >
                <SectionHeader
                  title={sectionTitle(current())}
                  count={sectionCount(current())}
                  description={sectionHint(current())}
                  phone={tall()}
                >
                  {actions(current())}
                </SectionHeader>
              </If>
              <If when={current() === "Agents"}>
                <If
                  when={host.people().length}
                  else={info(uiText("settingsNoAgents"))}
                >
                  <SmoothScroll style={grow} scrollbar={false}>
                    <Each of={host.people()} key={(item) => item.id}>
                      {(item) => (
                        <AgentSetting
                          agent={item()}
                          avatar={props.layout === "tablet" ? 28 : undefined}
                          phone={phone()}
                          onPress={() => agent.set(item().id)}
                        />
                      )}
                    </Each>
                  </SmoothScroll>
                </If>
              </If>
              <If when={current() === "Model services"}>
                <If
                  when={showingProvider()}
                  else={
                    <If
                      when={sourceCount()}
                      else={
                        <Empty
                          title={uiText("noModelSources")}
                          description={uiText("noModelSourcesHint")}
                          icon="powerPlug"
                          iconSize={24}
                          descriptionWidth={320}
                          style={emptyStyle}
                        >
                          <Button
                            label={uiText("addEtaTokenPlan")}
                            style={{ marginTop: 8, paddingHorizontal: 10 }}
                            onPress={() => sources.set("eta")}
                          />
                        </Empty>
                      }
                    >
                      <SmoothScroll style={grow} scrollbar={false}>
                        <ModelSourceList
                          phone={phone()}
                          onRef={sourceRef}
                          onProvider={(item) => {
                            returnTo = `source:${item.id}`;
                            provider.set(item);
                          }}
                          onAccount={(id, name) => {
                            returnTo = `account:${id}`;
                            connector.set(name);
                          }}
                        />
                      </SmoothScroll>
                    </If>
                  }
                >
                  <If
                    when={connector()}
                    else={
                      <ProviderDetail
                        id={
                          (provider() as ProviderSummary | undefined)?.id ?? ""
                        }
                        phone={phone()}
                        onClose={() => provider.set(undefined)}
                      />
                    }
                  >
                    <SubscriptionDetail
                      connector={connector()!}
                      phone={phone()}
                      onClose={() => connector.set(undefined)}
                    />
                  </If>
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
              <If when={current() === "Plugins"}>
                <PluginSettings phone={phone()} />
              </If>
              <If when={current() === "External agents"}>
                <If
                  when={externalAgents().length || offlineMachines().length}
                  else={
                    <Empty
                      title={uiText("settingsNoExternalAgents")}
                      description={uiText("settingsNoExternalAgentsHint")}
                      icon="terminal"
                      iconSize={24}
                      descriptionWidth={320}
                      style={emptyStyle}
                    />
                  }
                >
                  <SmoothScroll style={grow} scrollbar={false}>
                    <ExternalAgentList
                      lists={acpLists()}
                      machines={machines()}
                      onAgent={(machineId, item) =>
                        acpAgent.set({ machineId, id: item.id })
                      }
                      onEdit={
                        host.can("acp.save")
                          ? (machineId, item) => editAcp(machineId, item.id)
                          : undefined
                      }
                    />
                  </SmoothScroll>
                </If>
              </If>
              <If when={current() === "Runtimes"}>
                <SmoothScroll style={grow} scrollbar={false}>
                  <RuntimeList
                    listing={runtimes}
                    phone={phone()}
                    onExternalAgent={(machineId, id) =>
                      acpAgent.set({ machineId, id })
                    }
                  />
                </SmoothScroll>
              </If>
              <If when={current() === "Email"}>
                <If
                  when={mailbox()}
                  else={
                    <If
                      when={email().length}
                      else={
                        <Empty
                          icon="email"
                          iconSize={24}
                          title={uiText("emailEmptyTitle")}
                          titleWeight={500}
                          description={uiText("emailEmptyHint")}
                          descriptionWidth={320}
                          style={emptyStyle}
                        />
                      }
                    >
                      <SmoothScroll style={grow} scrollbar={false}>
                        <Each of={email()} key={(item) => item.id}>
                          {(item) => (
                            <EntityRow
                              title={item().name}
                              leading={
                                <Icon name="email" size={16} tone="muted" />
                              }
                              leadingSize={phone() ? 28 : undefined}
                              meta={`${item().address} · ${
                                phone()
                                  ? (mailboxProvider(item()) ??
                                    uiText("mailCustom"))
                                  : item().imapHost
                              }`}
                              laneWidth={112}
                              stacked={phone()}
                              caret={phone()}
                              status={
                                item().status === "ready"
                                  ? {
                                      label: uiText("mailConnected"),
                                      color: c().green,
                                    }
                                  : item().status === "error"
                                    ? {
                                        label: uiText("mailConnectionError"),
                                        color: c().red,
                                      }
                                    : {
                                        label: uiText("mailNotChecked"),
                                        color: c().faint,
                                      }
                              }
                              menuLabel={item().name}
                              menu={
                                <ActionItem
                                  label={uiText("settingsEdit")}
                                  onSelect={() => mailbox.set(item())}
                                />
                              }
                              onPress={() => mailbox.set(item())}
                            />
                          )}
                        </Each>
                      </SmoothScroll>
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
              <If when={current() === "Tasks"}>
                <TaskSettings phone={phone()} />
              </If>
              <If when={current() === "Archived"}>
                <ArchiveSettings phone={phone()} />
              </If>
              <If when={current() === "Appearance"}>
                <Appearance
                  phone={phone()}
                  theme={props.theme}
                  onTheme={props.onTheme}
                  paletteId={props.paletteId}
                  onPalette={props.onPalette}
                  flavor={props.flavor}
                  onFlavor={props.onFlavor}
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
            onRuntimes={() => {
              agent.set(undefined);
              section.set("Runtimes");
            }}
          />
        )}
      </If>
      <If when={sources()}>
        {(adding) => (
          <AddSource
            phone={phone()}
            initialPreset={adding() === true ? undefined : String(adding())}
            onClose={() => sources.set(false)}
          />
        )}
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
            writable={acpWritable(
              machines().find((machine) => machine.id === item().machineId),
              acpLists(),
            )}
            onEdit={
              host.can("acp.save")
                ? () => editAcp(item().machineId, item().agent.id)
                : undefined
            }
            onClose={() => acpAgent.set(undefined)}
          />
        )}
      </If>
      <If when={acpForm()}>
        {(form) => (
          <ExternalAgentForm
            machines={machines()}
            lists={acpLists()}
            machineId={form().machineId}
            agent={
              form().agentId === undefined
                ? undefined
                : acpLists()[form().machineId]?.agents?.find(
                    (agent) => agent.id === form().agentId,
                  )
            }
            phone={phone()}
            onSaved={(machineId, id) => {
              const edited = form().agentId;
              const open = acpAgent();
              // The open detail follows its agent to the id it was saved as.
              if (
                edited !== undefined &&
                open?.machineId === machineId &&
                open.id === edited
              )
                acpAgent.set({ machineId, id });
              acpForm.set(undefined);
            }}
            onClose={() => acpForm.set(undefined)}
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
            background="canvas"
            inset={16}
            leading={
              <Button
                label={text("back")}
                icon="arrowLeft"
                iconOnly
                tone="ghost"
                iconSize={14}
                size={14}
                style={{ paddingHorizontal: 0 }}
                onPress={props.onClose}
              />
            }
          />
          {content()}
        </View>
      }
    >
      <Modal
        title={text("settings")}
        phone={phone()}
        phonePage={phone()}
        hideHeader
        width={770}
        height={phone() ? "100%" : 578}
        modalFocus
        onClose={props.onClose}
      >
        <If
          when={!phone()}
          else={
            <If when={!section()}>
              <Header
                title={text("settings")}
                layout="phone"
                onBack={props.onClose}
                backIconSize={16}
              />
            </If>
          }
        >
          {/* The design's header: title at 11, a bare 16px X ending 11 from the edge. */}
          <Header
            title={text("settings")}
            layout="desktop"
            dialog
            inset={11}
            end={11}
          >
            <View style={grow} />
            <CloseButton
              size={16}
              iconSize={16}
              style={{ paddingHorizontal: 0 }}
              onPress={props.onClose}
            />
          </Header>
        </If>
        {content()}
      </Modal>
    </If>
  );
}
