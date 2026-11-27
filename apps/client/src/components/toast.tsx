import { signal, View } from "nsh";
import { uiText } from "../i18n";
import { StatusDot } from "./status-dot";
import { Label } from "./text";
import { colors, focusRing, row, textFaces } from "./theme";
import { shadow, space, weight } from "./tokens";

const toastWidth = 356;

// A short app-wide note that goes by itself ("Copied", "Updated to 0.9.1"). Rendered inside the
// unified `NotificationHost` overlay so it always stays above every dialog and backdrop.

type ToastTone = "green" | "blue" | "warning" | "red";

export interface ToastNote {
  title: string;
  body?: string;
  tone?: ToastTone;
  /** How long the toast stays visible in ms. Defaults to 3000 ms for short confirmations, and
   * 6000 ms when an `action` (e.g. Undo) or `body` detail is present. */
  duration?: number;
  /** One thing to do about it, after the text ("Undo"); pressing it also dismisses the toast. */
  action?: { label: string; onPress: () => void };
}

interface Shown extends ToastNote {
  id: number;
}

/** Short action-confirmation duration. */
const TOAST_SHORT_MS = 3000;
/** Longer duration when the user can act on the toast (Undo) or read a detail line. */
const TOAST_LONG_MS = 6000;

const toasts = signal<Shown[]>([]);
let nextId = 0;

function dismiss(id: number) {
  toasts.update((all) => all.filter((toast) => toast.id !== id));
}

/** Shows a toast over whatever is open; it goes after its duration or on a press. */
export function showToast(note: ToastNote) {
  const id = ++nextId;
  const duration =
    note.duration ??
    (note.action || note.body ? TOAST_LONG_MS : TOAST_SHORT_MS);
  // At most three: the newest last, nearest the edge.
  toasts.update((all) => [...all.slice(-2), { ...note, id }]);
  // eslint-disable-next-line e18e/prefer-timer-args -- NSH's test clock drops setTimeout's extra arguments.
  setTimeout(() => dismiss(id), duration);
}

/** Whether any toast is currently visible. */
export function hasToasts() {
  return toasts().length > 0;
}

/** Pure presentational stack of active toasts, positioned by `NotificationHost`. */
export function ToastStack(props: { phone: () => boolean }) {
  const c = colors();
  const type = textFaces();
  return (
    <If when={toasts().length > 0}>
      <View
        accessibilityLiveRegion="polite"
        style={{
          alignItems: props.phone() ? "stretch" : "center",
          gap: space[8],
          pointerEvents: "box-none",
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
                width: props.phone() ? "100%" : toastWidth,
                maxWidth: "100%",
                gap: space[8],
                paddingVertical: space[12],
                paddingHorizontal: space[16],
                borderWidth: 1,
                borderColor: c().border,
                backgroundColor: c().canvas,
                boxShadow: [shadow.float],
                cursor: "pointer",
                pointerEvents: "auto",
              }}
            >
              <View
                style={{
                  height: type("small").line,
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <StatusDot
                  testID="toast-dot"
                  color={c()[toast().tone ?? "green"]}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
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
              <If when={toast().action}>
                {(action) => (
                  <View
                    role="button"
                    accessibilityLabel={action().label}
                    onPress={() => {
                      dismiss(toast().id);
                      action().onPress();
                    }}
                    hoverStyle={{ backgroundColor: c().selected }}
                    focusVisibleStyle={focusRing(c())}
                    style={{
                      alignSelf: "center",
                      paddingHorizontal: space[8],
                      paddingVertical: space[4],
                      cursor: "pointer",
                    }}
                  >
                    <Label variant="small" weight={weight.strong}>
                      {action().label}
                    </Label>
                  </View>
                )}
              </If>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
