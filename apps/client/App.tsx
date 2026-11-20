import type {
  AgentResults,
  CaptainResults,
  EmailThreadView,
  ProvidersView,
} from "@eta/client-contracts";
import type { ChatWidth, Theme } from "./appearance";
import type { HostAddress } from "./host";
import type { IconName } from "./icons";
import type { SettingsSection } from "./settings";
import type { Page } from "./shell";
import type { Layout } from "./ui";
import { parseConnectLink } from "@eta/client-contracts/connect-link";
import { desktopTooOld, MIN_DESKTOP } from "@eta/client-contracts/desktop";
import {
  appInfo,
  cleanup,
  colorScheme,
  effect,
  mount,
  openUrl,
  platform,
  safeAreaInsets,
  setColorScheme,
  signal,
  Storage,
  untracked,
  UrlScheme,
  View,
  windowSize,
} from "nsh";
import { Conversation, Pending } from "./chat";
import { Connection, WorkspaceSkeleton } from "./connection";
import { AgentEditor } from "./dialogs";
import {
  createElementPicker,
  ElementPickerOverlay,
  ElementPicking,
} from "./element-picker";
import {
  addressFrom,
  createHost,
  defaultAddress,
  follow,
  Host,
  useHost,
} from "./host";
import { canStartHost, startLocalHost } from "./local-host";
import {
  createLanguagePreference,
  LanguageSettings,
  uiText,
  useText,
} from "./locale";
import { useModels } from "./models";
import { NewConversation } from "./new-conversation";
import { Onboard } from "./onboard";
import { Settings } from "./settings";
import { ChatList, DesktopSidebar, PhoneNavigation, TabletRail } from "./shell";
import { NewTask, TaskDetail, Tasks } from "./tasks";
import {
  Button,
  colors,
  Empty,
  fill,
  Fonts,
  grow,
  Header,
  Icon,
  Label,
  Palette,
  palette,
  row,
  sizes,
} from "./ui";
import { isHostRestart } from "./upgrade-watch";
import { Email, Plugins, Routines } from "./workspace";

const pages: Page[] = [
  "chat",
  "tasks",
  "email",
  "routines",
  "plugins",
  "settings",
  "captain",
  "pending",
  "more",
  "onboard",
];
const connectKey = "eta.host";
const themeKey = "eta.appearance";
const chatWidthKey = "eta.chat.width";
const chatRailKey = "eta.chat.rail";
const fontsKey = "eta.appearance.fonts";

function location() {
  const current = UrlScheme.url();
  if (!current || platform.os !== "web")
    return { page: "chat" as Page, conversation: "" };
  const url = new URL(current);
  const path = url.pathname.split("/").filter(Boolean)[0];
  return {
    page:
      url.searchParams.get("settings") === "update"
        ? ("settings" as Page)
        : (pages.find((page) => page === path) ?? "chat"),
    update: url.searchParams.get("settings") === "update",
    conversation: url.searchParams.get("conversation") ?? "",
  };
}

function pairingAddress(
  url: string | null | undefined,
): HostAddress | undefined {
  try {
    const link = url ? parseConnectLink(url) : undefined;
    return link
      ? { origin: addressFrom(link.address), token: link.token || undefined }
      : undefined;
  } catch {
    return undefined;
  }
}

function App() {
  const host = createHost();
  const language = createLanguagePreference();
  const elementPicker = createElementPicker();
  const initial = defaultAddress();
  const theme = signal<Theme>("system");
  const layout = (): Layout =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  const openedWith =
    platform.os === "web" ? undefined : pairingAddress(UrlScheme.url());
  const forcedConnect = signal(Boolean(openedWith));
  const userConnecting = signal(false);
  const openingWeb = signal(false);
  const loadingWebWorkspace = () => {
    const page = UrlScheme.url();
    return (
      platform.os === "web" &&
      !!page &&
      !forcedConnect() &&
      !userConnecting() &&
      host.address()?.origin === new URL(page).origin &&
      host.failures() === 0 &&
      !host.hasConnected()
    );
  };
  const startingLocal = signal(false);
  const offeredAddress = signal<HostAddress | undefined>(openedWith);
  const insets = safeAreaInsets();
  const dismissCompatibility = signal(false);
  const applicationVersion = appInfo().version ?? undefined;
  cleanup(() => host.start(null));
  if (initial) host.start(initial);
  const chatRail = signal(false);
  const fonts = signal({ interface: "", mono: "" });
  void Storage.getItem(chatRailKey)
    .then((value) => chatRail.set(value === "true"))
    .catch(() => {});
  void Storage.getItem(fontsKey)
    .then((value) => {
      if (!value) return;
      const saved = JSON.parse(value);
      if (typeof saved.interface === "string" && typeof saved.mono === "string")
        fonts.set({
          interface: saved.interface.slice(0, 100),
          mono: saved.mono.slice(0, 100),
        });
    })
    .catch(() => {});
  function changeChatRail(next: boolean) {
    chatRail.set(next);
    void Storage.setItem(chatRailKey, String(next)).catch(() => {});
  }
  function changeFonts(next: { interface: string; mono: string }) {
    const normalized = {
      interface: next.interface.slice(0, 100),
      mono: next.mono.slice(0, 100),
    };
    fonts.set(normalized);
    void Storage.setItem(fontsKey, JSON.stringify(normalized)).catch(() => {});
  }
  const chatWidth = signal<ChatWidth>("standard");
  void Storage.getItem(chatWidthKey)
    .then((stored) => {
      if (
        stored === "extra-narrow" ||
        stored === "compact" ||
        stored === "wide" ||
        stored === "standard"
      )
        chatWidth.set(stored);
    })
    .catch(() => {});
  function changeChatWidth(width: ChatWidth) {
    chatWidth.set(width);
    void Storage.setItem(chatWidthKey, width).catch(() => {});
  }
  void Storage.getItem(themeKey)
    .then((stored) => {
      if (stored === "dark" || stored === "light") {
        theme.set(stored);
        setColorScheme(stored);
      }
    })
    .catch(() => {});
  if (!initial)
    void Storage.getItem(connectKey)
      .then(async (stored) => {
        if (!stored || host.address() || forcedConnect()) return;
        const address = JSON.parse(stored) as HostAddress;
        if (!address.local) {
          host.start(address);
          return;
        }
        startingLocal.set(true);
        host.watchUpgrade(address);
        try {
          const resumed = await startLocalHost();
          if (!host.address() && !forcedConnect())
            host.start({ ...resumed, local: true });
        } catch {
          if (!host.address() && !forcedConnect()) {
            if (host.upgrade()?.state === "running") host.start(address);
            else {
              host.watchUpgrade(null);
              forcedConnect.set(true);
            }
          }
        } finally {
          startingLocal.set(false);
        }
      })
      .catch(() => {});
  function connect(address: HostAddress) {
    if (openingWeb()) return;
    userConnecting.set(true);
    const current = UrlScheme.url();
    if (
      platform.os === "web" &&
      (address.token || (current && address.origin !== new URL(current).origin))
    ) {
      void openWebHost(address);
      return;
    }
    connectInApp(address);
  }

  function connectInApp(address: HostAddress) {
    offeredAddress.set(undefined);
    forcedConnect.set(false);
    host.start(address);
  }

  async function openWebHost(address: HostAddress) {
    openingWeb.set(true);
    try {
      if (!address.token) {
        try {
          await fetch(new URL("/up", address.origin), {
            mode: "no-cors",
            signal: AbortSignal.timeout(3000),
          });
        } catch {
          connectInApp(address);
          return;
        }
      }
      const next = new URL(address.origin);
      if (address.token) next.searchParams.set("token", address.token);
      await host.action(async () => {
        if (!(await openUrl(next.href)).opened)
          throw new Error("The host address could not be opened.");
      });
    } finally {
      openingWeb.set(false);
    }
  }
  if (platform.os !== "web")
    cleanup(
      UrlScheme.on("open", ({ url }) => {
        const address = pairingAddress(url);
        if (!address) return;
        offeredAddress.set(address);
        forcedConnect.set(true);
      }),
    );
  effect(() => {
    if (platform.os !== "web" && host.hasConnected() && host.address())
      void Storage.setItem(connectKey, JSON.stringify(host.address())).catch(
        () => {},
      );
  });
  function changeTheme(next: Theme) {
    theme.set(next);
    setColorScheme(next);
    void Storage.setItem(themeKey, next).catch(() => {});
  }
  const c = () => palette(colorScheme());
  return (
    <LanguageSettings.Provider value={language}>
      <ElementPicking.Provider value={elementPicker}>
        <Host.Provider value={host}>
          <Palette.Provider value={c}>
            <Fonts.Provider value={fonts}>
              <View
                style={{
                  ...grow,
                  backgroundColor: c().canvas,
                  paddingTop: insets().top,
                  paddingBottom: insets().bottom,
                  paddingLeft: insets().left,
                  paddingRight: insets().right,
                }}
              >
                <If
                  when={
                    host.hasConnected() && !host.paused() && !forcedConnect()
                  }
                  else={
                    <If
                      when={loadingWebWorkspace()}
                      else={
                        <Connection
                          initial={offeredAddress() ?? host.address()}
                          layout={layout()}
                          resuming={startingLocal()}
                          openingWeb={openingWeb()}
                          onConnect={connect}
                        />
                      }
                    >
                      <WorkspaceSkeleton layout={layout()} />
                    </If>
                  }
                >
                  <Workspace
                    layout={layout()}
                    theme={theme()}
                    onTheme={changeTheme}
                    chatWidth={chatWidth()}
                    onChatWidth={changeChatWidth}
                    chatRail={chatRail()}
                    onChatRail={changeChatRail}
                    onFonts={changeFonts}
                    onConnect={() => {
                      forcedConnect.set(true);
                      host.start(null);
                    }}
                  />
                </If>
                <If
                  when={
                    !forcedConnect() &&
                    (isHostRestart(host.upgrade()) ||
                      (host.upgrade()?.state === "running" &&
                        host.upgradeUnreachable() &&
                        host.state().status !== "open"))
                  }
                >
                  <HostRestartScreen />
                </If>
                <If
                  when={
                    canStartHost &&
                    host.hasConnected() &&
                    !dismissCompatibility() &&
                    desktopTooOld(applicationVersion)
                  }
                >
                  <View
                    role="alert"
                    style={{
                      ...row,
                      flexShrink: 0,
                      minHeight: 40,
                      paddingLeft: 16,
                      paddingRight: 4,
                      borderTopWidth: 1,
                      borderColor: c().border,
                      backgroundColor: c().canvas,
                      gap: 8,
                    }}
                  >
                    <Label size={14} line={18} style={{ flex: 1 }}>
                      {uiText("thisHostNeedsTheEtaDesktop", {
                        MIN_DESKTOP,
                        applicationVersion,
                      })}
                    </Label>
                    <Button
                      label={uiText("dismissCompatibilityWarning")}
                      icon="close"
                      iconOnly
                      size={32}
                      tone="ghost"
                      onPress={() => dismissCompatibility.set(true)}
                    />
                  </View>
                </If>
                <If when={host.error()}>
                  <View
                    style={{
                      ...row,
                      position: "absolute",
                      zIndex: 1000,
                      bottom: 16,
                      right: 16,
                      left: 16,
                      padding: 8,
                      gap: 8,
                      backgroundColor: c().redFill,
                      borderWidth: 1,
                      borderColor: c().red,
                    }}
                  >
                    <Label size={12} tone="red" style={{ flex: 1 }}>
                      {host.error()}
                    </Label>
                    <Button
                      label={uiText("dismissError")}
                      icon="close"
                      iconOnly
                      tone="ghost"
                      onPress={() => host.error.set("")}
                    />
                  </View>
                </If>
              </View>
              <ElementPickerOverlay />
            </Fonts.Provider>
          </Palette.Provider>
        </Host.Provider>
      </ElementPicking.Provider>
    </LanguageSettings.Provider>
  );
}

function HostRestartScreen() {
  const update = useHost().upgrade;
  const c = colors();
  const description = () => {
    switch (update()?.phase) {
      case "starting":
        return uiText("updatePreparing");
      case "downloading":
        return uiText("updateDownloading");
      case "waiting":
        return uiText("updateWaiting");
      case "rolling-back":
        return uiText("restoringThePreviousVersion");
      default:
        return uiText("startingTheNewVersion");
    }
  };
  return (
    <View
      role="alert"
      testID="host-updating"
      accessibilityLabel={uiText("hostUpdateInProgress")}
      style={{
        ...fill,
        zIndex: 500,
        backgroundColor: c().canvas,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: 24,
      }}
    >
      <View style={{ width: 344, maxWidth: "100%", gap: 8 }}>
        <Label size={18} weight={600}>
          {update()?.to
            ? uiText("updatingTo", { to: update()?.to })
            : uiText("updatingTheHost")}
        </Label>
        <Label size={13} tone="muted">
          {description()}
        </Label>
        <View
          style={{
            height: 3,
            backgroundColor: c().border,
            flexDirection: "row",
            alignItems: "stretch",
          }}
        >
          <View style={{ width: "20%" }} />
          <View style={{ width: "38%", backgroundColor: c().ink }} />
          <View style={{ width: "16%" }} />
          <View style={{ width: "12%", backgroundColor: c().muted }} />
        </View>
      </View>
    </View>
  );
}

function Workspace(props: {
  layout: Layout;
  theme: Theme;
  onTheme: (mode: Theme) => void;
  chatWidth: ChatWidth;
  onChatWidth: (width: ChatWidth) => void;
  chatRail: boolean;
  onChatRail: (on: boolean) => void;
  onFonts: (fonts: { interface: string; mono: string }) => void;
  onConnect: () => void;
}) {
  const host = useHost();
  const c = colors();
  const text = useText();
  const start = location();
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
  function link(nextPage: Page, id?: string) {
    const current = UrlScheme.url();
    if (!current || platform.os !== "web") return;
    const url = new URL(current);
    url.pathname = nextPage === "chat" ? "/" : `/${nextPage}`;
    if (id) url.searchParams.set("conversation", id);
    else url.searchParams.delete("conversation");
    if (url.href !== current) UrlScheme.setUrl(url.href, { history: "push" });
  }
  if (platform.os === "web")
    cleanup(
      UrlScheme.on("change", () => {
        const next = location();
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
  function open(id: string) {
    openTask("");
    page.set("chat");
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
      const first = all.find((item) => item.kind === "group" && !item.archived);
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
          host.state().status === "reconnecting" &&
          (!phone() ||
            (!(page() === "captain" && captain()) &&
              !(page() === "chat" && mobileOpen() && conversation())))
        }
      >
        <View
          style={{
            ...row,
            padding: 8,
            paddingHorizontal: 14,
            gap: 8,
            backgroundColor: phone() ? c().surface : c().amberFill,
            borderBottomWidth: phone() ? 1 : 0,
            borderColor: c().border,
            flexShrink: 0,
          }}
        >
          <Label
            size={12}
            tone={phone() ? "muted" : "amber"}
            style={{ flex: 1 }}
          >
            {phone()
              ? uiText("connectionLostReconnectingWhatYouSee")
              : uiText("connectionLostReconnecting")}
          </Label>
          <If when={!phone()}>
            <Button label={uiText("changeHost")} onPress={props.onConnect} />
          </If>
        </View>
      </If>
      <View style={{ ...row, ...grow, alignItems: "stretch" }}>
        <If when={props.layout === "desktop"}>
          <DesktopSidebar
            page={desktopRail() && settings() ? "settings" : page()}
            onNavigate={navigate}
            selected={conversation()}
            onConversation={open}
            onAgent={(id) => void direct(id)}
            onCreate={() => newGroup.set(true)}
            onCreateAgent={() => newAgent.set(true)}
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
              page() === "chat" &&
              (props.layout === "tablet" || (phone() && !mobileOpen()))
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
                    <Empty
                      title={
                        page() === "captain"
                          ? "Captain"
                          : uiText("noConversationSelected")
                      }
                      description={
                        page() === "captain"
                          ? uiText("captainWillAppearWhenItIs")
                          : uiText("createAConversationOrSelectAn")
                      }
                      icon="chat"
                    >
                      <If when={page() === "chat"}>
                        <Button
                          label={uiText("newConversation")}
                          icon="plus"
                          onPress={() => newGroup.set(true)}
                        />
                      </If>
                    </Empty>
                  }
                >
                  <Conversation
                    id={captain()}
                    layout={props.layout}
                    captain
                    onTask={openTask}
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
                    captain={page() === "captain"}
                    layout={props.layout}
                    onTask={openTask}
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
            <View style={{ ...grow, ...row, alignItems: "stretch" }}>
              <View
                style={
                  task() && props.layout === "tablet"
                    ? {
                        width: 300,
                        flexShrink: 0,
                        borderRightWidth: 1,
                        borderColor: c().border,
                      }
                    : { ...grow, display: task() ? "none" : "flex" }
                }
              >
                <Tasks
                  layout={props.layout}
                  condensed={!!task() && props.layout === "tablet"}
                  onOpen={openTask}
                  onCreate={() => newTask.set(true)}
                />
              </View>
              <If when={task()}>
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
              </If>
            </View>
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
            <Plugins layout={props.layout} />
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
            <View style={grow}>
              <Header title={text("more")} layout={props.layout} />
              <MoreRow
                title={text("email")}
                icon="email"
                count={
                  host
                    .list<EmailThreadView>("email", "threads")
                    .filter((thread) => thread.unread).length
                }
                onPress={() => navigate("email")}
              />
              <MoreRow
                title={text("plugins")}
                icon="plugins"
                onPress={() => navigate("plugins")}
              />
              <MoreRow
                title={text("settings")}
                icon="settings"
                onPress={() => showSettings()}
              />
            </View>
          </If>
        </View>
      </View>
      <If when={phone()}>
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
              bottom: phone() ? sizes.phoneNav : 0,
            }}
          >
            <Settings
              initial={section()}
              layout={props.layout}
              theme={props.theme}
              onTheme={props.onTheme}
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
        <View
          style={{ ...fill, bottom: phone() ? sizes.phoneNav : 0, zIndex: 10 }}
        >
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

function MoreRow(props: {
  title: string;
  icon: IconName;
  count?: number;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: 56,
        paddingLeft: 16,
        paddingRight: 12,
        gap: 12,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View style={{ width: 20, alignItems: "center" }}>
        <Icon name={props.icon} size={16} />
      </View>
      <Label style={{ flex: 1 }}>{props.title}</Label>
      <If when={props.count}>
        <View
          style={{
            height: 14,
            minWidth: 14,
            paddingHorizontal: 3,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c().blue,
          }}
        >
          <Label size={10} line={12} style={{ color: "#ffffff" }}>
            {props.count}
          </Label>
        </View>
      </If>
      <Icon name="right" size={14} tone="muted" />
    </View>
  );
}

function PhoneHostSetup(props: { noModel: boolean; hostName?: string }) {
  const c = colors();
  const insets = safeAreaInsets();
  const hostname = () => {
    if (!props.hostName) return "This host";
    const name = new URL(props.hostName).hostname;
    return /^\d+\./.test(name) ? name : name.split(".")[0];
  };
  return (
    <View style={grow}>
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 32,
          paddingBottom: 26,
          gap: 4,
        }}
      >
        <Label size={24} line={32}>
          {uiText("isntReadyYet", { hostname: hostname() })}
        </Label>
        <Label size={13} line={18} tone="muted">
          {props.noModel
            ? uiText("twoStepsLeftOpenEtaOn")
            : uiText("oneStepLeftOpenEtaOn")}
        </Label>
      </View>
      <View style={{ borderTopWidth: 1, borderColor: c().border }}>
        <If when={props.noModel}>
          <SetupStep
            number={1}
            title={uiText("bindAModel")}
            detail={uiText("thereIsNoProviderYetAdd")}
          />
        </If>
        <SetupStep
          number={props.noModel ? 2 : 1}
          title={uiText("installAnAgent")}
          detail={uiText("agentsAreWhoYouTalkTo")}
          waiting={props.noModel}
        />
      </View>
      <View style={{ ...grow }} />
      <Label
        size={12}
        line={16}
        tone="muted"
        style={{
          paddingHorizontal: 16,
          paddingBottom: Math.max(4, 34 - insets().bottom),
        }}
      >
        {uiText("thisPageUpdatesByItselfWhen")}
      </Label>
    </View>
  );
}

function SetupStep(props: {
  number: number;
  title: string;
  detail: string;
  waiting?: boolean;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        alignItems: "flex-start",
        paddingVertical: 14,
        paddingHorizontal: 16,
        gap: 16,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label
        size={12}
        line={20}
        tone={props.waiting ? "muted" : "ink"}
        style={{ width: 16 }}
      >
        {props.number}
      </Label>
      <View style={{ ...grow, gap: 3 }}>
        <Label size={14} line={20} tone={props.waiting ? "mutedInk" : "ink"}>
          {props.title}
        </Label>
        <Label size={13} line={18} tone="muted">
          {props.detail}
        </Label>
      </View>
    </View>
  );
}

mount(App);
