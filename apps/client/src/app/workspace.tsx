import type {
  AgentResults,
  CaptainResults,
  ProvidersView,
} from "@eta/client-contracts";
import type { Layout } from "../components";
import type { Flavor, PaletteId } from "../components/palettes";
import type { Page } from "../navigation/routes";
import type { ChatWidth, Theme } from "../pages/settings/appearance";
import type { SettingsSection } from "../pages/settings/overview";
import {
  cleanup,
  effect,
  platform,
  signal,
  untracked,
  UrlScheme,
  View,
  windowSize,
} from "nsh";
import { fill, grow, keyboardShown, row, sizes } from "../components";
import { useModels } from "../components/model-select";
import { ChatList } from "../navigation/chat-list";
import { link, workspaceLocation } from "../navigation/location";
import { PhoneNavigation } from "../navigation/phone-tabs";
import { DesktopSidebar } from "../navigation/sidebar";
import { TabletRail } from "../navigation/tablet-rail";
import { Conversation } from "../pages/chat/conversation";
import { ConversationEmpty } from "../pages/chat/conversation-empty";
import { Pending } from "../pages/chat/pending";
import { ReconnectingBanner } from "../pages/connection/reconnecting-banner";
import { Email } from "../pages/email/inbox";
import { More } from "../pages/more";
import { NewConversation } from "../pages/new-conversation";
import { Onboard } from "../pages/onboarding";
import { PhoneHostSetup } from "../pages/onboarding/phone-host-setup";
import { Plugins } from "../pages/plugins/plugins";
import { Routines } from "../pages/routines/routines";
import { AgentEditor } from "../pages/settings/agents/editor";
import { Settings } from "../pages/settings/settings";
import { NewTask } from "../pages/tasks/new-task";
import { TaskDetail } from "../pages/tasks/task-detail";
import { TaskWorkspace } from "../pages/tasks/task-workspace";
import { follow, useHost } from "../services/host";

export function Workspace(props: {
  layout: Layout;
  theme: Theme;
  onTheme: (mode: Theme) => void;
  paletteId: PaletteId;
  onPalette: (id: PaletteId) => void;
  flavor: Flavor;
  onFlavor: (flavor: Flavor) => void;
  chatWidth: ChatWidth;
  onChatWidth: (width: ChatWidth) => void;
  chatRail: boolean;
  onChatRail: (on: boolean) => void;
  onFonts: (fonts: { interface: string; mono: string }) => void;
  onConnect: () => void;
}) {
  const host = useHost();
  const start = workspaceLocation();
  const page = signal<Page>(
    start.page === "settings" || start.page === "onboard" ? "chat" : start.page,
  );
  const conversation = signal(start.conversation);
  const captain = signal("");
  const mobileOpen = signal(Boolean(start.conversation));
  const collapsed = signal(false);
  const desktopRail = () => props.layout === "desktop" && collapsed();
  const narrowChat = () => desktopRail() && props.chatWidth === "standard";
  const settings = signal<SettingsSection | undefined>(
    start.page === "settings"
      ? start.update
        ? "Update"
        : "Agents"
      : undefined,
  );
  const conversationWidth = () =>
    props.chatWidth === "extra-narrow"
      ? 600
      : props.chatWidth === "compact"
        ? 640
        : props.chatWidth === "standard"
          ? narrowChat()
            ? 720
            : 1040
          : undefined;
  const routineId = signal("");
  const task = signal("");
  const taskBackStack: string[] = [];
  function openTask(id: string) {
    taskBackStack.length = 0;
    task.set(id);
  }
  function openRelatedTask(id: string) {
    if (id === task()) return;
    if (task()) taskBackStack.push(task());
    task.set(id);
  }
  function closeTask() {
    task.set(taskBackStack.pop() ?? "");
  }
  const newGroup = signal(false);
  const newAgent = signal(false);
  const newTask = signal(false);
  const setup = signal(start.page === "onboard");
  let checkedSetup = false;
  const models = useModels();
  const phone = () => props.layout === "phone";
  const phoneTabs = () => phone() && !keyboardShown();
  const waitingForHost = () =>
    phone() &&
    start.page === "chat" &&
    host.state().status === "open" &&
    Boolean(host.section("providers", "config")) &&
    Boolean(host.state().targets.agents) &&
    !host.people().length &&
    !host.conversations().some((item) => item.kind === "group");
  follow(() => "agents");
  follow(() => "conversations");
  follow(() => "projects");
  follow(() => "inbox");
  follow(() => "tasks");
  follow(() => "captain");
  follow(() => "providers");
  follow(() => (host.can("llm.refresh") ? "llm" : undefined));
  follow(() => "plugins");
  follow(() => (page() === "more" || page() === "email" ? "email" : undefined));
  if (platform.os === "web")
    cleanup(
      UrlScheme.on("change", () => {
        const next = workspaceLocation();
        page.set(
          next.page === "settings" || next.page === "onboard"
            ? "chat"
            : next.page,
        );
        setup.set(next.page === "onboard");
        settings.set(next.page === "settings" ? "Agents" : undefined);
        conversation.set(next.conversation);
        mobileOpen.set(Boolean(next.conversation));
      }),
    );
  // The groups opened before this one, newest last: archiving the open group goes back to them.
  const previous: string[] = [];
  function open(id: string) {
    openTask("");
    page.set("chat");
    if (conversation() && conversation() !== id) previous.push(conversation());
    conversation.set(id);
    mobileOpen.set(true);
    link("chat", id);
  }
  function back() {
    mobileOpen.set(false);
    link("chat");
  }
  function showSettings(section: SettingsSection = "Agents") {
    settings.set(section);
    link("settings");
  }
  async function direct(agentId: string) {
    const result = await host.action(() =>
      host.call<AgentResults["direct"]>("agents", "direct", { agentId }),
    );
    if (result) open(result.conversation.id);
  }
  let openingCaptain = false;
  async function openCaptain() {
    if (openingCaptain || captain() || !host.can("captain.direct")) return;
    openingCaptain = true;
    const result = await host.action(() =>
      host.call<CaptainResults["direct"]>("captain", "direct", {}),
    );
    openingCaptain = false;
    if (result) captain.set(result.conversationId);
  }
  function navigate(next: Page) {
    openTask("");
    if (next === "settings") {
      showSettings();
      return;
    }
    settings.set(undefined);
    page.set(next);
    mobileOpen.set(false);
    link(next);
  }
  function showRoutine(id?: string) {
    routineId.set(id ?? "");
    navigate("routines");
  }
  const activeId = () => (page() === "captain" ? captain() : conversation());
  function leaveUnavailableChat() {
    const next = host
      .conversations()
      .find(
        (item) =>
          item.kind === "group" &&
          !item.archived &&
          item.id !== activeId() &&
          !host.state().missing[`conversations.${item.id}`],
      );
    if (!phone() && next) {
      open(next.id);
      return;
    }
    conversation.set("");
    navigate(phone() ? "chat" : "tasks");
  }
  /** A group archived from the sidebar: if it was open, the one opened before it, else the empty page. */
  function leaveArchived(id: string) {
    if (conversation() !== id) return;
    const live = (other: string) =>
      host
        .conversations()
        .some(
          (item) =>
            item.id === other && item.kind === "group" && !item.archived,
        );
    let back: string | undefined;
    while (back === undefined && previous.length) {
      const other = previous.pop()!;
      if (other !== id && live(other)) back = other;
    }
    if (back && !phone()) {
      open(back);
      return;
    }
    conversation.set("");
    if (!phone()) link("chat");
  }
  const conversationVisible = () =>
    Boolean(activeId()) && (page() === "captain" || !phone() || mobileOpen());
  effect(() => {
    const providers = host.section<ProvidersView>("providers", "config");
    if (
      !checkedSetup &&
      providers &&
      host.state().targets.agents &&
      host.state().status === "open"
    ) {
      checkedSetup = true;
      if (
        start.page === "chat" &&
        !phone() &&
        !host.people().length &&
        !host.conversations().some((item) => item.kind === "group")
      )
        setup.set(true);
    }
    const all = host.conversations();
    if (!phone() && !conversation()) {
      const first = all.find(
        (item) =>
          item.kind === "group" &&
          !item.archived &&
          !host.state().missing[`conversations.${item.id}`],
      );
      if (first) conversation.set(first.id);
    }
    if (
      host.state().status === "open" &&
      (page() === "captain" ||
        !all.some((item) => item.kind === "group" && !item.archived)) &&
      !captain()
    )
      untracked(() => {
        void openCaptain();
      });
  });
  const workspace = () => (
    <View style={grow}>
      <If
        when={
          host.disconnected() &&
          (!phone() ||
            (!(page() === "captain" && captain()) &&
              !(page() === "chat" && mobileOpen() && conversation())))
        }
      >
        <ReconnectingBanner phone={phone()} onConnect={props.onConnect} />
      </If>
      <View style={{ ...row, ...grow, alignItems: "stretch" }}>
        <If when={props.layout === "desktop"}>
          <DesktopSidebar
            page={desktopRail() && settings() ? "settings" : page()}
            onNavigate={navigate}
            // A group reads as current only while its conversation is open.
            selected={page() === "chat" && !settings() ? conversation() : ""}
            onConversation={open}
            onAgent={(id) => void direct(id)}
            onCreate={() => newGroup.set(true)}
            onCreateAgent={() => newAgent.set(true)}
            onArchived={leaveArchived}
            collapsed={collapsed()}
            onToggle={() => collapsed.set(!collapsed())}
          />
        </If>
        <If when={props.layout === "tablet"}>
          <TabletRail
            page={settings() ? "settings" : page()}
            onNavigate={navigate}
          />
        </If>
        <View
          accessibilityElementsHidden={
            props.layout === "tablet" && !!settings()
          }
          importantForAccessibility={
            props.layout === "tablet" && settings()
              ? "no-hide-descendants"
              : "auto"
          }
          style={{
            ...row,
            ...grow,
            alignItems: "stretch",
            display: props.layout === "tablet" && settings() ? "none" : "flex",
            visibility:
              props.layout === "tablet" && settings() ? "hidden" : "visible",
          }}
        >
          <If
            when={
              (page() === "chat" &&
                (props.layout === "tablet" || (phone() && !mobileOpen()))) ||
              (page() === "captain" && props.layout === "tablet")
            }
          >
            <ChatList
              width={windowSize().width < 960 ? 280 : sizes.tabletList}
              layout={props.layout}
              selected={conversation()}
              onConversation={open}
              onAgent={(id) => void direct(id)}
              onCreate={() => newGroup.set(true)}
              onCreateAgent={() => newAgent.set(true)}
              onArchived={leaveArchived}
            />
          </If>
          <If
            when={
              (page() === "chat" && (!phone() || mobileOpen())) ||
              page() === "captain"
            }
          >
            <If
              when={conversationVisible()}
              else={
                <If
                  when={page() === "chat" && !phone() && captain()}
                  else={
                    <ConversationEmpty
                      captain={page() === "captain"}
                      onCreate={() => newGroup.set(true)}
                    />
                  }
                >
                  <Conversation
                    id={captain()}
                    layout={props.layout}
                    captain
                    onPending={() => navigate("pending")}
                    onTask={openTask}
                    onModelServices={() => showSettings("Model services")}
                    onAccessLost={leaveUnavailableChat}
                    onRelatedTask={openRelatedTask}
                    onRoutines={showRoutine}
                    contentWidth={conversationWidth()}
                    alignComposer={narrowChat()}
                    rail={props.chatRail}
                    taskId={task()}
                    onCloseTask={closeTask}
                  />
                </If>
              }
            >
              <Each of={[activeId()]}>
                {(id) => (
                  <Conversation
                    id={id()}
                    onReadDraft={() => mobileOpen.set(true)}
                    captain={page() === "captain"}
                    layout={props.layout}
                    onPending={() => navigate("pending")}
                    onTask={openTask}
                    onModelServices={() => showSettings("Model services")}
                    onAccessLost={leaveUnavailableChat}
                    onRelatedTask={openRelatedTask}
                    onRoutines={showRoutine}
                    contentWidth={conversationWidth()}
                    alignComposer={narrowChat()}
                    rail={props.chatRail}
                    taskId={task()}
                    onCloseTask={closeTask}
                    onBack={phone() && page() === "chat" ? back : undefined}
                  />
                )}
              </Each>
            </If>
          </If>
          <If when={page() === "tasks"}>
            <TaskWorkspace
              layout={props.layout}
              taskId={task()}
              onOpen={openTask}
              onRelatedTask={openRelatedTask}
              onClose={closeTask}
              onCreate={() => newTask.set(true)}
            />
          </If>
          <If when={page() === "email"}>
            <Email
              layout={props.layout}
              onBack={phone() ? () => navigate("more") : undefined}
              onSettings={() => showSettings("Email")}
              onConversation={open}
            />
          </If>
          <If when={page() === "routines"}>
            <Routines
              onCaptain={() => navigate("captain")}
              initialId={routineId()}
              layout={props.layout}
              onBack={phone() ? () => navigate("pending") : undefined}
            />
          </If>
          <If when={page() === "plugins"}>
            <Plugins
              layout={props.layout}
              onBack={phone() ? () => navigate("more") : undefined}
            />
          </If>
          <If when={page() === "pending"}>
            <Pending
              layout={props.layout}
              onTask={openTask}
              onRoutines={showRoutine}
              onConversation={open}
            />
          </If>
          <If when={page() === "more"}>
            <More
              layout={props.layout}
              onNavigate={navigate}
              onSettings={() => showSettings()}
            />
          </If>
        </View>
      </View>
      {/* The keyboard covers the tab bar, as a native tab bar is: the space
          above it goes to the page and its input. */}
      <If when={phoneTabs()}>
        <PhoneNavigation
          page={settings() ? "settings" : page()}
          onNavigate={navigate}
        />
      </If>
      <If when={setup()}>
        <Onboard
          phone={phone()}
          onClose={() => {
            setup.set(false);
            link("chat");
          }}
        />
      </If>
      <If when={settings()}>
        {(section) => (
          <View
            style={{
              ...fill,
              zIndex: 30,
              left: props.layout === "tablet" ? sizes.rail : 0,
              bottom: phoneTabs() ? sizes.phoneNav : 0,
            }}
          >
            <Settings
              initial={section()}
              layout={props.layout}
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
              onTask={(id) => {
                navigate("tasks");
                openTask(id);
              }}
              onConnect={props.onConnect}
              onClose={() => {
                settings.set(undefined);
                if (phone() && page() === "chat" && !conversation()) {
                  navigate("more");
                } else {
                  link(page(), page() === "chat" ? conversation() : undefined);
                }
              }}
            />
          </View>
        )}
      </If>
      <If when={newGroup()}>
        <NewConversation
          layout={props.layout}
          onOpen={open}
          onClose={() => newGroup.set(false)}
        />
      </If>
      <If when={newAgent()}>
        <AgentEditor
          phone={phone()}
          tablet={props.layout === "tablet"}
          onClose={() => newAgent.set(false)}
          onModelServices={() => {
            newAgent.set(false);
            showSettings("Model services");
          }}
          onRuntimes={() => {
            newAgent.set(false);
            showSettings("Runtimes");
          }}
        />
      </If>
      <If when={newTask()}>
        <NewTask
          phone={phone()}
          conversation={conversation() || undefined}
          onOpen={openTask}
          onClose={() => newTask.set(false)}
        />
      </If>
      <If
        when={task() && page() !== "tasks" && (phone() || page() === "pending")}
      >
        <View style={{ ...fill, zIndex: 10 }}>
          <Each of={[task()]}>
            {(id) => (
              <TaskDetail
                id={id()}
                layout={props.layout}
                onClose={closeTask}
                onTask={openRelatedTask}
              />
            )}
          </Each>
        </View>
      </If>
    </View>
  );
  return (
    <If when={waitingForHost()} else={workspace()}>
      <PhoneHostSetup
        noModel={!models().length}
        hostName={host.address()?.origin}
      />
    </If>
  );
}
