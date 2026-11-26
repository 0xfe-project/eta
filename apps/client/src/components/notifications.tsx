import {
  cleanup,
  context,
  effect,
  Overlay,
  safeArea,
  signal,
  untracked,
  View,
  windowSize,
} from "nsh";
import { uiText } from "../i18n";
import { Host } from "../services/host";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Regular } from "./density";
import { hasVisibleProgress, ProgressStack } from "./progress-notification";
import { screenInsets } from "./safe-area";
import { Icon, Label } from "./text";
import { colors, fill, row, Screen } from "./theme";
import { hasToasts, ToastStack } from "./toast";
import { border, control, icon, layer, shadow, space, weight } from "./tokens";

const hostErrorMaxWidth = 480;
const wideNotificationWidth = 1080;

interface ActiveHost {
  id: number;
  depth: number;
  seq: number;
}

/** Current dialog/modal nesting depth so root hosts never shadow open dialogs regardless of mount order. */
export const NotificationDepth = context<() => number>(() => 0);

const activeHosts = signal<ActiveHost[]>([]);
let nextHostId = 0;
let nextHostSeq = 0;

function topHostId(hosts: readonly ActiveHost[]): number | undefined {
  let best: ActiveHost | undefined;
  for (const entry of hosts) {
    if (
      !best ||
      entry.depth > best.depth ||
      (entry.depth === best.depth && entry.seq > best.seq)
    ) {
      best = entry;
    }
  }
  return best?.id;
}

/** Whether the global host error alert's raw Details section is expanded. */
const errorDetailsOpen = signal(false);
let lastErrorKey = "";

function HostErrorAlert(props: {
  host: NonNullable<ReturnType<typeof Host>>;
  phone: () => boolean;
}) {
  const c = colors();
  effect(() => {
    const key = `${props.host.error()}\0${props.host.errorDetail()}`;
    if (key !== lastErrorKey) {
      lastErrorKey = key;
      errorDetailsOpen.set(false);
    }
  });
  return (
    <View
      role="alert"
      testID="host-error-banner"
      accessibilityLiveRegion="assertive"
      style={{
        width: "100%",
        maxWidth: props.phone() ? "100%" : hostErrorMaxWidth,
        backgroundColor: c().canvas,
        borderWidth: 1,
        borderLeftWidth: border.thick,
        borderColor: c().border,
        borderLeftColor: c().red,
        boxShadow: [shadow.float],
        pointerEvents: "auto",
      }}
    >
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          paddingVertical: space[12],
          paddingLeft: space[12],
          paddingRight: space[8],
          gap: space[12],
        }}
      >
        <View
          style={{
            width: control.sm,
            height: control.sm,
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c().redFill,
          }}
        >
          <Icon name="warning" size={icon.md} tone="red" />
        </View>
        <View
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: control.sm,
            justifyContent: "center",
            gap: space[4],
          }}
        >
          <Label variant="small" weight={weight.strong}>
            {props.host.error()}
          </Label>
          <If when={props.phone() && props.host.errorDetail()}>
            <Button
              label={
                errorDetailsOpen()
                  ? uiText("hideDetails")
                  : uiText("showDetails")
              }
              icon={errorDetailsOpen() ? "down" : "right"}
              tone="ghost"
              size={control.sm}
              labelTone="muted"
              hoverTone="ink"
              expanded={errorDetailsOpen()}
              style={{ alignSelf: "flex-start", paddingHorizontal: space[4] }}
              onPress={() => errorDetailsOpen.set(!errorDetailsOpen())}
            />
          </If>
        </View>
        <View style={{ ...row, gap: space[4], flexShrink: 0 }}>
          <If when={!props.phone() && props.host.errorDetail()}>
            <Button
              label={
                errorDetailsOpen()
                  ? uiText("hideDetails")
                  : uiText("showDetails")
              }
              icon={errorDetailsOpen() ? "down" : "right"}
              tone="ghost"
              size={control.sm}
              labelTone="muted"
              hoverTone="ink"
              expanded={errorDetailsOpen()}
              onPress={() => errorDetailsOpen.set(!errorDetailsOpen())}
            />
          </If>
          <Button
            label={uiText("dismissError")}
            icon="close"
            iconOnly
            tone="ghost"
            size={control.sm}
            labelTone="muted"
            hoverTone="ink"
            tooltip={uiText("dismissError")}
            onPress={() => {
              props.host.error.set("");
              errorDetailsOpen.set(false);
              lastErrorKey = "";
            }}
          />
        </View>
      </View>
      <If when={errorDetailsOpen() && props.host.errorDetail()}>
        <View
          style={{
            ...row,
            alignItems: "flex-start",
            gap: space[8],
            paddingVertical: space[8],
            paddingLeft: space[12],
            paddingRight: space[8],
            borderTopWidth: 1,
            borderColor: c().border,
            backgroundColor: c().selectedSoft,
          }}
        >
          <Label
            variant="caption"
            tone="mutedInk"
            mono
            style={{ flex: 1, minWidth: 0, paddingVertical: space[4] }}
          >
            {props.host.errorDetail()}
          </Label>
          <CopyButton
            value={() => props.host.errorDetail()}
            label={uiText("copy")}
            iconOnly
            tone="ghost"
            size={control.sm}
            labelTone="muted"
            hoverTone="ink"
            tooltip={uiText("copy")}
          />
        </View>
      </If>
    </View>
  );
}

/**
 * Unified top-level portal for all global floating notification surfaces (Toasts, Progress
 * Notifications, and Global Host Error alert). Mounted once at the app root and inside each
 * `NativeDialog` / overlay `Modal`; only the topmost active host renders inside its `<Overlay>`.
 */
export function NotificationHost(props: {
  phone?: boolean;
  active?: boolean;
  depth?: number;
}) {
  // Read surface safe-area insets outside the `<Overlay>` it pads (safe-area.tsx), and preserve
  // window `safeArea()` inside native `<Dialog>` surfaces whose own `safeAreaInsets()` starts at 0.
  const surfaceInsets = screenInsets();
  const insets = () => {
    const root = safeArea();
    const surface = surfaceInsets();
    return {
      top: Math.max(root.top, surface.top),
      right: Math.max(root.right, surface.right),
      bottom: Math.max(root.bottom, surface.bottom),
      left: Math.max(root.left, surface.left),
    };
  };
  const layout = Screen();
  const host = Host();
  const inheritedDepth = NotificationDepth();
  const id = ++nextHostId;

  effect(() => {
    const active = props.active !== false;
    const depth = props.depth ?? inheritedDepth();
    untracked(() => {
      if (active) {
        activeHosts.update((all) => {
          const existing = all.find((entry) => entry.id === id);
          if (existing && existing.depth === depth) return all;
          return [
            ...all.filter((entry) => entry.id !== id),
            { id, depth, seq: ++nextHostSeq },
          ];
        });
      } else {
        activeHosts.update((all) => all.filter((entry) => entry.id !== id));
      }
    });
  });
  cleanup(() =>
    activeHosts.update((all) => all.filter((entry) => entry.id !== id)),
  );

  const phone = () =>
    props.phone ?? (layout() === "phone" || windowSize().width < 600);
  const isTop = () => topHostId(activeHosts()) === id;
  const hasError = () => Boolean(host?.error());
  const hasAny = () => hasToasts() || hasVisibleProgress() || hasError();
  // Top-center Toast (356) + top-right Progress (320) need >= 1080px usable width to clear horizontally.
  const stackedTop = () =>
    phone() ||
    (hasToasts() &&
      hasVisibleProgress() &&
      windowSize().width - insets().left - insets().right <
        wideNotificationWidth);

  return (
    <If when={isTop() && hasAny()}>
      <Overlay
        testID="notification-host"
        style={{ ...fill, zIndex: layer.toast, pointerEvents: "box-none" }}
      >
        <Regular>
          {/* Phone or narrow/tablet with simultaneous Toast + Progress: stack vertically without overlap. */}
          <If when={stackedTop() && (hasToasts() || hasVisibleProgress())}>
            <View
              testID="notification-top-stack"
              style={{
                position: "absolute",
                top: (phone() ? space[8] : space[16]) + insets().top,
                left: phone() ? space[12] + insets().left : undefined,
                right: (phone() ? space[12] : space[16]) + insets().right,
                alignItems: phone() ? "stretch" : "flex-end",
                gap: space[8],
                pointerEvents: "box-none",
              }}
            >
              <ToastStack phone={phone} />
              <ProgressStack phone={phone} />
            </View>
          </If>
          {/* Wide desktop: top-center Toasts, top-right Progress Notifications (or single card on tablet). */}
          <If when={!stackedTop() && hasToasts()}>
            <View
              style={{
                position: "absolute",
                top: space[16] + insets().top,
                left: space[16] + insets().left,
                right: space[16] + insets().right,
                alignItems: "center",
                pointerEvents: "box-none",
              }}
            >
              <ToastStack phone={phone} />
            </View>
          </If>
          <If when={!stackedTop() && hasVisibleProgress()}>
            <View
              style={{
                position: "absolute",
                top: space[16] + insets().top,
                right: space[16] + insets().right,
                pointerEvents: "box-none",
              }}
            >
              <ProgressStack phone={phone} />
            </View>
          </If>
          {/* Global Host Error alert at the bottom edge above all backdrops. */}
          <If when={hasError()}>
            <View
              style={{
                position: "absolute",
                bottom: (phone() ? space[12] : space[16]) + insets().bottom,
                left: (phone() ? space[12] : space[16]) + insets().left,
                right: (phone() ? space[12] : space[16]) + insets().right,
                alignItems: phone() ? "stretch" : "center",
                pointerEvents: "box-none",
              }}
            >
              <HostErrorAlert host={host!} phone={phone} />
            </View>
          </If>
        </Regular>
      </Overlay>
    </If>
  );
}
