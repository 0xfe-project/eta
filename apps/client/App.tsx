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
  safeAreaInsets,
  signal,
  Storage,
  UrlScheme,
  View,
  windowSize,
} from "nsh";
import { createAppearancePreferences } from "./src/app/appearance-preferences";
import { Workspace } from "./src/app/workspace";
import {
  Button,
  Fonts,
  grow,
  Label,
  palette,
  Palette,
  row,
} from "./src/components";
import {
  createElementPicker,
  ElementPickerOverlay,
  ElementPicking,
} from "./src/components/element-picker";
import { createLanguagePreference, LanguageSettings, uiText } from "./src/i18n";
import { Connection, WorkspaceSkeleton } from "./src/pages/connection";
import { HostRestartScreen } from "./src/pages/connection/host-restart";
import {
  canStartHost,
  startLocalHost,
} from "./src/pages/connection/local-host";
import {
  addressFrom,
  createHost,
  defaultAddress,
  Host,
} from "./src/services/host";
import { isHostRestart } from "./src/services/upgrade-watch";

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
  const language = createLanguagePreference();
  const elementPicker = createElementPicker();
  const initial = defaultAddress();
  const {
    theme,
    fonts,
    chatWidth,
    chatRail,
    changeTheme,
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
                      iconSize={16}
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

mount(App);
