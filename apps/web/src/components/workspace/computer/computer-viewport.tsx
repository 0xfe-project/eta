import type {
  ComputerController,
  ComputerCursorKind,
  ComputerCursorState,
  ComputerFrameEvent,
  ComputerPickerState,
  ComputerPickerStatus,
  ComputerUserInput,
  ViewportSize,
} from "@eta/client-contracts";
import { clampCoordinate, NORMALIZED_MAX } from "@eta/client-contracts";
import { cn } from "cn";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useInputMethod } from "@/components/workspace/use-input-method";

export interface ComputerViewportProps {
  /** Clean screenshot frame (or data URL via `frameSrc`); never mutated. */
  frame?: Pick<ComputerFrameEvent, "mimeType" | "data"> | null | undefined;
  /** Optional direct image URL/data-URI override for the clean frame. */
  frameSrc?: string | null | undefined;
  /** Logical viewport dimensions (defaults to 1280x800 when omitted). */
  viewport?: ViewportSize | undefined;
  /** Current single-writer controller lock. */
  controller: ComputerController;
  /** Agent cursor position and last micro-action in normalized `0..1000` coordinates. */
  cursor?: ComputerCursorState | null | undefined;
  /** Display name on the agent cursor badge (falls back to `"ETA"`). */
  agentName?: string | null | undefined;
  /** Current state of the realm's silent file picker broker. */
  picker?: ComputerPickerState | null | undefined;
  /** Called with normalized `0..1000` user inputs ONLY when `controller === "user"`. */
  onUserInput?: ((input: ComputerUserInput) => void) | undefined;
  /** Optional handler to resolve a pending file picker from the bottom status bar. */
  onResolvePicker?: ((files?: string[]) => void) | undefined;
  /** Optional handler to jump to the Pending/Inbox tab when `picker.status === "awaiting_approval"`. */
  onReviewApproval?: (() => void) | undefined;
  /** Optional handler to paste once from host clipboard (triggered by Ctrl+Shift+V). */
  onPasteFromHost?: (() => void) | undefined;
  /** Accessible title of the realm surface. */
  title?: string | undefined;
  className?: string | undefined;
}

const CLICK_PULSE_KINDS: ReadonlySet<ComputerCursorKind> = new Set([
  "click",
  "double_click",
  "right_click",
]);

function isPulseAction(kind: ComputerCursorKind): boolean {
  return CLICK_PULSE_KINDS.has(kind);
}

/**
 * Convert a DOM pointer/wheel event's client coordinates inside `element` into normalized
 * `0..1000` coordinates. Falls back to `viewport` dimensions when the layout box is 0x0 (e.g.
 * headless unit tests without mocked `getBoundingClientRect`).
 */
function normalizeEventPoint(
  clientX: number,
  clientY: number,
  element: HTMLElement,
  fallbackViewport?: ViewportSize,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const width =
    rect.width > 0 ? rect.width : (fallbackViewport?.width ?? NORMALIZED_MAX);
  const height =
    rect.height > 0
      ? rect.height
      : (fallbackViewport?.height ?? NORMALIZED_MAX);
  const relX = clientX - rect.left;
  const relY = clientY - rect.top;
  return {
    x: clampCoordinate(
      Math.round((relX / Math.max(1, width)) * NORMALIZED_MAX),
      0,
      NORMALIZED_MAX,
    ),
    y: clampCoordinate(
      Math.round((relY / Math.max(1, height)) * NORMALIZED_MAX),
      0,
      NORMALIZED_MAX,
    ),
  };
}

const NON_PRINTABLE_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Process",
  "Unidentified",
]);

function pickerStatusKey(
  status: ComputerPickerStatus,
):
  | "picker.idle"
  | "picker.armed"
  | "picker.intercepted_silent"
  | "picker.pending_input"
  | "picker.awaiting_approval"
  | "picker.denied" {
  switch (status) {
    case "armed":
      return "picker.armed";
    case "intercepted_silent":
      return "picker.intercepted_silent";
    case "pending_input":
      return "picker.pending_input";
    case "awaiting_approval":
      return "picker.awaiting_approval";
    case "denied":
      return "picker.denied";
    default:
      return "picker.idle";
  }
}

export function ComputerViewport({
  frame,
  frameSrc,
  viewport,
  controller,
  cursor,
  agentName,
  picker,
  onUserInput,
  onResolvePicker,
  onReviewApproval,
  onPasteFromHost,
  title,
  className,
}: ComputerViewportProps) {
  const { t } = useTranslation(["computer", "common"] as const);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const ime = useInputMethod();

  const resolvedSrc =
    frameSrc ??
    (frame && frame.data !== ""
      ? `data:${frame.mimeType};base64,${frame.data}`
      : undefined);

  const showAgentCursor =
    cursor !== null &&
    cursor !== undefined &&
    controller !== "user" &&
    controller !== "closed";

  const clampedX =
    cursor !== null && cursor !== undefined
      ? clampCoordinate(cursor.x, 0, NORMALIZED_MAX)
      : 500;
  const clampedY =
    cursor !== null && cursor !== undefined
      ? clampCoordinate(cursor.y, 0, NORMALIZED_MAX)
      : 500;

  const leftPercent = `${clampedX / 10}%`;
  const topPercent = `${clampedY / 10}%`;
  const badgeName =
    agentName !== null && agentName !== undefined && agentName.trim() !== ""
      ? agentName.trim()
      : "ETA";
  const showPulse =
    cursor !== null && cursor !== undefined && isPulseAction(cursor.kind);

  const isTakeover = controller === "user";

  const emitPointInput = useCallback(
    (
      kind: "click" | "double_click" | "right_click" | "move",
      clientX: number,
      clientY: number,
      target: HTMLElement,
    ) => {
      if (!isTakeover || onUserInput === undefined) return;
      const { x, y } = normalizeEventPoint(clientX, clientY, target, viewport);
      onUserInput({ kind, x, y });
    },
    [isTakeover, onUserInput, viewport],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isTakeover) return;
      event.currentTarget.focus();
      emitPointInput(
        "click",
        event.clientX,
        event.clientY,
        event.currentTarget,
      );
    },
    [isTakeover, emitPointInput],
  );

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isTakeover) return;
      emitPointInput(
        "double_click",
        event.clientX,
        event.clientY,
        event.currentTarget,
      );
    },
    [isTakeover, emitPointInput],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isTakeover) return;
      event.preventDefault();
      emitPointInput(
        "right_click",
        event.clientX,
        event.clientY,
        event.currentTarget,
      );
    },
    [isTakeover, emitPointInput],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isTakeover) return;
      emitPointInput("move", event.clientX, event.clientY, event.currentTarget);
    },
    [isTakeover, emitPointInput],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!isTakeover || onUserInput === undefined) return;
      const { x, y } = normalizeEventPoint(
        event.clientX,
        event.clientY,
        event.currentTarget,
        viewport,
      );
      onUserInput({
        kind: "scroll",
        x,
        y,
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
      });
    },
    [isTakeover, onUserInput, viewport],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isTakeover || onUserInput === undefined) return;
      if (ime.owns(event.nativeEvent)) return;
      if (NON_PRINTABLE_KEYS.has(event.key)) return;

      // Explicit one-shot host clipboard paste: never implicit, preserves isolation.
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "v" &&
        onPasteFromHost !== undefined
      ) {
        event.preventDefault();
        onPasteFromHost();
        return;
      }

      // Esc blurs the takeover capture layer so keyboard focus returns to the chat.
      if (
        event.key === "Escape" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.currentTarget.blur();
        return;
      }

      const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
      if (!hasModifier && event.key.length === 1) {
        event.preventDefault();
        onUserInput({ kind: "type", text: event.key });
        return;
      }

      event.preventDefault();
      const parts: string[] = [];
      if (event.ctrlKey) parts.push("Control");
      if (event.altKey) parts.push("Alt");
      if (event.shiftKey) parts.push("Shift");
      if (event.metaKey) parts.push("Meta");
      parts.push(event.key);
      onUserInput({ kind: "key", key: parts.join("+") });
    },
    [isTakeover, onUserInput, onPasteFromHost, ime],
  );

  const handleCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLDivElement>) => {
      ime.onCompositionEnd();
      if (!isTakeover || onUserInput === undefined) return;
      if (event.data) {
        onUserInput({ kind: "type", text: event.data });
      }
    },
    [isTakeover, onUserInput, ime],
  );

  const showPickerBar =
    picker !== null && picker !== undefined && picker.status !== "idle";
  const isPaused = controller === "paused";
  // Flip the cursor badge to the left/above when near the viewport's right/bottom edge so
  // `overflow-hidden` never clips the agent name or action label.
  const flipBadgeLeft = clampedX > 720;
  const flipBadgeUp = clampedY > 840;

  return (
    <div
      data-slot="computer-viewport"
      data-controller={controller}
      style={
        viewport && viewport.width > 0 && viewport.height > 0
          ? {
              aspectRatio: `${String(viewport.width)} / ${String(viewport.height)}`,
            }
          : undefined
      }
      className={cn(
        "relative w-full overflow-hidden rounded-none border bg-background text-foreground select-none transition-colors duration-[60ms] ease-linear motion-reduce:transition-none",
        isTakeover ? "border-state-warning" : "border-border",
        className,
      )}
    >
      {/* Clean frame layer — never mutates screenshot bytes */}
      {resolvedSrc !== undefined ? (
        <img
          data-slot="computer-frame"
          src={resolvedSrc}
          alt={title ?? badgeName}
          draggable={false}
          className={cn(
            "block size-full rounded-none object-contain pointer-events-none select-none transition-opacity duration-[60ms] ease-linear motion-reduce:transition-none",
            isPaused && "opacity-75 grayscale-[30%]",
          )}
        />
      ) : (
        <div
          data-slot="computer-frame-placeholder"
          aria-label={title ?? badgeName}
          className="flex size-full min-h-48 flex-col items-center justify-center gap-1 rounded-none bg-muted/30 text-xs text-muted-foreground"
        >
          <span className="font-mono text-foreground/80">
            {title ?? "1280×800"}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {t("empty.waitingFrame")}
          </span>
        </div>
      )}

      {/* Paused overlay pill */}
      {isPaused && (
        <div
          data-slot="computer-paused-overlay"
          className="pointer-events-none absolute top-2 right-2 z-20 rounded-none border border-border bg-background/90 px-2 py-0.5 font-mono text-[10px] text-muted-foreground uppercase"
        >
          {t("hint.pausedOverlay")}
        </div>
      )}

      {/* Takeover active hint strip */}
      {isTakeover && (
        <div
          data-slot="computer-takeover-hint"
          className="pointer-events-none absolute top-1.5 left-1.5 z-20 max-w-[calc(100%-0.75rem)] truncate rounded-none border border-state-warning/60 bg-background/90 px-1.5 py-0.5 font-mono text-[10px] text-state-warning"
        >
          {t("hint.takeoverActive")}
        </div>
      )}

      {/* Interactive input capture layer — active ONLY in user takeover mode */}
      {isTakeover && (
        <div
          ref={surfaceRef}
          data-slot="computer-input-layer"
          role="application"
          aria-label={title ?? badgeName}
          tabIndex={0}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
          onPointerMove={handlePointerMove}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          className="absolute inset-0 z-10 cursor-default rounded-none outline-none focus-visible:ring-1 focus-visible:ring-state-warning"
        />
      )}

      {/* Agent Cursor overlay — pure vector pointer + square badge */}
      {showAgentCursor && cursor && (
        <div
          data-slot="computer-overlay"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 overflow-hidden select-none"
        >
          <div
            data-slot="agent-cursor"
            data-kind={cursor.kind}
            style={{ left: leftPercent, top: topPercent }}
            className="pointer-events-none absolute -translate-x-0.5 -translate-y-0.5 transition-[left,top] duration-[60ms] ease-linear motion-reduce:transition-none select-none"
          >
            {showPulse && (
              <span
                key={cursor.at}
                data-slot="agent-cursor-pulse"
                className="pointer-events-none absolute -top-2.5 -left-2.5 size-6 rounded-none border border-primary bg-primary/20 animate-ping motion-reduce:animate-none"
              />
            )}
            <svg
              data-slot="agent-cursor-arrow"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              className="block overflow-visible"
            >
              <path
                d="M1 1L6.2 14.2L8.7 8.9L14 6.4L1 1Z"
                fill="var(--primary)"
                stroke="var(--background)"
                strokeWidth="1.25"
                strokeLinejoin="miter"
              />
            </svg>
            <div
              data-slot="agent-cursor-badge"
              data-flip-left={flipBadgeLeft ? "true" : "false"}
              data-flip-up={flipBadgeUp ? "true" : "false"}
              className={cn(
                "inline-flex items-center gap-1 rounded-none border border-border bg-primary px-1.5 py-0.5 text-[10px] leading-none font-medium text-primary-foreground whitespace-nowrap",
                flipBadgeLeft ? "-translate-x-full -ml-1" : "ml-3",
                flipBadgeUp ? "-mt-7" : "mt-0.5",
              )}
            >
              <span>{badgeName}</span>
              {cursor.label && (
                <span
                  data-slot="agent-cursor-label"
                  className="text-primary-foreground/80"
                >
                  {cursor.label}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Single-line compact silent file picker bar */}
      {showPickerBar && picker && (
        <div
          data-slot="computer-picker-bar"
          data-status={picker.status}
          className="absolute inset-x-0 bottom-0 z-30 flex h-7 items-center justify-between gap-2 rounded-none border-t border-border bg-background/95 px-2.5 text-xs text-foreground"
        >
          <div className="flex min-w-0 items-center gap-2 truncate">
            <span
              data-slot="computer-picker-status"
              title={picker.status}
              className="shrink-0 rounded-none border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              <span>{t(pickerStatusKey(picker.status))}</span>
              <span className="sr-only"> ({picker.status})</span>
            </span>
            <span
              data-slot="computer-picker-files"
              className="truncate font-mono text-xs"
            >
              {picker.files.length > 0
                ? picker.files.join(", ")
                : (picker.title ?? picker.reason ?? "")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {picker.status === "awaiting_approval" &&
              onReviewApproval !== undefined && (
                <button
                  type="button"
                  data-slot="computer-picker-review"
                  onClick={onReviewApproval}
                  className="shrink-0 rounded-none border border-state-warning bg-background px-2 py-0.5 text-xs font-medium text-state-warning transition-colors duration-[60ms] ease-linear motion-reduce:transition-none hover:bg-muted"
                >
                  {t("action.reviewApproval")}
                </button>
              )}
            {(picker.status === "pending_input" ||
              picker.status === "awaiting_approval") &&
              onResolvePicker !== undefined &&
              picker.files.length > 0 && (
                <button
                  type="button"
                  data-slot="computer-picker-action"
                  onClick={() => onResolvePicker(picker.files)}
                  className="shrink-0 rounded-none border border-border bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground transition-colors duration-[60ms] ease-linear motion-reduce:transition-none hover:bg-primary/80"
                >
                  {t("action.selectFile")}
                </button>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
