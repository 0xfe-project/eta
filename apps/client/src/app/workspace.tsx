import type {
  AgentView,
  CaptainResults,
  ProvidersView,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { Layout } from "../components";
import type { MotionFrom } from "../components/motion";
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
import { BackHandler } from "nsh/mobile";
import { colors, fill, grow, keyboardShown, row, sizes } from "../components";
import { useModels } from "../components/model-select";
import { fadeIn, motion, passing, pushed } from "../components/motion";
import { ChatList } from "../navigation/chat-list";
import { link, workspaceLocation } from "../navigation/location";
import { PhoneNavigation } from "../navigation/phone-tabs";
import { DesktopSidebar } from "../navigation/sidebar";
import { TabletRail } from "../navigation/tablet-rail";
import { Conversation } from "../pages/chat/conversation";
import { ConversationEmpty } from "../pages/chat/conversation-empty";
import { Pending } from "../pages/chat/pending";
import { ReconnectingBanner } from "../pages/connection/reconnecting-banner";
import { More } from "../pages/more";
import { NewConversation } from "../pages/new-conversation";
import { Onboard } from "../pages/onboarding";
import { PhoneHostSetup } from "../pages/onboarding/phone-host-setup";
import { Plugins } from "../pages/plugins/plugins";
import { Routines } from "../pages/routines/routines";
import { Settings } from "../pages/settings/settings";
import { NewTask } from "../pages/tasks/new-task";
import { TaskDetail } from "../pages/tasks/task-detail";
import { TaskWorkspace } from "../pages/tasks/task-workspace";
import { openAgentChat } from "../pages/templates/agent-chat";
import { TemplateGallery } from "../pages/templates/gallery";
import { requestedTemplate } from "../pages/templates/link";
import { follow, useHost } from "../services/host";
import { dismissTop, topDismissable } from "../ui/behaviors";
import { backAction } from "./back";

/** The conversation list on a tablet narrower than 960. */
const narrowListWidth = 280;
/** What covers the workspace's own panes: a task opened over a page, Settings over all of it. */
const paneOrder = { task: 10, settings: 30 } as const;

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
  const c = colors();
  const start = workspaceLocation();
  const page = signal<Page>(
    start.page === "settings" || start.page === "onboard" ? "chat" : start.page,
  );
  const conversation = signal(start.conversation);
  const captain = signal("");
  const mobileOpen = signal(Boolean(start.conversation));
  const collapsed = signal(false);
  /** A tablet's group list folded away, so the conversation takes the width. */
  const listFolded = signal(false);
  const listHidden = () => props.layout === "tablet" && listFolded();
  // The button that folds the list and the one that brings it back are two views: the one pressed
  // is gone once the list changes, so the other takes the focus, as the desktop toggle does.
  let focusListToggle = false;
  function toggleList() {
    focusListToggle = true;
    listFolded.set(!listFolded());
  }
  function attachListToggle(node: ViewRef | null) {
    if (!node || !focusListToggle) return;
    focusListToggle = false;
    node.focus();
  }
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
  const phone = () => props.layout === "phone";
  // On a phone a page pushed in (a conversation over the chat list, a task, Settings) comes in
  // over the page it opened from and goes back off it: both are drawn while it moves. A page of
  // More or Routines, which takes the place of the one before, fades in from the trailing edge,
  // and the one before, coming back, from the leading edge. Tab changes and the larger layouts
  // change at once, as before.
  const pane = passing();
  function step(from: MotionFrom) {
    if (phone()) void pane.play(fadeIn(from, motion.pageIn), true);
  }
  const chatPush = pushed();
  const taskPush = pushed();
  const settingsPush = pushed();
  /** The task going back off the page it opened from, drawn while it goes. */
  let leavingTask = "";
  /** A task changed in the layer it opened in: it comes in over the page under it, or another
   * takes its place. On the Tasks page the page itself does the same. */
  const taskLayer = () => phone() && page() !== "tasks";
  const taskBackStack: string[] = [];
  function openTask(id: string) {
    taskBackStack.length = 0;
    const was = task();
    task.set(id);
    if (!id || !taskLayer()) taskPush.settle();
    else if (!was) void taskPush.enter();
    else if (was !== id) taskPush.swap("end");
  }
  function openRelatedTask(id: string) {
    if (id === task()) return;
    if (task()) taskBackStack.push(task());
    task.set(id);
    if (taskLayer()) taskPush.swap("end");
  }
  function closeTask() {
    const was = task();
    const next = taskBackStack.pop() ?? "";
    task.set(next);
    if (!taskLayer()) return;
    if (next) taskPush.swap("start");
    else if (was) {
      leavingTask = was;
      void taskPush.leave();
    }
  }
  /** On a phone, the conversation comes in over the chat list or goes back off it. */
  let leavingChat = "";
  function showConversation(shown: boolean) {
    if (!shown) leavingChat = conversation();
    if (phone() && shown !== mobileOpen())
      void (shown ? chatPush.enter() : chatPush.leave());
    mobileOpen.set(shown);
  }
  const newGroup = signal(false);
  /** The template gallery, open on a template id ("" for none in particular). */
  const templateGallery = signal<string | undefined>(undefined);
  // A template link (`eta://template?id=…`, `?template=…`) opens the gallery on it.
  effect(() => {
    const id = requestedTemplate();
    if (!id) return;
    requestedTemplate.set(undefined);
    // An agent is made in Settings › Agents now: a link gets out of Settings first.
    const section = settings();
    if (section) closeSettings(section);
    templateGallery.set(id);
  });
  const newTask = signal(false);
  const setup = signal(start.page === "onboard");
  let checkedSetup = false;
  const models = useModels();
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
        showConversation(Boolean(next.conversation));
      }),
    );
  // The system back key on Android: what closes next comes from backAction, which reads the
  // layers in the order a user sees them. The web and desktop builds never register it, so their
  // behavior is unchanged.
  if (platform.os === "android")
    cleanup(
      BackHandler.on("press", () => {
        const action = backAction({
          overlay: topDismissable(),
          settings: settings(),
          task: Boolean(task() && taskLayer()),
          phone: phone(),
          page: page(),
          conversation: mobileOpen(),
          onboarding: setup(),
        });
        switch (action.kind) {
          case "dismiss-overlay":
            dismissTop();
            break;
          case "close-settings":
            closeSettings(action.section);
            break;
          case "close-task":
            closeTask();
            break;
          case "back-to-list":
            back();
            break;
          case "leave-onboarding":
            setup.set(false);
            link("chat");
            break;
          case "exit-app":
            BackHandler.exitApp();
            break;
        }
        return true;
      }),
    );
  // The groups opened before this one, newest last: archiving the open group goes back to them.
  const previous: string[] = [];
  function open(id: string) {
    openTask("");
    page.set("chat");
    if (conversation() && conversation() !== id) previous.push(conversation());
    conversation.set(id);
    showConversation(true);
    link("chat", id);
  }
  function back() {
    showConversation(false);
    link("chat");
  }
  /** The section Settings goes back off the page under it with. */
  let leavingSettings: SettingsSection = "Agents";
  function showSettings(section: SettingsSection = "Agents") {
    if (phone() && !settings()) void settingsPush.enter();
    settings.set(section);
    link("settings");
  }
  /** Settings closes the way its own close does, off the page under it. */
  function closeSettings(section: SettingsSection) {
    leavingSettings = section;
    settings.set(undefined);
    if (phone() && page() === "chat" && !conversation()) {
      navigate("more");
    } else {
      link(page(), page() === "chat" ? conversation() : undefined);
    }
    if (phone()) void settingsPush.leave();
  }
  /** The chat of an agent just made from a template: a group of its own, opened. */
  async function chatWith(agent: AgentView) {
    const id = await openAgentChat(host, agent);
    if (id) open(id);
  }
  let openingCaptain = false;
  /** Why Captain's conversation did not open: shown in its pane, with Retry. */
  const captainProblem = signal<unknown>(undefined);
  async function openCaptain() {
    if (openingCaptain || captain() || !host.can("captain.direct")) return;
    openingCaptain = true;
    captainProblem.set(undefined);
    try {
      const result = await host.call<CaptainResults["direct"]>(
        "captain",
        "direct",
        {},
      );
      captain.set(result.conversationId);
    } catch (problem) {
      captainProblem.set(problem ?? new Error("failed"));
    } finally {
      openingCaptain = false;
    }
  }
  function navigate(next: Page) {
    openTask("");
    if (next === "settings") {
      showSettings();
      return;
    }
    settings.set(undefined);
    settingsPush.settle();
    chatPush.settle();
    page.set(next);
    mobileOpen.set(false);
    link(next);
  }
  function showRoutine(id?: string) {
    routineId.set(id ?? "");
    navigate("routines");
    step("end");
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
  /** The conversation drawn: the open one, or on a phone the one going back off the list. */
  const shownChat = () =>
    page() === "chat" && phone() && !mobileOpen() && chatPush.leaving()
      ? leavingChat
      : activeId();
  const conversationVisible = () =>
    Boolean(shownChat()) &&
    (page() === "captain" || !phone() || mobileOpen() || chatPush.leaving());
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
    if (
      conversation() &&
      host.state().targets.conversations &&
      !all.some((item) => item.id === conversation())
    ) {
      const next = phone()
        ? undefined
        : all.find(
            (item) =>
              item.kind === "group" &&
              !item.archived &&
              !host.state().missing[`conversations.${item.id}`],
          );
      conversation.set(next?.id ?? "");
      if (phone()) showConversation(false);
      if (!settings() && page() === "chat") link("chat", next?.id || undefined);
    }
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
  /** The open conversation, Captain's, or the empty page. */
  const chat = () => (
    <If
      when={conversationVisible()}
      else={
        <If
          when={page() === "chat" && !phone() && captain()}
          else={
            <ConversationEmpty
              captain={page() === "captain"}
              captainProblem={captainProblem()}
              onRetryCaptain={() => void openCaptain()}
              onCreate={() => newGroup.set(true)}
              onExpandList={listHidden() ? toggleList : undefined}
              attachExpandList={attachListToggle}
            />
          }
        >
          <Conversation
            id={captain()}
            layout={props.layout}
            captain
            onExpandList={listHidden() ? toggleList : undefined}
            attachExpandList={attachListToggle}
            onPending={() => navigate("pending")}
            onTask={openTask}
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
      <Each of={[shownChat()]}>
        {(id) => (
          <Conversation
            id={id()}
            onReadDraft={() => mobileOpen.set(true)}
            captain={page() === "captain"}
            layout={props.layout}
            onExpandList={listHidden() ? toggleList : undefined}
            attachExpandList={attachListToggle}
            onPending={() => navigate("pending")}
            onTask={openTask}
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
  );
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
            onCreate={() => newGroup.set(true)}
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
            ...pane.style(),
            display: props.layout === "tablet" && settings() ? "none" : "flex",
            visibility:
              props.layout === "tablet" && settings() ? "hidden" : "visible",
          }}
        >
          <If
            when={
              ((page() === "chat" &&
                (props.layout === "tablet" ||
                  (phone() && (!mobileOpen() || chatPush.under())))) ||
                (page() === "captain" && props.layout === "tablet")) &&
              !listHidden()
            }
          >
            <ChatList
              width={
                windowSize().width < 960 ? narrowListWidth : sizes.tabletList
              }
              layout={props.layout}
              selected={conversation()}
              onConversation={open}
              onCreate={() => newGroup.set(true)}
              onArchived={leaveArchived}
              onFold={props.layout === "tablet" ? toggleList : undefined}
              attachFold={attachListToggle}
            />
          </If>
          <If
            when={
              (page() === "chat" &&
                (!phone() || mobileOpen() || chatPush.leaving())) ||
              page() === "captain"
            }
          >
            <If when={phone() && page() === "chat"} else={chat()}>
              <View
                style={{
                  ...fill,
                  backgroundColor: c().canvas,
                  ...chatPush.style(),
                  pointerEvents: chatPush.leaving() ? "none" : "auto",
                }}
              >
                {chat()}
              </View>
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
          <If when={page() === "routines"}>
            <Routines
              onCaptain={() => navigate("captain")}
              initialId={routineId()}
              layout={props.layout}
              onBack={
                phone()
                  ? () => {
                      navigate("pending");
                      step("start");
                    }
                  : undefined
              }
            />
          </If>
          <If when={page() === "plugins"}>
            <Plugins
              layout={props.layout}
              onSettings={() => showSettings("Plugins")}
              onBack={
                phone()
                  ? () => {
                      navigate("more");
                      step("start");
                    }
                  : undefined
              }
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
              onNavigate={(next) => {
                navigate(next);
                step("end");
              }}
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
      <If
        when={
          settings() ?? (settingsPush.leaving() ? leavingSettings : undefined)
        }
      >
        {(section) => {
          return (
            <View
              style={{
                ...fill,
                ...settingsPush.style(),
                pointerEvents: settingsPush.leaving() ? "none" : "auto",
                zIndex: paneOrder.settings,
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
                onClose={() => closeSettings(section())}
                onTemplates={() => {
                  closeSettings(section());
                  templateGallery.set("");
                }}
              />
            </View>
          );
        }}
      </If>
      <If when={newGroup()}>
        <NewConversation
          layout={props.layout}
          onOpen={open}
          onClose={() => newGroup.set(false)}
        />
      </If>
      <If when={templateGallery() !== undefined}>
        <TemplateGallery
          phone={phone()}
          initialId={templateGallery() || undefined}
          onClose={() => templateGallery.set(undefined)}
          onCreated={(agent) => {
            templateGallery.set(undefined);
            void chatWith(agent);
          }}
          onModelServices={() => {
            templateGallery.set(undefined);
            showSettings("Model services");
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
        when={
          (task() || taskPush.leaving()) &&
          page() !== "tasks" &&
          (phone() || page() === "pending")
        }
      >
        {() => {
          return (
            <View
              style={{
                ...fill,
                zIndex: paneOrder.task,
                ...taskPush.style(),
                pointerEvents: taskPush.leaving() ? "none" : "auto",
              }}
            >
              <Each of={[task() || leavingTask]}>
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
          );
        }}
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
