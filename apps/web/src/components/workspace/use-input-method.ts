import { useRef } from "react";

/**
 * Is this key the input method finishing a word rather than the person sending or picking?
 *
 * Three engines, three orders, all three answered (eta-old measured this in a real browser, not
 * from the spec): Chrome flags the key with `isComposing`; WebKit says nothing but the legacy
 * `keyCode: 229`; macOS Pinyin typed as ASCII commits on Enter and closes the composition *before*
 * delivering the key, so the keydown looks completely ordinary. The window after `compositionend`
 * covers that third case — long enough to swallow the Enter that committed the text, short enough
 * not to eat a deliberate second press.
 *
 * The chat's composer and a task's comment box both complete from a menu on Enter, so both ask
 * this one question; the composition handlers go on the same element as the keydown.
 */
export function useInputMethod() {
  // Composition state the keydown handler needs but the DOM only reports to other listeners.
  const compositionRef = useRef({ composing: false, endedAt: 0 });
  return {
    onCompositionStart: () => {
      compositionRef.current.composing = true;
    },
    onCompositionEnd: () => {
      compositionRef.current.composing = false;
      compositionRef.current.endedAt = performance.now();
    },
    owns: (event: KeyboardEvent) =>
      event.isComposing ||
      event.keyCode === 229 ||
      compositionRef.current.composing ||
      performance.now() - compositionRef.current.endedAt < 120,
  };
}
