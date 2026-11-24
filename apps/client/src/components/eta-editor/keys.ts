import { platform } from "nsh";

/** The modifier of ⌘⏎ as this platform names it. */
export const modKey =
  platform.os === "macos" || platform.os === "ios" ? "⌘" : "Ctrl+";

/** ⌘⏎ as a hint beside what it does (a form's button). */
export const sendShortcut = `${modKey}⏎`;
