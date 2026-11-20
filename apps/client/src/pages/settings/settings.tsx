import type {
  EmailAccountView,
  LlmAccounts,
  ProviderSummary,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { AppearanceProps } from "./appearance";
import type { SourceChoice } from "./models/sources";
import type { SettingsSection } from "./overview";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  colors,
  Empty,
  grow,
  Header,
  Modal,
  row,
} from "../../components";
import { uiText, useText } from "../../i18n";
import { useHost } from "../../services/host";
import { AgentEditor } from "./agents/editor";
import { Appearance } from "./appearance";
import { ArchiveSettings } from "./archive";
import { acpStatus, ExternalAgentDetail } from "./external-agent";
import { Machines } from "./machines/machines";
import { MailboxEditor } from "./mailbox-editor";
import { McpSettings } from "./mcp/server-list";
import { GatewayAccounts } from "./models/gateway-accounts";
import { ProviderDetail } from "./models/provider-detail";
import { ProviderEditor } from "./models/provider-editor";
import { ModelSources } from "./models/sources";
import { SettingsNavigation } from "./navigation";
import { sections, useSettingsOverview } from "./overview";
import { AgentSetting, SettingRow } from "./setting-row";
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
  const { providers, machines, email, externalAgents, summary } =
    useSettingsOverview(() => props.theme);
  const selectedAcp = () => {
    const selected = acpAgent();
    return externalAgents().find(
      (item) =>
        item.machineId === selected?.machineId && item.agent.id === selected.id,
    );
  };
  const info = (text: string) => <Empty title={text} />;
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
