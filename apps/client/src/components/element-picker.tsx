import type { ViewRef } from "nsh";
import {
  appInfo,
  cleanup,
  Clipboard,
  context,
  effect,
  keymap,
  Overlay,
  platform,
  signal,
  Storage,
  Text,
  View,
  windowSize,
} from "nsh";
import { useText } from "../i18n";
import { textFaces } from "./theme";
import { space } from "./tokens";

const storageKey = "eta.appearance.element-picker";

interface Target {
  component: string;
  source: string;
  measure: () => ReturnType<ViewRef["measure"]> | undefined;
}

export const ElementPicking = context<
  ReturnType<typeof createElementPicker> | undefined
>(undefined);

export function createElementPicker() {
  const enabled = signal(platform.os === "web" && appInfo().development);
  const hovered = signal<Target | undefined>(undefined);
  const bounds = signal<Awaited<ReturnType<ViewRef["measure"]>>>(null);
  const notice = signal<"pickerCopied" | "pickerCopyFailed" | undefined>(
    undefined,
  );
  let timeout: number | undefined;
  let changed = false;

  void Storage.getItem(storageKey)
    .then((value) => {
      if (!changed && value !== null) enabled.set(value === "true");
    })
    .catch(() => {});

  async function copy(target: Target) {
    try {
      await Clipboard.writeText(
        `<${target.component}>\n${target.source}#${target.component}`,
      );
      notice.set("pickerCopied");
    } catch {
      notice.set("pickerCopyFailed");
    }
    clearTimeout(timeout);
    timeout = setTimeout(() => notice.set(undefined), 1400);
  }

  effect(() => {
    const target = enabled() ? hovered() : undefined;
    bounds.set(null);
    if (!target) return;
    let stale = false;
    void target
      .measure()
      ?.then((value) => {
        if (!stale) bounds.set(value);
      })
      .catch(() => {});
    const unbind = keymap.bind("mod+c", () => void copy(target));
    return () => {
      stale = true;
      unbind();
    };
  });
  cleanup(() => clearTimeout(timeout));

  return {
    enabled,
    hovered,
    bounds,
    notice,
    copy,
    set(value: boolean) {
      changed = true;
      enabled.set(value);
      hovered.set(undefined);
      notice.set(undefined);
      void Storage.setItem(storageKey, String(value)).catch(() => {});
    },
  };
}

/** Names the TSX definition so copied source stays valid after formatting. */
export function pickerTarget(component: string, source: string, touch = true) {
  const picker = ElementPicking();
  let view: ViewRef | undefined;
  const target = { component, source, measure: () => view?.measure() };
  const clear = () => {
    if (picker?.hovered() === target) picker.hovered.set(undefined);
  };
  if (picker) cleanup(clear);
  return {
    ref: (ref: ViewRef) => {
      view = ref;
    },
    onMouseEnter: () => {
      if (picker?.enabled()) picker.hovered.set(target);
    },
    onMouseLeave: clear,
    get onLongPress() {
      if (touch && picker?.enabled() && windowSize().width < 600)
        return () => void picker.copy(target);
      return undefined;
    },
  };
}

export function ElementPickerOverlay() {
  const picker = ElementPicking();
  const type = textFaces();
  const text = useText();
  if (!picker) return null;
  return (
    <If when={picker.enabled() && (picker.bounds() || picker.notice())}>
      <Overlay
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          pointerEvents: "none",
        }}
      >
        <If when={picker.bounds()}>
          {(target) => (
            <View
              style={{
                position: "absolute",
                pointerEvents: "none",
                top: target().pagePosition.y,
                left: target().pagePosition.x,
                width: target().bounds.size.width,
                height: target().bounds.size.height,
                borderWidth: 1,
                borderColor: "#638eff", // design-value: the element picker is a developer tool, drawn the same over any theme
              }}
            />
          )}
        </If>
        <If when={picker.notice()}>
          {(message) => (
            <View
              role="alert"
              style={{
                position: "absolute",
                pointerEvents: "none",
                bottom: 76,
                right: 16,
                padding: space[8],
                backgroundColor: "#24417f", // design-value: the element picker's notice, a developer tool
              }}
            >
              {/* design-value: the element picker's notice, a developer tool */}
              <Text style={{ color: "#ffffff", fontSize: type("small").size }}>
                {text(message())}
              </Text>
            </View>
          )}
        </If>
      </Overlay>
    </If>
  );
}
