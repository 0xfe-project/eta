import { platform } from "nsh";

/** The packaged host launcher as a path the OS can execute. */
export function packagedHostBootstrap(): string | undefined {
  return launcherPath(import.meta.url, platform.os);
}

/** Exported for the test: the rule without the bundle URL. */
export function launcherPath(
  bundleUrl: string,
  os: string,
): string | undefined {
  // `scripts/nsh-client.ts` builds the launcher into `nsh\` on macOS and Linux
  // and into the app root on Windows, while the bundle always sits in `nsh\`.
  const name = os === "windows" ? "../eta-bootstrap.exe" : "eta-bootstrap";
  const launcher = new URL(name, bundleUrl);
  if (launcher.protocol !== "file:") return undefined;
  const path = decodeURIComponent(launcher.pathname);
  // NSH keeps file URLs as URL paths on Windows, including the leading slash
  // (`/E:/...`). Windows executable paths do not.
  return os === "windows"
    ? path.replace(/^\/([A-Z]:)/i, "$1").replaceAll("/", "\\")
    : path;
}
