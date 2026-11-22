import { platform } from "nsh";

/** The app runs as the native Windows desktop app. In a browser (`os` is
 * `"web"`), even on Windows, the browser already scrolls the wheel smoothly,
 * so only the desktop app takes the wheel over. */
export const onWindows = platform.os === "windows";
