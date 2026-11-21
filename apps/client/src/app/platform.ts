import { platform } from "nsh";

/** What a browser says about the system it runs on. */
interface BrowserNavigator {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
}

/** Whether the app runs on Windows: NSH's own `platform.os` in a native app,
 * and in a browser (`os` is `"web"`) what the browser reports, from
 * `navigator.userAgentData.platform` ("Windows"), else `navigator.platform`
 * ("Win32"), else the user agent ("Windows NT 10.0"). */
export function isWindows(os: string, navigator?: BrowserNavigator) {
  if (os !== "web") return os === "windows";
  const reported =
    navigator?.userAgentData?.platform ||
    navigator?.platform ||
    navigator?.userAgent ||
    "";
  // "Win32", "Windows" and "Windows NT", never "Darwin".
  return /\bwin/i.test(reported);
}

/** The app runs on Windows, natively or in a browser there. */
export const onWindows = isWindows(
  platform.os,
  (globalThis as { navigator?: BrowserNavigator }).navigator,
);
