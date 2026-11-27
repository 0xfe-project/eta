import process from "process";
import { platform } from "nsh";

const linuxUpdateArchivePattern = /\/Eta-[^/]+-linux-[^/]+\.tar\.gz$/;

/**
 * Returns whether the client app is running inside a Linux Flatpak sandbox.
 */
export function isFlatpakRuntime(
  os: string,
  env?: Record<string, string | undefined>,
  bundleUrl?: string,
): boolean {
  if (os !== "linux") return false;
  if (env?.FLATPAK_ID?.trim()) return true;
  return Boolean(bundleUrl && bundleUrl.startsWith("file:///app/"));
}

/** Whether this client process is running inside the Linux Flatpak sandbox. */
export const isFlatpak: boolean = isFlatpakRuntime(
  platform.os,
  typeof process !== "undefined" ? process.env : undefined,
  import.meta.url,
);

/**
 * Maps a Linux desktop update archive URL (`Eta-<version>-linux-<arch>.tar.gz`)
 * to the sibling single-file Flatpak bundle (`eta-desktop-linux-x64.flatpak`).
 */
export function flatpakBundleUrl(updateUrl: string): string {
  try {
    const url = new URL(updateUrl);
    if (!linuxUpdateArchivePattern.test(url.pathname)) return updateUrl;
    url.pathname = url.pathname.replace(
      linuxUpdateArchivePattern,
      "/eta-desktop-linux-x64.flatpak",
    );
    return url.href;
  } catch {
    return updateUrl;
  }
}
