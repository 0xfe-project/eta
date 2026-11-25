import type { IconName } from "./icons";
import {
  cleanup,
  createMotion,
  effect,
  reduceMotion,
  signal,
  untracked,
  View,
} from "nsh";
import { uiText } from "../i18n";
import { canHover, touchScreen } from "./menu";
import { shownWhile } from "./pending";
import { screenInsets } from "./safe-area";
import { Icon, Label } from "./text";
import { colors, focusRing, row, Screen } from "./theme";
import { control, icon, layer, opacity, shadow, space, weight } from "./tokens";

const progressCardWidth = 320;
const indeterminateBarWidth = 96;
const reducedBarWidth = 144;
const indeterminateTrackWidth = progressCardWidth - space[32];

const ETA_WARMUP_MS = 1000;
const DEFAULT_SLOW_MS = 10_000;
const INDETERMINATE_MS = 1400;

interface ProgressCount {
  completed: number;
  total: number;
}

export interface ProgressOptions {
  /** Stable identifier; starting with an existing id replaces that card. */
  id?: string;
  /** Leading icon while running (defaults to `"download"`). */
  icon?: IconName;
  /** Short title ("Exporting PDF", "Downloading update"). */
  title: string;
  /** Optional subtitle/stage line ("Preparing archive…"). */
  detail?: string;
  /** Determinate fraction 0..1; omit for indeterminate work. */
  progress?: number;
  /** Optional item count (`completed / total`). */
  count?: ProgressCount;
  /** Called when the user cancels a running notification. */
  onCancel?: () => void;
  /** Milliseconds before indeterminate work shows "Taking longer than usual…" (default 10000). */
  slowAfterMs?: number;
}

interface ProgressUpdate {
  title?: string;
  detail?: string;
  progress?: number;
  count?: ProgressCount;
  onCancel?: (() => void) | undefined;
}

interface ProgressComplete {
  title?: string;
  detail?: string;
  /** Invoked when clicking the completed card; also dismisses it. */
  onOpen?: () => void;
  /** Show the completed card even if the operation finished before the 300 ms reveal delay. */
  showWhenQuick?: boolean;
}

interface ProgressFailure {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}

export interface ProgressHandle {
  id: string;
  update: (patch: ProgressUpdate) => void;
  complete: (done?: ProgressComplete) => void;
  fail: (failure?: ProgressFailure) => void;
  dismiss: () => void;
}

type ProgressPhase = "running" | "done" | "error";

interface ProgressEntry {
  id: string;
  icon: IconName;
  title: string;
  detail?: string;
  progress?: number;
  count?: ProgressCount;
  phase: ProgressPhase;
  startedAt: number;
  firstProgressAt?: number;
  lastProgressAt?: number;
  slowAfterMs: number;
  showWhenQuick?: boolean;
  onCancel?: () => void;
  onOpen?: () => void;
  onRetry?: () => void;
}

const entries = signal<ProgressEntry[]>([]);
const layers = signal<number[]>([]);
let nextId = 0;

function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function dismissEntry(id: string) {
  entries.update((all) => all.filter((entry) => entry.id !== id));
}

function updateEntry(
  id: string,
  transform: (entry: ProgressEntry) => ProgressEntry,
) {
  entries.update((all) =>
    all.map((entry) => (entry.id === id ? transform(entry) : entry)),
  );
}

/** Formats remaining milliseconds into a concise localized ETA string. */
export function formatRemaining(remainingMs: number): string {
  const seconds = Math.round(remainingMs / 1000);
  if (seconds < 1) return uiText("progressLessThanSecond");
  if (seconds < 60) return uiText("progressSecondsLeft", { seconds });
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (remSeconds === 0) return uiText("progressMinutesLeft", { minutes });
  return uiText("progressMinutesSecondsLeft", {
    minutes,
    seconds: remSeconds,
  });
}

/** Starts a non-blocking, cross-page progress notification (revealed after `motion.reveal`). */
export function startProgress(options: ProgressOptions): ProgressHandle {
  const id = options.id ?? `progress-${++nextId}`;
  const now = Date.now();
  const initialProgress = clampProgress(options.progress);
  const next: ProgressEntry = {
    id,
    icon: options.icon ?? "download",
    title: options.title,
    detail: options.detail,
    progress: initialProgress,
    count: options.count,
    phase: "running",
    startedAt: now,
    firstProgressAt: initialProgress !== undefined ? now : undefined,
    lastProgressAt: initialProgress !== undefined ? now : undefined,
    slowAfterMs: options.slowAfterMs ?? DEFAULT_SLOW_MS,
    onCancel: options.onCancel,
  };
  entries.update((all) => [
    ...all.filter((entry) => entry.id !== id).slice(-3),
    next,
  ]);
  return {
    id,
    update(patch) {
      const ts = Date.now();
      updateEntry(id, (entry) => {
        if (entry.phase !== "running") return entry;
        const progress =
          "progress" in patch ? clampProgress(patch.progress) : entry.progress;
        const firstProgressAt =
          entry.firstProgressAt ?? (progress !== undefined ? ts : undefined);
        const lastProgressAt =
          progress !== undefined ? ts : entry.lastProgressAt;
        return {
          ...entry,
          title: patch.title ?? entry.title,
          detail: "detail" in patch ? patch.detail : entry.detail,
          progress,
          count: "count" in patch ? patch.count : entry.count,
          onCancel: "onCancel" in patch ? patch.onCancel : entry.onCancel,
          firstProgressAt,
          lastProgressAt,
        };
      });
    },
    complete(done) {
      updateEntry(id, (entry) => ({
        ...entry,
        phase: "done",
        progress: 1,
        title: done?.title ?? entry.title,
        detail: done && "detail" in done ? done.detail : entry.detail,
        onOpen: done?.onOpen,
        onCancel: undefined,
        showWhenQuick: done?.showWhenQuick,
      }));
    },
    fail(failure) {
      updateEntry(id, (entry) => ({
        ...entry,
        phase: "error",
        title: failure?.title ?? entry.title,
        detail: failure && "detail" in failure ? failure.detail : entry.detail,
        onRetry: failure?.onRetry,
        onCancel: undefined,
      }));
    },
    dismiss() {
      dismissEntry(id);
    },
  };
}

function IndeterminateBar() {
  const c = colors();
  const sweep = createMotion();
  effect(() => {
    if (reduceMotion()) {
      sweep.stop();
      sweep.reset();
      return;
    }
    void sweep.play({
      keyframes: {
        translateX: [-indeterminateBarWidth, indeterminateTrackWidth],
      },
      duration: INDETERMINATE_MS,
      easing: "easeInOut",
      iterations: "infinite",
    });
  });
  cleanup(() => sweep.stop());
  return (
    <View
      role="progressbar"
      accessibilityLabel={uiText("working")}
      style={{
        height: space[4],
        width: "100%",
        backgroundColor: c().selected,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          height: space[4],
          width: reduceMotion() ? reducedBarWidth : indeterminateBarWidth,
          backgroundColor: c().ink,
          ...(reduceMotion() ? {} : sweep.style),
        }}
      />
    </View>
  );
}

function ProgressCard(props: { entry: () => ProgressEntry; phone: boolean }) {
  const c = colors();
  const runningShown = shownWhile(() => props.entry().phase === "running");
  const hasRevealed = signal(false);
  const hovered = signal(false);
  const closeFocused = signal(false);
  const slow = signal(false);
  const now = signal(Date.now());

  effect(() => {
    if (runningShown()) hasRevealed.set(true);
  });

  // Dismiss quick completions that never crossed the 300 ms reveal delay unless asked to show.
  effect(() => {
    const item = props.entry();
    if (
      item.phase === "done" &&
      !untracked(hasRevealed) &&
      !item.showWhenQuick
    ) {
      dismissEntry(item.id);
    }
  });

  // Refresh clock once after ETA warmup so initial determinate progress transitions out of
  // "Estimating…" even if updates arrive slowly.
  effect(() => {
    const item = props.entry();
    if (
      item.phase !== "running" ||
      item.progress === undefined ||
      item.firstProgressAt === undefined
    ) {
      return;
    }
    const left = ETA_WARMUP_MS - (Date.now() - item.firstProgressAt);
    if (left <= 0) {
      now.set(Date.now());
      return;
    }
    const timer = setTimeout(() => now.set(Date.now()), left);
    cleanup(() => clearTimeout(timer));
  });

  // Show "Taking longer than usual…" for indeterminate work that exceeds `slowAfterMs` (10s).
  effect(() => {
    const item = props.entry();
    if (item.phase !== "running" || item.progress !== undefined) {
      slow.set(false);
      return;
    }
    const left = item.slowAfterMs - (Date.now() - item.startedAt);
    if (left <= 0) {
      slow.set(true);
      return;
    }
    const timer = setTimeout(() => slow.set(true), left);
    cleanup(() => clearTimeout(timer));
  });

  const visible = () => {
    const item = props.entry();
    if (item.phase === "error") return true;
    if (item.phase === "done") return hasRevealed() || !!item.showWhenQuick;
    return runningShown();
  };

  const statusLine = () => {
    const item = props.entry();
    if (item.phase !== "running") return item.detail;
    const parts: string[] = [];
    if (item.count) {
      parts.push(
        uiText("progressCount", {
          completed: item.count.completed,
          total: item.count.total,
        }),
      );
    } else if (item.progress !== undefined) {
      parts.push(`${Math.round(item.progress * 100)}%`);
    }
    if (item.progress !== undefined && item.firstProgressAt !== undefined) {
      const elapsed = Math.max(
        now() - item.firstProgressAt,
        (item.lastProgressAt ?? item.firstProgressAt) - item.firstProgressAt,
      );
      if (elapsed < ETA_WARMUP_MS || item.progress <= 0) {
        parts.push(uiText("progressEstimating"));
      } else if (item.progress < 1) {
        const remainingMs = (elapsed * (1 - item.progress)) / item.progress;
        parts.push(formatRemaining(remainingMs));
      }
    }
    if (item.detail) parts.unshift(item.detail);
    return parts.length ? parts.join(" · ") : undefined;
  };

  const canOpen = () =>
    props.entry().phase === "done" && Boolean(props.entry().onOpen);

  const showClose = () => {
    const item = props.entry();
    if (item.phase === "running") return Boolean(item.onCancel);
    return true;
  };

  const closeLabel = () =>
    props.entry().phase === "running" ? uiText("cancel") : uiText("close");

  const closeVisible = () =>
    props.entry().phase !== "running" ||
    hovered() ||
    closeFocused() ||
    touchScreen;

  return (
    <If when={visible()}>
      <View
        testID={`progress-notification-${props.entry().id}`}
        role={canOpen() ? "button" : undefined}
        accessibilityLabel={[
          props.entry().title,
          statusLine(),
          slow() ? uiText("takingLongerThanUsual") : undefined,
        ]
          .filter(Boolean)
          .join(". ")}
        accessibilityHint={canOpen() ? uiText("openResult") : undefined}
        onMouseEnter={() => hovered.set(canHover)}
        onMouseLeave={() => hovered.set(false)}
        onPress={
          canOpen()
            ? () => {
                const open = props.entry().onOpen;
                dismissEntry(props.entry().id);
                open?.();
              }
            : undefined
        }
        hoverStyle={canOpen() ? { backgroundColor: c().surface } : undefined}
        focusVisibleStyle={canOpen() ? focusRing(c()) : undefined}
        style={{
          width: props.phone ? "100%" : progressCardWidth,
          maxWidth: "100%",
          padding: space[12],
          gap: space[8],
          borderWidth: 1,
          borderColor: props.entry().phase === "error" ? c().red : c().border,
          backgroundColor: c().canvas,
          boxShadow: [shadow.float],
          cursor: canOpen() ? "pointer" : "default",
          pointerEvents: "auto",
        }}
      >
        <View style={{ ...row, alignItems: "flex-start", gap: space[12] }}>
          {/* Square icon tile: neutral while running, solid green + check when done, red on error. */}
          <View
            style={{
              width: control.lg,
              height: control.lg,
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: props.entry().phase === "done" ? 0 : 1,
              borderColor:
                props.entry().phase === "error" ? c().red : c().border,
              backgroundColor:
                props.entry().phase === "done"
                  ? c().green
                  : props.entry().phase === "error"
                    ? c().redFill
                    : c().selected,
            }}
          >
            <Icon
              name={
                props.entry().phase === "done"
                  ? "check"
                  : props.entry().phase === "error"
                    ? "warning"
                    : props.entry().icon
              }
              size={icon.md}
              tone={
                props.entry().phase === "done"
                  ? "buttonInk"
                  : props.entry().phase === "error"
                    ? "red"
                    : "ink"
              }
            />
          </View>

          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label variant="small" weight={weight.strong} lines={1}>
              {props.entry().title}
            </Label>
            <If when={statusLine()}>
              {(line) => (
                <Label
                  variant="caption"
                  tone={props.entry().phase === "error" ? "red" : "muted"}
                  lines={2}
                >
                  {line()}
                </Label>
              )}
            </If>
            <If when={slow() && props.entry().phase === "running"}>
              <Label variant="caption" tone="warningInk">
                {uiText("takingLongerThanUsual")}
              </Label>
            </If>
            <If when={props.entry().phase === "error" && props.entry().onRetry}>
              <View style={{ ...row, paddingTop: space[4] }}>
                <View
                  role="button"
                  accessibilityLabel={uiText("retry")}
                  onPress={() => {
                    const retry = props.entry().onRetry;
                    dismissEntry(props.entry().id);
                    retry?.();
                  }}
                  hoverStyle={{ backgroundColor: c().selected }}
                  focusVisibleStyle={focusRing(c())}
                  style={{
                    paddingHorizontal: space[8],
                    paddingVertical: space[2],
                    borderWidth: 1,
                    borderColor: c().strong,
                    cursor: "pointer",
                  }}
                >
                  <Label variant="caption" weight={weight.strong}>
                    {uiText("retry")}
                  </Label>
                </View>
              </View>
            </If>
          </View>

          <If when={showClose()}>
            <View
              role="button"
              accessibilityLabel={closeLabel()}
              onFocus={() => closeFocused.set(true)}
              onBlur={() => closeFocused.set(false)}
              onPress={() => {
                const item = props.entry();
                if (item.phase === "running") item.onCancel?.();
                dismissEntry(item.id);
              }}
              hoverStyle={{ backgroundColor: c().selected }}
              focusVisibleStyle={focusRing(c())}
              style={{
                width: control.sm,
                height: control.sm,
                flexShrink: 0,
                alignItems: "center",
                justifyContent: "center",
                opacity: closeVisible() ? 1 : opacity.disabled,
                cursor: "pointer",
              }}
            >
              <Icon name="close" size={icon.sm} tone="muted" />
            </View>
          </If>
        </View>

        {/* 4px progress bar while running; folds away in-place on completion or error. */}
        <If when={props.entry().phase === "running"}>
          <If
            when={props.entry().progress !== undefined}
            else={<IndeterminateBar />}
          >
            <View
              role="progressbar"
              accessibilityLabel={props.entry().title}
              accessibilityValue={{
                min: 0,
                max: 100,
                now: Math.round((props.entry().progress ?? 0) * 100),
              }}
              style={{
                height: space[4],
                width: "100%",
                backgroundColor: c().selected,
              }}
            >
              <View
                style={{
                  height: space[4],
                  width: `${Math.round((props.entry().progress ?? 0) * 100)}%`,
                  backgroundColor: c().ink,
                }}
              />
            </View>
          </If>
        </If>
      </View>
    </If>
  );
}

/**
 * Cross-page top-right non-blocking stack for long-running work (>3 s): exports, downloads,
 * host/daemon upgrades. Mounted alongside `ToastLayer` in `App.tsx` and `Modal`.
 */
export function ProgressNotificationLayer(props: { phone?: boolean }) {
  const layout = Screen();
  const insets = screenInsets();
  const id = ++nextId;
  layers.update((all) => [...all, id]);
  cleanup(() =>
    layers.update((all) => all.filter((layerId) => layerId !== id)),
  );
  const phone = () => props.phone ?? layout() === "phone";
  const top = () => layers().at(-1) === id;
  return (
    <If when={top() && entries().length > 0}>
      <View
        testID="progress-notification-layer"
        accessibilityLiveRegion="polite"
        style={{
          position: "absolute",
          zIndex: layer.toast,
          top: (phone() ? space[8] : space[16]) + insets().top,
          right: (phone() ? space[12] : space[16]) + insets().right,
          left: phone() ? space[12] + insets().left : undefined,
          gap: space[8],
          pointerEvents: "box-none",
        }}
      >
        <Each of={entries()} key={(entry) => entry.id}>
          {(entry) => <ProgressCard entry={entry} phone={phone()} />}
        </Each>
      </View>
    </If>
  );
}
