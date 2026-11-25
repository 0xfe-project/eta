import type { Page } from "../navigation/routes";
import type { SettingsSection } from "../pages/settings/overview";

/**
 * What the Android system back key does next, decided from what is open on top of what. The
 * handler in the workspace only carries the action out, so the order of the layers can be read
 * and tested without a running app.
 */
export type BackAction =
  | { kind: "dismiss-overlay" }
  | { kind: "close-settings"; section: SettingsSection }
  | { kind: "close-task" }
  | { kind: "back-to-list" }
  | { kind: "leave-onboarding" }
  | { kind: "exit-app" };

/** What is open, innermost first, as the back key sees it. */
export interface BackState {
  /** The top of the dismissable stack: a modal, sheet, popover, menu or select. */
  overlay: "absent" | "dismissable" | "blocked";
  /** The Settings section on screen, if Settings is open over everything. */
  settings: SettingsSection | undefined;
  /** A task pushed over the page it opened from. */
  task: boolean;
  /** The phone layout, where the conversation covers the chat list. */
  phone: boolean;
  page: Page;
  /** The conversation is showing over the chat list. */
  conversation: boolean;
  /** Onboarding is up. */
  onboarding: boolean;
}

/**
 * The layers close innermost first: a dismissable overlay, Settings, a task pushed over its page,
 * the conversation over the chat list, onboarding, and only then the app itself. An overlay that
 * is present but refuses to close does not swallow the press: the layers under it close as they
 * did before, which is what the Escape stack did too.
 */
export function backAction(state: BackState): BackAction {
  if (state.overlay === "dismissable") return { kind: "dismiss-overlay" };
  if (state.settings !== undefined)
    return { kind: "close-settings", section: state.settings };
  if (state.task) return { kind: "close-task" };
  if (state.phone && state.page === "chat" && state.conversation)
    return { kind: "back-to-list" };
  if (state.onboarding) return { kind: "leave-onboarding" };
  return { kind: "exit-app" };
}
