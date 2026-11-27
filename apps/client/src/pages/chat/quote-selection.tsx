import type { MessageView } from "@eta/client-contracts";
import type { Bounds, ViewRef } from "nsh";
import type { TextSelection } from "../../components/eta-editor";
import { Overlay, signal } from "nsh";
import { Button, colors } from "../../components";
import { control, shadow, space } from "../../components/tokens";
import { uiText } from "../../i18n";

interface QuotedSelection {
  message: MessageView;
  /** The selected text as the reply reads (mentions as `@Ada`). */
  read: () => string;
  at: Bounds | ViewRef;
}

interface QuoteSelectionController {
  current: () => QuotedSelection | undefined;
  select: (
    message: MessageView,
    event: TextSelection,
    reply: ViewRef | undefined,
  ) => void;
  pressStart: () => void;
  pressEnd: () => void;
  quote: () => void;
  dismiss: () => void;
  dispose: () => void;
}

/**
 * Coordinates the floating Quote overlay button against browser selection-clearing on pointer-down:
 * pressing down on the Quote button defers dismissing an empty selection change for that message
 * until release, while aborted drags, scrolls, and clicks elsewhere dismiss it cleanly.
 */
export function createQuoteSelection(options: {
  phone: () => boolean;
  onQuote: (conversationId: string, text: string) => void;
}): QuoteSelectionController {
  const selection = signal<QuotedSelection | undefined>(undefined);
  let pressing = false;
  let clearedDuringPress = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelRelease() {
    if (releaseTimer === undefined) return;
    clearTimeout(releaseTimer);
    releaseTimer = undefined;
  }

  function resetPress() {
    cancelRelease();
    pressing = false;
    clearedDuringPress = false;
  }

  function select(
    message: MessageView,
    event: TextSelection,
    reply: ViewRef | undefined,
  ) {
    const text = event.text.trim();
    // Where the platform gives no box around the selection (the web), the
    // button goes over the reply instead. A phone has its own edit menu.
    const at = event.pageBounds ?? reply;
    if (text && at && !options.phone()) {
      resetPress();
      selection.set({ message, read: event.read, at });
      return;
    }
    if (selection()?.message.id !== message.id) return;
    if (pressing) {
      clearedDuringPress = true;
      return;
    }
    resetPress();
    selection.set(undefined);
  }

  function pressStart() {
    cancelRelease();
    // Idempotent across capture-phase touch start and press-down so a second
    // start signal does not wipe a selection clear already observed.
    if (pressing) return;
    pressing = true;
    clearedDuringPress = false;
  }

  function pressEnd() {
    if (!pressing) return;
    cancelRelease();
    // Defer clearing past the synchronous `onPress` dispatch that follows
    // `onPressUp` / `onTouchEndCapture`, so aborted clicks still clean up.
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined;
      const shouldClear = clearedDuringPress;
      pressing = false;
      clearedDuringPress = false;
      if (shouldClear) selection.set(undefined);
    }, 0);
  }

  function quote() {
    const current = selection();
    resetPress();
    if (!current) return;
    selection.set(undefined);
    const text = current.read().trim();
    if (text) options.onQuote(current.message.conversationId, text);
  }

  function dismiss() {
    resetPress();
    if (selection()) selection.set(undefined);
  }

  return {
    current: () => selection(),
    select,
    pressStart,
    pressEnd,
    quote,
    dismiss,
    dispose: resetPress,
  };
}

/** Floating Quote action anchored to the currently selected reply text. */
export function QuoteSelectionOverlay(props: {
  controller: QuoteSelectionController;
}) {
  const c = colors();
  return (
    <If when={props.controller.current()}>
      {(current) => (
        <Overlay
          anchor={current().at}
          placement="top"
          align={"origin" in current().at ? "center" : "end"}
          offset={6}
          onTouchStartCapture={props.controller.pressStart}
          onTouchEndCapture={props.controller.pressEnd}
          onTouchCancelCapture={props.controller.pressEnd}
        >
          <Button
            label={uiText("quoteSelection")}
            icon="return"
            size={control.md}
            style={{
              paddingHorizontal: space[12],
              gap: space[4],
              backgroundColor: c().canvas,
              borderWidth: 1,
              borderColor: c().border,
              boxShadow: [shadow.float],
            }}
            onPressDown={props.controller.pressStart}
            onPressUp={props.controller.pressEnd}
            onPress={props.controller.quote}
          />
        </Overlay>
      )}
    </If>
  );
}
