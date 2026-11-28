import type { PluginView, UpgradeStatusView } from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import type { ViewedPicture } from "../../src/components/picture-viewer";
import type { ProgressHandle } from "../../src/components/progress-notification";
import { colorScheme, mount, signal, Storage, View, windowSize } from "nsh";
import {
  Button,
  dialogWidth,
  Fonts,
  Label,
  Modal,
  palette,
  Palette,
  row,
  SafeArea,
  Screen,
} from "../../src/components";
import { NotificationHost } from "../../src/components/notifications";
import { Lightbox } from "../../src/components/picture-viewer";
import { startProgress } from "../../src/components/progress-notification";
import { showToast } from "../../src/components/toast";
import { space } from "../../src/components/tokens";
import { InviteAgents } from "../../src/pages/chat/members";
import { HostRestartScreen } from "../../src/pages/connection/host-restart";
import { ConfigurePlugin } from "../../src/pages/plugins/configure";
import { createHost, Host } from "../../src/services/host";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const samplePictures: ViewedPicture[] = [
  {
    key: "pic-1",
    caption: "architecture.png · 1.2 KB",
    src: () => tinyPng,
    failed: () => false,
  },
];

const samplePlugin: PluginView = {
  name: "eta-docs",
  version: "1.2.0",
  description: "Documentation connector",
  source: { kind: "local", path: "/plugins/eta-docs" },
  enabled: true,
  state: "needs_config",
  problem: null,
  reports: [],
  skills: [],
  servers: [],
  requires: [],
  machines: [],
  fields: [
    {
      name: "autoSync",
      title: "Auto-sync docs",
      description: "Sync workspace markdown automatically",
      type: "boolean",
      required: false,
      secret: false,
      agent: "none",
      set: false,
      default: false,
      value: false,
      level: "none",
      levels: ["none"],
      issue: null,
    },
  ],
  headers: [],
  agents: [],
};

function Fixture(props: {
  scene: string;
  themeOverride: "light" | "dark" | null;
  tabletConfigure: boolean;
}) {
  const host = createHost();
  const layout = (): Layout =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  const phone = () => layout() === "phone";
  const c = () => palette(props.themeOverride ?? colorScheme());
  const fonts = () => ({ interface: "", mono: "" });

  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: ["plugins.configure", "conversations.invite"],
    targets: {
      ...state.targets,
      agents: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            {
              id: "agent-lin",
              name: "Lin",
              runtime: "eta",
              status: "online",
            },
          ],
        },
      },
    },
  }));

  host.call = (async (target: string, action: string) => {
    if (target === "plugins" && action === "configure") {
      throw new Error("Plugin registry unreachable (ECONNREFUSED)");
    }
    return {};
  }) as typeof host.call;

  const undoCount = signal(0);
  const cancelCount = signal(0);
  const openCount = signal(0);
  const modalClosed = signal(0);
  const phoneInlineClosed = signal(0);
  const focusedClosed = signal(0);
  const nestedOverlayClosed = signal(0);
  const nestedFocusedClosed = signal(0);
  const configureClosed = signal(0);
  const membersClosed = signal(0);
  const lightboxClosed = signal(0);

  const overlayModalOpen = signal(false);
  const phoneInlineModalOpen = signal(false);
  const focusedModalOpen = signal(false);
  const nestedOverlayOpen = signal(false);
  const nestedFocusedOpen = signal(false);
  const configureOpen = signal(false);
  const membersOpen = signal(false);
  const lightboxIndex = signal<number | undefined>(undefined);
  const slowOverlayModalOpen = signal(false);

  let activeProgress: ProgressHandle | undefined;

  const triggerToast = () => {
    showToast({
      title: "Archived task",
      body: "Moved to archive",
      action: {
        label: "Undo",
        onPress: () => undoCount.update((n) => n + 1),
      },
    });
  };

  const triggerProgress = () => {
    activeProgress = startProgress({
      id: "job",
      icon: "download",
      title: "Exporting archive",
      detail: "Preparing files",
      progress: 0.4,
      onCancel: () => cancelCount.update((n) => n + 1),
    });
  };

  const triggerIndeterminate = () => {
    activeProgress = startProgress({
      id: "indet",
      icon: "refresh",
      title: "Syncing workspace",
      onCancel: () => cancelCount.update((n) => n + 1),
    });
  };

  const triggerError = () => {
    host.error.set("Host connection failed");
    host.errorDetail.set("ECONNREFUSED 127.0.0.1:4312");
  };

  const triggerAll = () => {
    triggerToast();
    triggerProgress();
    triggerError();
  };

  if (props.scene === "desktop-scene" || props.scene === "phone-scene") {
    if (props.scene === "desktop-scene") focusedModalOpen.set(true);
    else overlayModalOpen.set(true);
    setTimeout(() => {
      showToast({
        title: "Plugin settings saved",
        body: "eta-docs configuration updated",
        action: { label: "Undo", onPress: () => {} },
      });
      const handle = startProgress({
        id: "scene-job",
        icon: "download",
        title: "Downloading eta-host 0.9.1",
        detail: "18.4 MB of 29.6 MB",
        progress: 0.62,
        onCancel: () => {},
      });
      setTimeout(() => {
        handle.update({ progress: 0.68, detail: "20.1 MB of 29.6 MB" });
      }, 1050);
      host.error.set("Could not reach remote daemon gpu-box");
      host.errorDetail.set(
        "dial tcp 10.0.4.12:4312: connect: connection refused",
      );
    }, 20);
  }

  const triggerControls = (prefix: string) => (
    <View style={{ ...row, flexWrap: "wrap", gap: space[8] }}>
      <Button label={`${prefix} Toast`} onPress={triggerToast} />
      <Button label={`${prefix} Progress`} onPress={triggerProgress} />
      <Button
        label={`${prefix} Indeterminate`}
        onPress={triggerIndeterminate}
      />
      <Button
        label={`${prefix} Complete`}
        onPress={() =>
          activeProgress?.complete({
            title: "Archive exported",
            detail: "bundle.zip",
            onOpen: () => openCount.update((n) => n + 1),
          })
        }
      />
      <Button label={`${prefix} Error`} onPress={triggerError} />
      <Button label={`${prefix} All`} onPress={triggerAll} />
    </View>
  );

  return (
    <Host.Provider value={host}>
      <Palette.Provider value={c}>
        <Fonts.Provider value={fonts}>
          <Screen.Provider value={layout}>
            <SafeArea
              testID="app-safe-area"
              style={{ backgroundColor: c().canvas }}
            >
              <View
                style={{
                  flex: 1,
                  padding: space[24],
                  gap: space[12],
                  justifyContent: "center",
                }}
              >
                <Label variant="title">Workspace preview</Label>
                <Label tone="muted">
                  Conversations, tasks, and settings background surface.
                </Label>
                <If when={props.scene === "interactive"}>
                  <View style={{ gap: space[8] }}>
                    <Label>
                      {`Undo:${undoCount()} Cancel:${cancelCount()} Open:${openCount()} ModalClosed:${modalClosed()} PhoneInlineClosed:${phoneInlineClosed()} FocusedClosed:${focusedClosed()} NestedOverlayClosed:${nestedOverlayClosed()} NestedFocusedClosed:${nestedFocusedClosed()} ConfigureClosed:${configureClosed()} MembersClosed:${membersClosed()} LightboxClosed:${lightboxClosed()}`}
                    </Label>
                    {triggerControls("Root")}
                    <View style={{ ...row, flexWrap: "wrap", gap: space[8] }}>
                      <Button
                        label="Open overlay modal"
                        onPress={() => overlayModalOpen.set(true)}
                      />
                      <Button
                        label="Open phone inline modal"
                        onPress={() => phoneInlineModalOpen.set(true)}
                      />
                      <Button
                        label="Open focused modal"
                        onPress={() => focusedModalOpen.set(true)}
                      />
                      <Button
                        label="Open ConfigurePlugin"
                        onPress={() => configureOpen.set(true)}
                      />
                      <Button
                        label="Open InviteAgents"
                        onPress={() => membersOpen.set(true)}
                      />
                      <Button
                        label="Open Lightbox"
                        onPress={() => lightboxIndex.set(0)}
                      />
                      <Button
                        label="Open HostRestartScreen"
                        onPress={() => {
                          const status: UpgradeStatusView = {
                            id: "u-restart",
                            state: "running",
                            phase: "restarting",
                            from: "0.9.0",
                            to: "0.9.1",
                            startedAt: Date.now(),
                            log: [],
                          };
                          host.upgrade.set(status);
                        }}
                      />
                      <Button
                        label="Schedule notifications"
                        onPress={() => {
                          setTimeout(triggerAll, 50);
                        }}
                      />
                    </View>
                  </View>
                </If>
              </View>

              <If when={overlayModalOpen()}>
                <Modal
                  title={
                    props.scene === "phone-scene"
                      ? "Add plugin"
                      : "Overlay modal"
                  }
                  width={dialogWidth.md}
                  height={props.scene === "phone-scene" ? 320 : undefined}
                  phone={phone()}
                  sheet={phone()}
                  plainSheetHeader={phone()}
                  overPhoneNavigation={phone()}
                  onClose={() => {
                    overlayModalOpen.set(false);
                    modalClosed.update((n) => n + 1);
                  }}
                >
                  <View style={{ padding: space[16], gap: space[12] }}>
                    <Label variant="small" tone="muted">
                      {props.scene === "phone-scene"
                        ? "Install a local or Git plugin repository for workspace agents."
                        : "Non-modalFocus overlay dialog."}
                    </Label>
                    <If when={props.scene === "interactive"}>
                      {triggerControls("OverlayModal")}
                    </If>
                  </View>
                </Modal>
              </If>

              <If when={phoneInlineModalOpen()}>
                <Modal
                  title="Phone inline modal"
                  phone
                  overPhoneNavigation={false}
                  onClose={() => {
                    phoneInlineModalOpen.set(false);
                    phoneInlineClosed.update((n) => n + 1);
                  }}
                >
                  <View style={{ padding: space[16], gap: space[12] }}>
                    <Label variant="small">In-flow phone modal</Label>
                    {triggerControls("PhoneInline")}
                  </View>
                </Modal>
              </If>

              <If when={focusedModalOpen()}>
                <Modal
                  title="Settings"
                  width={props.scene === "desktop-scene" ? 768 : dialogWidth.lg}
                  height={props.scene === "desktop-scene" ? 576 : undefined}
                  modalFocus
                  onClose={() => {
                    focusedModalOpen.set(false);
                    focusedClosed.update((n) => n + 1);
                  }}
                >
                  <View style={{ padding: space[16], gap: space[12] }}>
                    <Label variant="small" tone="muted">
                      Configure agents, model services, plugins, and workspace
                      defaults.
                    </Label>
                    <If when={props.scene === "interactive"}>
                      {triggerControls("FocusedModal")}
                      <View style={{ ...row, flexWrap: "wrap", gap: space[8] }}>
                        <Button
                          label="Open nested overlay modal"
                          onPress={() => nestedOverlayOpen.set(true)}
                        />
                        <Button
                          label="Open nested focused modal"
                          onPress={() => nestedFocusedOpen.set(true)}
                        />
                        <Button
                          label="Open slow-leaving nested modal"
                          onPress={() => slowOverlayModalOpen.set(true)}
                        />
                      </View>
                    </If>
                    <If when={nestedOverlayOpen()}>
                      <Modal
                        title="Nested overlay modal"
                        width={dialogWidth.sm}
                        onClose={() => {
                          nestedOverlayOpen.set(false);
                          nestedOverlayClosed.update((n) => n + 1);
                        }}
                      >
                        <View style={{ padding: space[16], gap: space[12] }}>
                          <Label variant="small">Nested overlay body</Label>
                          {triggerControls("NestedOverlay")}
                        </View>
                      </Modal>
                    </If>
                    <If when={slowOverlayModalOpen()}>
                      <Modal
                        title="Slow leaving modal"
                        width={dialogWidth.sm}
                        onClose={() => slowOverlayModalOpen.set(false)}
                      >
                        <View style={{ padding: space[16] }}>
                          <Label variant="small">Slow leaving body</Label>
                        </View>
                      </Modal>
                    </If>
                    <If when={nestedFocusedOpen()}>
                      <Modal
                        title="Nested focused modal"
                        width={dialogWidth.sm}
                        modalFocus
                        onClose={() => {
                          nestedFocusedOpen.set(false);
                          nestedFocusedClosed.update((n) => n + 1);
                        }}
                      >
                        <View style={{ padding: space[16], gap: space[12] }}>
                          <Label variant="small">Nested focused body</Label>
                          {triggerControls("NestedFocused")}
                        </View>
                      </Modal>
                    </If>
                  </View>
                </Modal>
              </If>

              <If when={configureOpen()}>
                <ConfigurePlugin
                  item={samplePlugin}
                  phone={false}
                  tablet={props.tabletConfigure}
                  onClose={() => {
                    configureOpen.set(false);
                    configureClosed.update((n) => n + 1);
                  }}
                />
              </If>

              <If when={membersOpen()}>
                <InviteAgents
                  conversationId="group-1"
                  members={[]}
                  layout="tablet"
                  onClose={() => {
                    membersOpen.set(false);
                    membersClosed.update((n) => n + 1);
                  }}
                />
              </If>

              <Lightbox
                pictures={() => samplePictures}
                index={lightboxIndex}
                onIndex={(next) => {
                  if (next === undefined && lightboxIndex() !== undefined) {
                    lightboxClosed.update((n) => n + 1);
                  }
                  lightboxIndex.set(next);
                }}
              />

              <HostRestartScreen onConnect={() => {}} />
            </SafeArea>
            <NotificationHost />
          </Screen.Provider>
        </Fonts.Provider>
      </Palette.Provider>
    </Host.Provider>
  );
}

void Promise.all([
  Storage.getItem("scene"),
  Storage.getItem("theme"),
  Storage.getItem("tabletConfigure"),
]).then(([scene, theme, tabletConfigure]) =>
  mount(() => (
    <Fixture
      scene={scene ?? "interactive"}
      themeOverride={theme === "light" || theme === "dark" ? theme : null}
      tabletConfigure={tabletConfigure === "1"}
    />
  )),
);
