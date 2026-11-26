import type { Layout } from "./src/components";
import type { HostAddress } from "./src/services/host";
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
  signal,
  Storage,
  UrlScheme,
  View,
  windowSize,
} from "nsh";
import { createAppearancePreferences } from "./src/app/appearance-preferences";
import { ClientUpdateNotice } from "./src/app/client-update-notice";
import { Workspace } from "./src/app/workspace";
import { showsWorkspace } from "./src/app/workspace-gate";
import {
  Button,
  Fonts,
  Label,
  palette,
  Palette,
  Revealed,
  row,
  SafeArea,
  Screen,
} from "./src/components";
import {
  createElementPicker,
  ElementPickerOverlay,
  ElementPicking,
} from "./src/components/element-picker";
import { NotificationHost } from "./src/components/notifications";
import { settled } from "./src/components/pending";
import { control, icon, space } from "./src/components/tokens";
import { createLanguagePreference, LanguageSettings, uiText } from "./src/i18n";
import { resumeComposerOutbox } from "./src/pages/chat/composer-draft";
import { Connection, WorkspaceSkeleton } from "./src/pages/connection";
import { HostRestartScreen } from "./src/pages/connection/host-restart";
import {
  canStartHost,
  startLocalHost,
} from "./src/pages/connection/local-host";
import {
  requestedTemplate,
  takeTemplateFromPage,
  templateLinkId,
} from "./src/pages/templates/link";
import {
  AttachmentFiles,
  createAttachmentFiles,
} from "./src/services/attachment-files";
import { clientUpdate } from "./src/services/client-update";
import {
  addressFrom,
  createHost,
  defaultAddress,
  Host,
} from "./src/services/host";
import { createPictureMode, PictureModes } from "./src/services/picture-mode";

const connectKey = "eta.host";

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
  resumeComposerOutbox(host);
  const pictureMode = createPictureMode();
  const attachmentFiles = createAttachmentFiles(host);
  const language = createLanguagePreference();
  const elementPicker = createElementPicker();
  const initial = defaultAddress();
  const {
    theme,
    fonts,
    chatWidth,
    chatRail,
    paletteId,
    flavor,
    changeTheme,
    changePalette,
    changeFlavor,
    changeFonts,
    changeChatWidth,
    changeChatRail,
  } = createAppearancePreferences();
  const layout = (): Layout =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  const openedWith =
    platform.os === "web" ? undefined : pairingAddress(UrlScheme.url());
  const forcedConnect = signal(Boolean(openedWith));
  requestedTemplate.set(takeTemplateFromPage());
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
  // The workspace's skeleton, once it appeared, stays its least time before the workspace.
  const workspaceSettled = settled(() => !loadingWebWorkspace());
  const startingLocal = signal(false);
  const offeredAddress = signal<HostAddress | undefined>(openedWith);
  const dismissCompatibility = signal(false);
  const applicationVersion = appInfo().version ?? undefined;
  cleanup(() => host.start(null));
  clientUpdate.start();
  if (initial) host.start(initial);
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
        const template = templateLinkId(url);
        if (template) {
          requestedTemplate.set(template);
          return;
        }
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
  const c = () => palette(colorScheme(), paletteId(), flavor());
  return (
    <LanguageSettings.Provider value={language}>
      <ElementPicking.Provider value={elementPicker}>
        <Host.Provider value={host}>
          <PictureModes.Provider value={pictureMode}>
            <AttachmentFiles.Provider value={attachmentFiles}>
              <Palette.Provider value={c}>
                <Fonts.Provider value={fonts}>
                  <Screen.Provider value={layout}>
                    <SafeArea
                      testID="app-safe-area"
                      style={{ backgroundColor: c().canvas }}
                    >
                      <If
                        when={showsWorkspace({
                          connected: host.hasConnected(),
                          everConnected: host.everConnected(),
                          changingHost: forcedConnect(),
                          settled: workspaceSettled(),
                        })}
                        else={
                          <If
                            when={loadingWebWorkspace() || !workspaceSettled()}
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
                            <Revealed>
                              <WorkspaceSkeleton layout={layout()} />
                            </Revealed>
                          </If>
                        }
                      >
                        <Workspace
                          layout={layout()}
                          theme={theme()}
                          onTheme={changeTheme}
                          paletteId={paletteId()}
                          onPalette={changePalette}
                          flavor={flavor()}
                          onFlavor={changeFlavor}
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
                      <If when={!forcedConnect()}>
                        <HostRestartScreen
                          onConnect={() => {
                            forcedConnect.set(true);
                            host.start(null);
                          }}
                        />
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
                            minHeight: space[40],
                            paddingLeft: space[16],
                            paddingRight: space[4],
                            borderTopWidth: 1,
                            borderColor: c().border,
                            backgroundColor: c().canvas,
                            gap: space[8],
                          }}
                        >
                          <Label style={{ flex: 1 }}>
                            {uiText("thisHostNeedsTheEtaDesktop", {
                              MIN_DESKTOP,
                              applicationVersion,
                            })}
                          </Label>
                          <Button
                            label={uiText("dismissCompatibilityWarning")}
                            icon="close"
                            iconOnly
                            size={control.lg}
                            iconSize={icon.md}
                            tone="ghost"
                            onPress={() => dismissCompatibility.set(true)}
                          />
                        </View>
                      </If>
                      <ClientUpdateNotice />
                    </SafeArea>
                    <NotificationHost />
                    <ElementPickerOverlay />
                    {attachmentFiles.writer()}
                  </Screen.Provider>
                </Fonts.Provider>
              </Palette.Provider>
            </AttachmentFiles.Provider>
          </PictureModes.Provider>
        </Host.Provider>
      </ElementPicking.Provider>
    </LanguageSettings.Provider>
  );
}

mount(App);
