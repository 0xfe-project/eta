/**
 * ⌘, (Ctrl+, where there is no ⌘) — the way into settings that works from anywhere.
 *
 * macOS puts settings behind that chord in every app, and the desktop shell's menu says as much:
 * `⌘,` is the one chord a page can answer without the shell having to say anything. So the root of
 * the app listens once and every route — the conversation, the board, the inbox, the settings page
 * itself — answers the same way.
 *
 * One listener on `window`, not a shortcut system. There is no second chord yet, and a registry
 * holding one binding would only be a registry; the Escape listeners already on `window` (the
 * phone's panel drawer, the sidebar) are the same shape.
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useWorkspaceStore } from "@/components/workspace/workspace-store";

/** What one keypress is going to do, and how it learned that. */
type SettingsIntent = "dialog" | "page" | "ignore";

/** The phone's width: below this breakpoint the product has no dialogs, only pages. */
const phoneWidth = () =>
  typeof matchMedia === "function"
    ? matchMedia("(max-width: 767.98px)").matches
    : false;

/**
 * What the chord means, given the keypress, the machine, and what is already on screen.
 *
 * A command is meant even from inside a field — ⌘, types no comma anywhere — so focus never
 * vetoes it. An input method does: while it is composing, that ⌘ was the user picking a candidate,
 * not asking for settings.
 */
export function settingsIntent(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "metaKey"
    | "ctrlKey"
    | "altKey"
    | "shiftKey"
    | "repeat"
    | "isComposing"
  >,
  platform: string,
  /** Another layer over the page: an agent's editor, a half-filled new conversation. */
  occupied: boolean,
  onPhone: boolean,
): SettingsIntent {
  if (
    event.key !== "," ||
    event.altKey ||
    event.shiftKey ||
    event.repeat ||
    event.isComposing
  )
    return "ignore";
  // The key ⌘ goes with: ⌘ on a Mac, Ctrl everywhere else. ⌘⇧, is nobody's shortcut, and saying so
  // here keeps a future one from opening settings by accident.
  if (!(platform.startsWith("Mac") ? event.metaKey : event.ctrlKey))
    return "ignore";
  // Something already over the page keeps the keyboard: two dialogs stacked and fighting over
  // focus is worse than a chord that did nothing. On a phone nothing stacks — the settings page
  // replaces what was there — so the chord still answers.
  if (occupied && !onPhone) return "ignore";
  return onPhone ? "page" : "dialog";
}

/** Another layer that owns the screen right now. */
function dialogOccupied(): boolean {
  const { agentEditor, newConversation } = useWorkspaceStore.getState();
  return agentEditor.open || newConversation.open;
}

/**
 * Put settings in front of what is on screen.
 *
 * On a phone, a layer covering the whole screen is a page with a shadow and there is no way back
 * out of it the browser knows about, so the chord goes to `/settings` and closes whatever dialog
 * was open behind it: back then leaves settings onto the screen the chord was pressed on.
 */
function applySettingsIntent(
  intent: SettingsIntent,
  toSettingsPage?: () => void,
): void {
  if (intent === "ignore") return;
  const { setSettings, setAgentEditor, setNewConversation } =
    useWorkspaceStore.getState();
  if (intent === "dialog")
    return setSettings((state) => ({ ...state, open: true }));
  setAgentEditor((state) => ({ ...state, open: false }));
  setNewConversation({ open: false });
  toSettingsPage?.();
}

/**
 * Watch for the chord for as long as this window is open. Returns the way to stop, because a
 * listener on `window` outlives whatever asked for it. `toSettingsPage` is how the phone gets
 * there, which only the router knows.
 */
function watchSettingsShortcut(toSettingsPage?: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const onPhone = phoneWidth();
    const intent = settingsIntent(
      event,
      navigator.platform ?? "",
      dialogOccupied(),
      onPhone,
    );
    if (intent === "ignore") return;
    event.preventDefault();
    applySettingsIntent(intent, toSettingsPage);
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

/**
 * Call it once, at the root of the app, so no page can mount it twice or be left out of it. It
 * renders nothing: what it does is put the listener on `window`, which is where a chord that means
 * "everywhere" belongs.
 */
export function useSettingsShortcut(): void {
  const navigate = useNavigate();
  useEffect(
    () =>
      watchSettingsShortcut(
        () => void navigate({ to: "/settings", search: {} }),
      ),
    [navigate],
  );
}
