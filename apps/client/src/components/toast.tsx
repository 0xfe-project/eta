import { cleanup, signal, View } from "nsh";
import { uiText } from "../i18n";
import { screenInsets } from "./safe-area";
import { StatusDot } from "./status-dot";
import { Label } from "./text";
import { colors, row, Screen } from "./theme";
import { shadow, weight } from "./tokens";

// A short app-wide note that goes by itself ("Updated to 0.9.1"). A native dialog (Settings on a
// computer or tablet) is a layer over the window that nothing in the root can draw above, so each
// layer that may be on top hosts a `ToastLayer`, and only the one opened last shows the toasts.

type ToastTone = "green" | "blue" | "warning" | "red";

export interface ToastNote {
  title: string;
  body?: string;
  tone?: ToastTone;
}

interface Shown extends ToastNote {
  id: number;
}

/** How long a toast stays. */
const TOAST_MS = 6000;

const toasts = signal<Shown[]>([]);
const layers = signal<number[]>([]);
let nextId = 0;

function dismiss(id: number) {
  toasts.update((all) => all.filter((toast) => toast.id !== id));
}

/** Shows a toast over whatever is open; it goes after a few seconds or on a press. */
export function showToast(note: ToastNote) {
  const id = ++nextId;
  // At most three: the newest last, nearest the edge.
  toasts.update((all) => [...all.slice(-2), { ...note, id }]);
  // eslint-disable-next-line e18e/prefer-timer-args -- NSH's test clock drops setTimeout's extra arguments.
  setTimeout(() => dismiss(id), TOAST_MS);
}

/** Where toasts are drawn in a layer: the root, or a dialog over it. */
export function ToastLayer(props: { phone?: boolean }) {
  const c = colors();
  const layout = Screen();
  const insets = screenInsets();
  const id = ++nextId;
  layers.update((all) => [...all, id]);
  cleanup(() => layers.update((all) => all.filter((layer) => layer !== id)));
  const phone = () => props.phone ?? layout() === "phone";
  const top = () => layers().at(-1) === id;
  return (
    <If when={top() && toasts().length > 0}>
      {/* Phones keep the bottom for the tab bar and the composer: their toasts come from the top. */}
      <View
        style={{
          position: "absolute",
          zIndex: 1000,
          right: phone() ? 12 + insets().right : 16,
          left: phone() ? 12 + insets().left : undefined,
          top: phone() ? 8 + insets().top : undefined,
          bottom: phone() ? undefined : 16 + insets().bottom,
          width: phone() ? undefined : 356,
          gap: 8,
        }}
      >
        <Each of={toasts()} key={(toast) => toast.id}>
          {(toast) => (
            <View
              role="alert"
              testID="toast"
              accessibilityLabel={[toast().title, toast().body]
                .filter(Boolean)
                .join(". ")}
              accessibilityHint={uiText("dismiss")}
              onPress={() => dismiss(toast().id)}
              style={{
                ...row,
                alignItems: "flex-start",
                gap: 10,
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderWidth: 1,
                borderColor: c().border,
                backgroundColor: c().canvas,
                boxShadow: [shadow.float],
                cursor: "pointer",
              }}
            >
              <View style={{ paddingTop: 6 }}>
                <StatusDot color={c()[toast().tone ?? "green"]} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Label variant="small" weight={weight.regular}>
                  {toast().title}
                </Label>
                <If when={toast().body}>
                  {(body) => (
                    <Label variant="small" tone="mutedInk">
                      {body()}
                    </Label>
                  )}
                </If>
              </View>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
