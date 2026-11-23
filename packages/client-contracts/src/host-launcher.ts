/**
 * The commands an NSH desktop app may start, and where its package keeps the
 * launcher that finds or downloads the host.
 *
 * NSH puts the app bundle under `nsh/` on every desktop. macOS and Linux keep
 * the launcher beside that bundle; Windows keeps it at the package root, one
 * level above `nsh/`. The packaging script and the running app share these
 * paths so the two cannot disagree about the layout.
 */

export type DesktopHostPlatform = "linux" | "macos" | "windows";

/** Exact commands granted by `capabilities.process.execute` in `nsh.json`. */
export const desktopHostProcessGrants = [
  "eta-host",
  "eta-host.exe",
  "env",
  "cmd.exe",
] as const;

export interface DesktopHostCommand {
  command: string;
  args: string[];
}

const launcherNames: Record<DesktopHostPlatform, string> = {
  linux: "eta-bootstrap",
  macos: "eta-bootstrap",
  windows: "eta-bootstrap.exe",
};

const launcherPaths: Record<DesktopHostPlatform, string> = {
  linux: "./eta-bootstrap",
  macos: "./eta-bootstrap",
  windows: "../eta-bootstrap.exe",
};

export function desktopHostLauncherName(platform: DesktopHostPlatform): string {
  return launcherNames[platform];
}

export function desktopHostLauncherURL(
  platform: DesktopHostPlatform,
  bundleURL: string | URL,
): URL {
  return new URL(launcherPaths[platform], bundleURL);
}

/**
 * The launcher as an operating-system path, or `undefined` outside a packaged
 * desktop app. `URL.pathname` is not a path: Windows file URLs begin `/E:/`,
 * and encoded spaces stay `%20` until decoded.
 */
export function desktopHostLauncherPath(
  platform: string,
  bundleURL: string | URL,
): string | undefined {
  if (!isDesktopHostPlatform(platform)) return undefined;
  return fileURLToPath(desktopHostLauncherURL(platform, bundleURL), platform);
}

/**
 * NSH grants an exact command string, not the basename of an absolute path.
 * A packaged app's path is not known when its manifest is built, so the
 * launcher needs the platform's fixed environment trampoline: `env` on Unix
 * and `cmd.exe /d /c call` on Windows. The launcher comes from the package
 * layout and the version from its metadata, rather than from app input.
 */
export function desktopHostLauncherCommand(
  platform: string,
  launcher: string,
  version: string,
): DesktopHostCommand | undefined {
  if (platform === "windows")
    return {
      command: "cmd.exe",
      args: ["/d", "/c", "call", launcher, version],
    };
  if (platform === "linux" || platform === "macos")
    return { command: "env", args: [launcher, version] };
  return undefined;
}

/**
 * A launcher that cannot be started is different from one that started and
 * failed: the first falls back to an installed host. `env` uses 127 for a
 * missing program; `cmd.exe` uses 1 when the command it calls cannot start.
 * The launcher reports real start failures as JSON before it exits.
 */
export function bootstrapExitKind(
  platform: string,
  code: number | null | undefined,
): "missing" | "start" {
  if (code === 127 || (platform === "windows" && code === 1)) return "missing";
  return "start";
}

export function fileURLToPath(
  url: URL,
  platform: DesktopHostPlatform,
): string | undefined {
  if (url.protocol !== "file:") return undefined;
  const path = decodeURIComponent(url.pathname);
  if (platform === "windows") {
    const share = url.hostname ? `\\\\${url.hostname}` : "";
    return `${share}${path.replace(/^\/([a-z]:)/i, "$1").replaceAll("/", "\\")}`;
  }
  return url.hostname ? `//${url.hostname}${path}` : path;
}

function isDesktopHostPlatform(
  platform: string,
): platform is DesktopHostPlatform {
  return platform === "linux" || platform === "macos" || platform === "windows";
}
